// @effect-diagnostics nodeBuiltinImport:off

import { assert, describe, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  baseHistoryPushArgs,
  rebaseOpenFeaturePullRequests,
  RebaseConflictError,
  resumeStack,
  selectOpenFeaturePullRequests,
  StackError,
  syncStack,
  type PullRequestSnapshot,
  type StackManifest,
  validatePullRequestSnapshots,
} from "./rebase-pr-stack.ts";

describe("baseHistoryPushArgs", () => {
  it("force-updates the blob ref while leasing its observed remote value", () => {
    assert.deepEqual(baseHistoryPushArgs("abc123"), [
      "push",
      "--force-with-lease=refs/t3/stack/base-history/fork-changes:abc123",
      "origin",
      "refs/t3/stack/base-history/fork-changes:refs/t3/stack/base-history/fork-changes",
    ]);
  });

  it("leases non-existence when the remote history ref is absent", () => {
    assert.include(
      baseHistoryPushArgs(""),
      "--force-with-lease=refs/t3/stack/base-history/fork-changes:",
    );
  });
});

describe("selectOpenFeaturePullRequests", () => {
  const manifest: StackManifest = {
    upstreamRemote: "upstream",
    upstreamBranch: "main",
    forkChangesBranch: "fork/changes",
    integrationBranch: "fork/integration",
    pullRequests: [
      { number: 1, branch: "fork/tim" },
      { number: 2, branch: "fork/changes" },
    ],
    integrationOverlays: [
      { number: 10, branch: "overlay/desktop" },
      { number: 80, branch: "overlay/discord" },
    ],
  };

  it("puts registered integration overlays first in manifest order", () => {
    const selected = selectOpenFeaturePullRequests({
      expectedRepository: "patroza/t3code",
      manifest,
      openPulls: [
        {
          number: 96,
          headBranch: "feat/recent-project-filter",
          baseBranch: "fork/changes",
          headRepository: "patroza/t3code",
        },
        {
          number: 80,
          headBranch: "overlay/discord",
          baseBranch: "fork/changes",
          headRepository: "patroza/t3code",
        },
        {
          number: 10,
          headBranch: "overlay/desktop",
          baseBranch: "fork/changes",
          headRepository: "patroza/t3code",
        },
      ],
    });
    assert.deepEqual(
      selected.map(({ branch }) => branch),
      ["overlay/desktop", "overlay/discord", "feat/recent-project-filter"],
    );
  });

  it("excludes managed stack provenance branches", () => {
    const selected = selectOpenFeaturePullRequests({
      expectedRepository: "patroza/t3code",
      manifest,
      openPulls: [
        {
          number: 2,
          headBranch: "fork/changes",
          baseBranch: "main",
          headRepository: "patroza/t3code",
        },
        {
          number: 10,
          headBranch: "overlay/desktop",
          baseBranch: "fork/changes",
          headRepository: "patroza/t3code",
        },
      ],
    });
    assert.deepEqual(
      selected.map(({ branch }) => branch),
      ["overlay/desktop"],
    );
  });
});

interface Fixture {
  readonly root: string;
  readonly work: string;
  readonly origin: string;
  readonly upstream: string;
  readonly manifest: StackManifest;
}

interface FixtureOptions {
  readonly conflict?: boolean;
  readonly extraCommitOnPr5?: boolean;
  readonly updatePr5AfterDescendant?: boolean;
  readonly landedPr4Upstream?: boolean;
  readonly divergedMain?: boolean;
  readonly emptyIntegration?: boolean;
  readonly unchangedUpstream?: boolean;
  readonly insertMiddleLayer?: boolean;
  readonly advanceTopAfterIntegration?: boolean;
}

function runGit(
  cwd: string,
  args: ReadonlyArray<string>,
  options: { readonly allowFailure?: boolean } = {},
): string {
  const result = NodeChildProcess.spawnSync("git", [...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Stack Test",
      GIT_AUTHOR_EMAIL: "stack-test@example.com",
      GIT_COMMITTER_NAME: "Stack Test",
      GIT_COMMITTER_EMAIL: "stack-test@example.com",
    },
  });
  if (!options.allowFailure && result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function write(path: string, contents: string): void {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFS.writeFileSync(path, contents, "utf8");
}

function commitFile(work: string, path: string, contents: string, subject: string): string {
  write(NodePath.join(work, path), contents);
  runGit(work, ["add", path]);
  runGit(work, ["commit", "--quiet", "-m", subject]);
  return runGit(work, ["rev-parse", "HEAD"]);
}

function remoteTip(remote: string, branch: string): string {
  return runGit(remote, ["rev-parse", `refs/heads/${branch}`]);
}

function remoteTips(fixture: Fixture): Record<string, string> {
  return Object.fromEntries(
    [
      fixture.manifest.upstreamBranch,
      ...fixture.manifest.pullRequests.map(({ branch }) => branch),
      fixture.manifest.integrationBranch,
    ].map((branch) => [branch, remoteTip(fixture.origin, branch)]),
  );
}

function isAncestor(repository: string, parent: string, child: string): boolean {
  const result = NodeChildProcess.spawnSync("git", ["merge-base", "--is-ancestor", parent, child], {
    cwd: repository,
    encoding: "utf8",
  });
  return result.status === 0;
}

async function captureFailure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("Expected the promise to reject.");
}

function createFixture(options: FixtureOptions = {}): Fixture {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pr-stack-test-"));
  const work = NodePath.join(root, "work");
  const origin = NodePath.join(root, "origin.git");
  const upstream = NodePath.join(root, "upstream.git");
  NodeFS.mkdirSync(work);
  runGit(root, ["init", "--bare", "--quiet", origin]);
  runGit(root, ["init", "--bare", "--quiet", upstream]);
  runGit(work, ["init", "--quiet", "--initial-branch=main"]);
  runGit(work, ["config", "user.name", "Stack Test"]);
  runGit(work, ["config", "user.email", "stack-test@example.com"]);
  runGit(work, ["config", "commit.gpgsign", "false"]);
  runGit(work, ["remote", "add", "origin", origin]);
  runGit(work, ["remote", "add", "upstream", upstream]);
  commitFile(work, "shared.txt", "base\n", "base");
  runGit(work, ["push", "--quiet", "origin", "main"]);
  runGit(work, ["push", "--quiet", "upstream", "main"]);

  const manifest: StackManifest = {
    upstreamRemote: "upstream",
    upstreamBranch: "main",
    forkChangesBranch: "feature/pr-6",
    integrationBranch: "fork/integration",
    pullRequests: [
      { number: 4, branch: "feature/pr-4" },
      ...(options.insertMiddleLayer ? [{ number: 45, branch: "feature/upstream-candidates" }] : []),
      { number: 5, branch: "feature/pr-5" },
      { number: 6, branch: "feature/pr-6" },
    ],
    integrationOverlays: [],
  };
  write(
    NodePath.join(work, ".github", "pr-stack.json"),
    `${JSON.stringify(manifest, undefined, 2)}\n`,
  );

  runGit(work, ["checkout", "--quiet", "-b", "feature/pr-4", "main"]);
  const pr4Tip = options.conflict
    ? commitFile(work, "shared.txt", "from pr 4\n", "pr 4 conflicts")
    : commitFile(work, "pr-4.txt", "four\n", "pr 4");
  runGit(work, ["push", "--quiet", "origin", "feature/pr-4"]);

  if (options.insertMiddleLayer) {
    runGit(work, ["checkout", "--quiet", "-b", "feature/upstream-candidates"]);
    commitFile(work, "candidate.txt", "candidate\n", "upstream candidate");
    runGit(work, ["push", "--quiet", "origin", "feature/upstream-candidates"]);
    runGit(work, ["checkout", "--quiet", "feature/pr-4"]);
  }

  runGit(work, ["checkout", "--quiet", "-b", "feature/pr-5"]);
  commitFile(work, "pr-5.txt", "five\n", "pr 5");
  if (options.extraCommitOnPr5) {
    commitFile(work, "pr-5-extra.txt", "new before sync\n", "new pr 5 commit");
  }
  runGit(work, ["push", "--quiet", "origin", "feature/pr-5"]);

  runGit(work, ["checkout", "--quiet", "-b", "feature/pr-6"]);
  commitFile(work, "pr-6.txt", "six\n", "pr 6");
  runGit(work, ["push", "--quiet", "origin", "feature/pr-6"]);

  runGit(work, ["checkout", "--quiet", "-b", "fork/integration"]);
  if (!options.emptyIntegration) {
    commitFile(work, "automation.txt", "automation\n", "stack automation");
  }
  runGit(work, ["push", "--quiet", "origin", "fork/integration"]);

  if (options.advanceTopAfterIntegration) {
    runGit(work, ["checkout", "--quiet", "feature/pr-6"]);
    commitFile(work, "pr-6-late.txt", "merged after integration\n", "advance fork changes");
    runGit(work, ["push", "--quiet", "origin", "feature/pr-6"]);
  }

  if (options.updatePr5AfterDescendant) {
    runGit(work, ["checkout", "--quiet", "feature/pr-5"]);
    commitFile(work, "pr-5-late.txt", "updated after pr 6\n", "late pr 5 update");
    runGit(work, ["push", "--quiet", "origin", "feature/pr-5"]);
  }

  if (options.unchangedUpstream) {
    // Keep upstream at the stack's original base.
  } else if (options.landedPr4Upstream) {
    runGit(work, ["checkout", "--quiet", "main"]);
    runGit(work, ["cherry-pick", "--quiet", pr4Tip]);
    runGit(work, ["push", "--quiet", "upstream", "main"]);
  } else {
    runGit(work, ["checkout", "--quiet", "main"]);
    if (options.conflict) {
      commitFile(work, "shared.txt", "from upstream\n", "upstream conflicts");
    } else {
      commitFile(work, "upstream.txt", "upstream\n", "upstream advances");
    }
    runGit(work, ["push", "--quiet", "upstream", "main"]);
  }

  if (options.divergedMain) {
    runGit(work, ["checkout", "--quiet", "main"]);
    commitFile(work, "origin-only.txt", "origin divergence\n", "origin diverges");
    runGit(work, ["push", "--quiet", "origin", "main"]);
  }

  return { root, work, origin, upstream, manifest };
}

describe("rebase-pr-stack", () => {
  it("creates a clean linear cascade with no merge commits", async () => {
    const fixture = createFixture();
    await syncStack({
      sourceRoot: fixture.work,
      push: true,
      validatePullRequests: false,
    });

    let parent = remoteTip(fixture.upstream, "main");
    for (const { branch } of fixture.manifest.pullRequests) {
      const child = remoteTip(fixture.origin, branch);
      assert.ok(isAncestor(fixture.origin, parent, child));
      assert.equal(
        runGit(fixture.origin, ["rev-list", "--count", "--merges", `${parent}..${child}`]),
        "0",
      );
      parent = child;
    }
    assert.ok(
      isAncestor(
        fixture.origin,
        parent,
        remoteTip(fixture.origin, fixture.manifest.integrationBranch),
      ),
    );
    assert.equal(remoteTip(fixture.origin, "main"), remoteTip(fixture.upstream, "main"));
  });

  it("inserts a new middle layer before a child that does not contain it yet", async () => {
    const fixture = createFixture({ insertMiddleLayer: true });
    await syncStack({
      sourceRoot: fixture.work,
      push: true,
      validatePullRequests: false,
    });

    const candidate = remoteTip(fixture.origin, "feature/upstream-candidates");
    const pr5 = remoteTip(fixture.origin, "feature/pr-5");
    const pr6 = remoteTip(fixture.origin, "feature/pr-6");
    assert.ok(isAncestor(fixture.origin, candidate, pr5));
    assert.ok(isAncestor(fixture.origin, pr5, pr6));
    assert.deepStrictEqual(
      runGit(fixture.origin, ["log", "--reverse", "--format=%s", `${candidate}..${pr5}`]).split(
        "\n",
      ),
      ["pr 5"],
    );
  });

  it("moves an integration branch with no unique commits to the rewritten stack tip", async () => {
    const fixture = createFixture({ emptyIntegration: true });
    await syncStack({
      sourceRoot: fixture.work,
      push: true,
      validatePullRequests: false,
    });

    assert.equal(
      remoteTip(fixture.origin, fixture.manifest.integrationBranch),
      remoteTip(fixture.origin, fixture.manifest.pullRequests.at(-1)!.branch),
    );
  });

  it("preserves exact layer tips when upstream has not changed", async () => {
    const fixture = createFixture({ emptyIntegration: true, unchangedUpstream: true });
    const before = remoteTips(fixture);
    await syncStack({
      sourceRoot: fixture.work,
      push: true,
      validatePullRequests: false,
    });

    for (const { branch } of fixture.manifest.pullRequests) {
      assert.equal(remoteTip(fixture.origin, branch), before[branch]);
    }
    assert.equal(
      remoteTip(fixture.origin, fixture.manifest.integrationBranch),
      before[fixture.manifest.pullRequests.at(-1)!.branch],
    );
  });

  it("replays only each PR's unique commits onto its rewritten parent", async () => {
    const fixture = createFixture();
    await syncStack({
      sourceRoot: fixture.work,
      push: true,
      validatePullRequests: false,
    });

    const pr4 = remoteTip(fixture.origin, "feature/pr-4");
    const pr5 = remoteTip(fixture.origin, "feature/pr-5");
    const pr6 = remoteTip(fixture.origin, "feature/pr-6");
    assert.deepStrictEqual(
      runGit(fixture.origin, ["log", "--format=%s", `${pr4}..${pr5}`]).split("\n"),
      ["pr 5"],
    );
    assert.deepStrictEqual(
      runGit(fixture.origin, ["log", "--format=%s", `${pr5}..${pr6}`]).split("\n"),
      ["pr 6"],
    );
  });

  it("retains commits added to a PR before the run", async () => {
    const fixture = createFixture({ extraCommitOnPr5: true });
    await syncStack({
      sourceRoot: fixture.work,
      push: true,
      validatePullRequests: false,
    });

    const pr4 = remoteTip(fixture.origin, "feature/pr-4");
    const pr5 = remoteTip(fixture.origin, "feature/pr-5");
    assert.deepStrictEqual(
      runGit(fixture.origin, ["log", "--reverse", "--format=%s", `${pr4}..${pr5}`]).split("\n"),
      ["pr 5", "new pr 5 commit"],
    );
  });

  it("restacks descendants after an earlier PR is updated", async () => {
    const fixture = createFixture({ updatePr5AfterDescendant: true });
    const oldPr6 = remoteTip(fixture.origin, "feature/pr-6");
    assert.ok(!isAncestor(fixture.origin, remoteTip(fixture.origin, "feature/pr-5"), oldPr6));

    await syncStack({
      sourceRoot: fixture.work,
      push: true,
      validatePullRequests: false,
    });

    const pr5 = remoteTip(fixture.origin, "feature/pr-5");
    const pr6 = remoteTip(fixture.origin, "feature/pr-6");
    assert.ok(isAncestor(fixture.origin, pr5, pr6));
    assert.deepStrictEqual(
      runGit(fixture.origin, ["log", "--reverse", "--format=%s", `${pr5}..${pr6}`]).split("\n"),
      ["pr 6"],
    );
  });

  it("rebases integration from its actual base after fork changes advances", async () => {
    const fixture = createFixture({ advanceTopAfterIntegration: true });

    await syncStack({
      sourceRoot: fixture.work,
      push: true,
      validatePullRequests: false,
    });

    const forkChanges = remoteTip(fixture.origin, fixture.manifest.forkChangesBranch);
    const integration = remoteTip(fixture.origin, fixture.manifest.integrationBranch);
    assert.ok(isAncestor(fixture.origin, forkChanges, integration));
    assert.deepStrictEqual(
      runGit(fixture.origin, [
        "log",
        "--reverse",
        "--format=%s",
        `${forkChanges}..${integration}`,
      ]).split("\n"),
      ["stack automation"],
    );
  });

  it("leaves every remote ref unchanged when a rebase conflicts", async () => {
    const fixture = createFixture({ conflict: true });
    const before = remoteTips(fixture);
    const error = await captureFailure(
      syncStack({
        sourceRoot: fixture.work,
        push: true,
        validatePullRequests: false,
      }),
    );
    assert.ok(error instanceof RebaseConflictError);
    assert.deepStrictEqual(remoteTips(fixture), before);
  });

  it("aborts every ref update when a force-with-lease becomes stale", async () => {
    const fixture = createFixture();
    const before = remoteTips(fixture);
    let concurrentTip = "";
    const error = await captureFailure(
      syncStack({
        sourceRoot: fixture.work,
        push: true,
        validatePullRequests: false,
        beforePush: () => {
          runGit(fixture.work, ["checkout", "--quiet", "feature/pr-5"]);
          concurrentTip = commitFile(
            fixture.work,
            "concurrent.txt",
            "human push\n",
            "concurrent human push",
          );
          runGit(fixture.work, ["push", "--quiet", "origin", "feature/pr-5"]);
        },
      }),
    );
    assert.match(
      error instanceof Error ? error.message : String(error),
      /stale info|atomic push failed|failed to push/,
    );

    const after = remoteTips(fixture);
    assert.equal(after["feature/pr-5"], concurrentTip);
    for (const [branch, sha] of Object.entries(before)) {
      if (branch !== "feature/pr-5") assert.equal(after[branch], sha);
    }
  });

  it("resumes a manually resolved conflict through the remaining branches", async () => {
    const fixture = createFixture({ conflict: true });
    let conflict: RebaseConflictError | undefined;
    try {
      await syncStack({
        sourceRoot: fixture.work,
        push: true,
        validatePullRequests: false,
      });
    } catch (error) {
      if (error instanceof RebaseConflictError) conflict = error;
      else throw error;
    }
    assert.ok(conflict?.stateDir);
    const stateDir = conflict.stateDir;
    const repoDir = NodePath.join(stateDir, "repo");
    write(NodePath.join(repoDir, "shared.txt"), "resolved upstream and pr 4\n");
    runGit(repoDir, ["add", "shared.txt"]);

    await resumeStack(stateDir, { push: true });
    let parent = remoteTip(fixture.upstream, "main");
    for (const { branch } of fixture.manifest.pullRequests) {
      const child = remoteTip(fixture.origin, branch);
      assert.ok(isAncestor(fixture.origin, parent, child));
      parent = child;
    }
  });

  it("rejects closed, renamed, and foreign-owned managed PRs", () => {
    const fixture = createFixture();
    const valid: Array<PullRequestSnapshot> = fixture.manifest.pullRequests.map(
      ({ number, branch }, index) => ({
        number,
        state: "open",
        headBranch: branch,
        headOwner: "patroza",
        baseBranch: index === 0 ? "main" : fixture.manifest.pullRequests[index - 1]!.branch,
        isDraft: true,
      }),
    );

    const variants: ReadonlyArray<ReadonlyArray<PullRequestSnapshot>> = [
      valid.map((pr) => (pr.number === 4 ? { ...pr, state: "closed" } : pr)),
      valid.map((pr) => (pr.number === 4 ? { ...pr, headBranch: "renamed" } : pr)),
      valid.map((pr) => (pr.number === 4 ? { ...pr, headOwner: "someone-else" } : pr)),
    ];
    for (const variant of variants) {
      assert.throws(() => validatePullRequestSnapshots(fixture.manifest, variant), StackError);
    }
  });

  it("ignores ordinary open PRs that are not part of the managed integration chain", () => {
    const fixture = createFixture();
    const valid: Array<PullRequestSnapshot> = fixture.manifest.pullRequests.map(
      ({ number, branch }, index) => ({
        number,
        state: "open",
        headBranch: branch,
        headOwner: "patroza",
        baseBranch: index === 0 ? "main" : fixture.manifest.pullRequests[index - 1]!.branch,
        isDraft: true,
      }),
    );
    assert.doesNotThrow(() =>
      validatePullRequestSnapshots(fixture.manifest, [
        ...valid,
        {
          number: 99,
          state: "open",
          headBranch: "feature/parallel",
          headOwner: "patroza",
          baseBranch: "fork/changes",
          isDraft: true,
        },
      ]),
    );
  });

  it("reports a PR as empty when its commits have already landed upstream", async () => {
    const fixture = createFixture({ landedPr4Upstream: true });
    const error = await captureFailure(
      syncStack({
        sourceRoot: fixture.work,
        push: false,
        validatePullRequests: false,
      }),
    );
    assert.match(
      error instanceof Error ? error.message : String(error),
      /PR #4 became empty.*already have landed upstream/,
    );
  });

  it("never updates a diverged origin main", async () => {
    const fixture = createFixture({ divergedMain: true });
    const before = remoteTips(fixture);
    const error = await captureFailure(
      syncStack({
        sourceRoot: fixture.work,
        push: true,
        validatePullRequests: false,
      }),
    );
    assert.match(
      error instanceof Error ? error.message : String(error),
      /has diverged.*refusing to update fork main/,
    );
    assert.deepStrictEqual(remoteTips(fixture), before);
  });
});

describe("rebaseOpenFeaturePullRequests isolation", () => {
  function createFeatureRebaseFixture() {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "feature-rebase-"));
    const work = NodePath.join(root, "work");
    const origin = NodePath.join(root, "origin.git");
    NodeFS.mkdirSync(work);
    runGit(root, ["init", "--bare", "--quiet", origin]);
    runGit(work, ["init", "--quiet", "--initial-branch=main"]);
    runGit(work, ["config", "user.name", "Stack Test"]);
    runGit(work, ["config", "user.email", "stack-test@example.com"]);
    runGit(work, ["config", "commit.gpgsign", "false"]);
    runGit(work, ["remote", "add", "origin", origin]);
    commitFile(work, "base.txt", "base\n", "base");
    runGit(work, ["checkout", "--quiet", "-b", "fork/changes"]);
    runGit(work, ["push", "--quiet", "origin", "main", "fork/changes"]);

    // Two branches based on the same fork/changes tip.
    runGit(work, ["checkout", "--quiet", "-b", "feature/flaky", "fork/changes"]);
    commitFile(work, "flaky.txt", "flaky\n", "flaky feature");
    runGit(work, ["push", "--quiet", "origin", "feature/flaky"]);

    runGit(work, ["checkout", "--quiet", "-b", "overlay/critical", "fork/changes"]);
    commitFile(work, "overlay.txt", "overlay\n", "overlay work");
    runGit(work, ["push", "--quiet", "origin", "overlay/critical"]);

    const oldForkTip = remoteTip(origin, "fork/changes");

    // Advance fork/changes so both branches need a rebase.
    runGit(work, ["checkout", "--quiet", "fork/changes"]);
    commitFile(work, "changes.txt", "moved\n", "fork/changes advances");
    runGit(work, ["push", "--quiet", "origin", "fork/changes"]);
    const newForkTip = remoteTip(origin, "fork/changes");

    // Reject only feature/flaky pushes via a pre-receive hook (stale-lease stand-in).
    const hookPath = NodePath.join(origin, "hooks", "pre-receive");
    NodeFS.writeFileSync(
      hookPath,
      `#!/bin/sh
while read oldrev newrev refname; do
  if [ "$refname" = "refs/heads/feature/flaky" ]; then
    echo "rejected flaky feature push" >&2
    exit 1
  fi
done
`,
      { mode: 0o755 },
    );

    const manifest: StackManifest = {
      upstreamRemote: "upstream",
      upstreamBranch: "main",
      forkChangesBranch: "fork/changes",
      integrationBranch: "fork/integration",
      pullRequests: [{ number: 2, branch: "fork/changes" }],
      integrationOverlays: [{ number: 10, branch: "overlay/critical" }],
    };
    write(
      NodePath.join(work, ".github", "pr-stack.json"),
      `${JSON.stringify(manifest, undefined, 2)}\n`,
    );

    return { root, work, origin, oldForkTip, newForkTip, manifest };
  }

  it("continues rebasing other PRs when one force-with-lease push is rejected", async () => {
    const fixture = createFeatureRebaseFixture();
    const beforeOverlay = remoteTip(fixture.origin, "overlay/critical");
    const beforeFlaky = remoteTip(fixture.origin, "feature/flaky");

    const result = await rebaseOpenFeaturePullRequests({
      sourceRoot: fixture.work,
      manifest: fixture.manifest,
      push: true,
      oldForkChangesTip: fixture.oldForkTip,
      newForkChangesTip: fixture.newForkTip,
      openPulls: [
        {
          number: 96,
          headBranch: "feature/flaky",
          baseBranch: "fork/changes",
          headRepository: "patroza/t3code",
        },
        {
          number: 10,
          headBranch: "overlay/critical",
          baseBranch: "fork/changes",
          headRepository: "patroza/t3code",
        },
      ],
    });

    // Overlay still updates even though the ordinary feature push was rejected.
    const afterOverlay = remoteTip(fixture.origin, "overlay/critical");
    assert.notEqual(afterOverlay, beforeOverlay);
    assert.ok(isAncestor(fixture.origin, fixture.newForkTip, afterOverlay));
    assert.ok(result.updated.some((entry) => entry.branch === "overlay/critical"));

    // Flaky feature remains on the old tip and is recorded as a conflict.
    assert.equal(remoteTip(fixture.origin, "feature/flaky"), beforeFlaky);
    assert.ok(
      result.conflicts.some(
        (entry) => entry.branch === "feature/flaky" && /push failed|rejected/i.test(entry.message),
      ),
    );
  });

  it("rebases registered overlays before ordinary feature PRs", async () => {
    const fixture = createFeatureRebaseFixture();
    // No rejection hook: both should update; order is asserted via selectOpenFeature.
    NodeFS.unlinkSync(NodePath.join(fixture.origin, "hooks", "pre-receive"));
    const ordered = selectOpenFeaturePullRequests({
      expectedRepository: "patroza/t3code",
      manifest: fixture.manifest,
      openPulls: [
        {
          number: 96,
          headBranch: "feature/flaky",
          baseBranch: "fork/changes",
          headRepository: "patroza/t3code",
        },
        {
          number: 10,
          headBranch: "overlay/critical",
          baseBranch: "fork/changes",
          headRepository: "patroza/t3code",
        },
      ],
    });
    assert.deepEqual(
      ordered.map(({ branch }) => branch),
      ["overlay/critical", "feature/flaky"],
    );

    const result = await rebaseOpenFeaturePullRequests({
      sourceRoot: fixture.work,
      manifest: fixture.manifest,
      push: true,
      oldForkChangesTip: fixture.oldForkTip,
      newForkChangesTip: fixture.newForkTip,
      openPulls: ordered.map((entry) => ({
        number: entry.number,
        headBranch: entry.branch,
        baseBranch: "fork/changes",
        headRepository: "patroza/t3code",
      })),
    });
    assert.equal(result.conflicts.length, 0);
    assert.ok(
      isAncestor(fixture.origin, fixture.newForkTip, remoteTip(fixture.origin, "overlay/critical")),
    );
    assert.ok(
      isAncestor(fixture.origin, fixture.newForkTip, remoteTip(fixture.origin, "feature/flaky")),
    );
  });
});
