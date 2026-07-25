#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalConsole:off

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const FORK_REPOSITORY = process.env.T3CODE_FORK_REPOSITORY ?? "patroza/t3code";

import {
  readManifest,
  StackError,
  type StackManifest,
  type StackPullRequest,
} from "./rebase-pr-stack.ts";

const MANIFEST_PATH = NodePath.join(".github", "pr-stack.json");

interface PullRequestView {
  readonly number: number;
  readonly state: string;
  readonly headRefName: string;
  readonly baseRefName: string;
}

interface PullRequestCommitsView {
  readonly state: string;
  readonly baseRefName: string;
  readonly commits: ReadonlyArray<{ readonly oid: string }>;
}

/** Strip ANSI color / SGR sequences (agent hosts often set FORCE_COLOR). */
function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, "");
}

/**
 * Parse JSON that may be ANSI-colored by the t3 `gh` wrapper under FORCE_COLOR hosts.
 */
export function parsePossiblyColoredJson(text: string): unknown {
  const cleaned = stripAnsi(text).trim();
  try {
    return JSON.parse(cleaned);
  } catch (firstError) {
    const match = cleaned.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);
    if (match) {
      try {
        return JSON.parse(match[1]!);
      } catch {
        // fall through
      }
    }
    throw firstError;
  }
}

/**
 * Subprocess env for git/gh.
 * Keep FORCE_COLOR as-is: the t3 gh wrapper returns empty --head lists when
 * FORCE_COLOR=0 / NO_COLOR is forced. Strip ANSI from stdout instead.
 */
function subprocessEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
  };
}

function run(executable: string, args: ReadonlyArray<string>, cwd: string): string {
  const result = NodeChildProcess.spawnSync(executable, [...args], {
    cwd,
    encoding: "utf8",
    env: subprocessEnv(),
  });
  if (result.error) throw new StackError(`Unable to run ${executable}: ${result.error.message}`);
  if (result.status !== 0) {
    throw new StackError(
      `${executable} ${args.join(" ")} failed: ${stripAnsi(result.stderr.trim() || result.stdout.trim())}`,
    );
  }
  return stripAnsi(result.stdout ?? "").trim();
}

export function stackParentBranch(manifest: StackManifest): string {
  return manifest.pullRequests.at(-1)?.branch ?? manifest.forkChangesBranch;
}

/**
 * Ordinary feature/import PRs always target the private default branch, not the
 * upstream mirror (`main`) and not intermediate stack provenance branches.
 */
export function featurePullRequestBaseBranch(manifest: StackManifest): string {
  return manifest.forkChangesBranch;
}

export function shouldRetargetPullRequestBase(
  currentBase: string | null | undefined,
  expectedBase: string,
): boolean {
  if (currentBase === null || currentBase === undefined || currentBase.trim() === "") {
    return false;
  }
  return currentBase !== expectedBase;
}

/**
 * Plan how to bring a feature PR branch up to date with `fork/changes`.
 *
 * - `rebase` when the base tip is already an ancestor (normal drift).
 * - `replay` when the branch was cut from the wrong parent (e.g. upstream `main`)
 *   and only the PR's own commits should be kept.
 * - `noop` when already current.
 */
export function planFeatureBranchUpdate(input: {
  readonly baseIsAncestorOfHead: boolean;
  readonly behindCount: number;
  readonly aheadCount: number;
  readonly pullRequestCommitOids: ReadonlyArray<string>;
}): {
  readonly action: "noop" | "rebase" | "replay";
  readonly replayOids: ReadonlyArray<string>;
} {
  if (input.baseIsAncestorOfHead) {
    if (input.behindCount <= 0) {
      return { action: "noop", replayOids: [] };
    }
    return { action: "rebase", replayOids: [] };
  }
  if (input.pullRequestCommitOids.length === 0) {
    throw new StackError(
      "Branch is not based on fork/changes and no PR commits are available to replay. Re-create the branch with `pnpm fork:stack start <branch>`.",
    );
  }
  return { action: "replay", replayOids: input.pullRequestCommitOids };
}

export function registerPullRequest(
  manifest: StackManifest,
  pullRequest: PullRequestView,
): StackManifest {
  if (pullRequest.state.toLowerCase() !== "open") {
    throw new StackError(`PR #${pullRequest.number} is not open.`);
  }
  if (manifest.pullRequests.some(({ number }) => number === pullRequest.number)) {
    throw new StackError(`PR #${pullRequest.number} is already registered.`);
  }
  if (manifest.pullRequests.some(({ branch }) => branch === pullRequest.headRefName)) {
    throw new StackError(`Branch ${pullRequest.headRefName} is already registered.`);
  }

  const expectedBranch =
    manifest.pullRequests.length === 0 ? manifest.forkChangesBranch : pullRequest.headRefName;
  if (manifest.pullRequests.length === 0 && pullRequest.headRefName !== expectedBranch) {
    throw new StackError(
      `The first PR must use ${manifest.forkChangesBranch}, got ${pullRequest.headRefName}.`,
    );
  }

  const expectedBase = manifest.pullRequests.at(-1)?.branch ?? manifest.upstreamBranch;
  if (pullRequest.baseRefName !== expectedBase) {
    throw new StackError(
      `PR #${pullRequest.number} is based on ${pullRequest.baseRefName}, expected ${expectedBase}.`,
    );
  }

  return {
    ...manifest,
    pullRequests: [
      ...manifest.pullRequests,
      { number: pullRequest.number, branch: pullRequest.headRefName },
    ],
  };
}

export function unregisterTopPullRequest(manifest: StackManifest, number: number): StackManifest {
  const top = manifest.pullRequests.at(-1);
  if (!top || top.number !== number) {
    throw new StackError(
      `Only the top PR can be unregistered; expected #${top?.number ?? "none"}, got #${number}.`,
    );
  }
  return { ...manifest, pullRequests: manifest.pullRequests.slice(0, -1) };
}

function writeManifest(sourceRoot: string, manifest: StackManifest): void {
  NodeFS.writeFileSync(
    NodePath.join(sourceRoot, MANIFEST_PATH),
    `${JSON.stringify(manifest, undefined, 2)}\n`,
    "utf8",
  );
}

function readPullRequest(sourceRoot: string, number: number): PullRequestView {
  const output = run(
    "gh",
    [
      "pr",
      "view",
      String(number),
      "--repo",
      FORK_REPOSITORY,
      "--json",
      "number,state,headRefName,baseRefName",
    ],
    sourceRoot,
  );
  return parsePossiblyColoredJson(output) as PullRequestView;
}

function ensureClean(sourceRoot: string): void {
  if (run("git", ["status", "--porcelain"], sourceRoot) !== "") {
    throw new StackError("The working tree must be clean before starting a stack branch.");
  }
}

function runAllowFailure(
  executable: string,
  args: ReadonlyArray<string>,
  cwd: string,
): NodeChildProcess.SpawnSyncReturns<string> {
  return NodeChildProcess.spawnSync(executable, [...args], {
    cwd,
    encoding: "utf8",
    env: subprocessEnv(),
  });
}

function currentBranchName(sourceRoot: string): string {
  const name = run("git", ["branch", "--show-current"], sourceRoot);
  if (name === "") {
    throw new StackError("Detached HEAD: check out the feature branch before updating.");
  }
  return name;
}

function resolveOpenPullRequestForBranch(
  sourceRoot: string,
  branch: string,
): { readonly number: number; readonly baseRefName: string; readonly headRefName: string } | null {
  const listed = run(
    "gh",
    [
      "pr",
      "list",
      "--repo",
      FORK_REPOSITORY,
      "--head",
      branch,
      "--state",
      "open",
      "--json",
      "number,baseRefName,headRefName",
      "--limit",
      "1",
    ],
    sourceRoot,
  );
  const rows = parsePossiblyColoredJson(listed) as ReadonlyArray<{
    readonly number: number;
    readonly baseRefName: string;
    readonly headRefName: string;
  }>;
  return rows[0] ?? null;
}

function pullRequestCommitOids(sourceRoot: string, number: number): ReadonlyArray<string> {
  const output = run(
    "gh",
    ["pr", "view", String(number), "--repo", FORK_REPOSITORY, "--json", "commits"],
    sourceRoot,
  );
  const value = parsePossiblyColoredJson(output) as {
    readonly commits: ReadonlyArray<{ readonly oid: string }>;
  };
  return value.commits.map((commit) => commit.oid);
}

/**
 * After a remote force-push rebase, decide how to update the local checkout.
 *
 * Uses `git cherry` patch-ids: if every local commit is patch-equivalent to
 * something already on the remote tip, hard-reset to remote (no unique work).
 * If local has unique patches, rebase those onto the remote tip.
 */
export function planLocalSyncWithRemote(input: {
  readonly uniqueLocalCommitOids: ReadonlyArray<string>;
  readonly remoteTipExists: boolean;
}): {
  readonly action: "noop" | "reset-to-remote" | "rebase-onto-remote";
  readonly uniqueLocalCommitOids: ReadonlyArray<string>;
} {
  if (!input.remoteTipExists) {
    throw new StackError("Remote tracking tip does not exist; fetch the branch first.");
  }
  if (input.uniqueLocalCommitOids.length === 0) {
    return { action: "reset-to-remote", uniqueLocalCommitOids: [] };
  }
  return {
    action: "rebase-onto-remote",
    uniqueLocalCommitOids: input.uniqueLocalCommitOids,
  };
}

/**
 * Parse `git cherry <remote> <local>` output into oids whose patches are NOT on remote (+).
 */
export function uniqueLocalCommitsFromCherry(cherryOutput: string): ReadonlyArray<string> {
  return cherryOutput
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("+ ") || line.startsWith("+"))
    .map(
      (line) =>
        line
          .replace(/^\+\s*/, "")
          .trim()
          .split(/\s+/)[0] ?? "",
    )
    .filter(Boolean);
}

/**
 * Rebase or replay the current feature branch onto latest `fork/changes`, retarget the
 * open PR base if needed, and optionally force-with-lease push so the PR stays mergeable.
 */
function updateFeatureBranch(
  sourceRoot: string,
  manifest: StackManifest,
  options: {
    readonly pullRequestNumber?: number | undefined;
    readonly push: boolean;
  },
): void {
  ensureClean(sourceRoot);
  const expectedBase = featurePullRequestBaseBranch(manifest);
  run("git", ["fetch", "origin", expectedBase], sourceRoot);

  let branch = currentBranchName(sourceRoot);
  let prNumber: number | null = options.pullRequestNumber ?? null;
  let prBaseRefName: string | null = null;

  if (options.pullRequestNumber !== undefined) {
    const pullRequest = readPullRequest(sourceRoot, options.pullRequestNumber);
    if (pullRequest.state.toLowerCase() !== "open") {
      throw new StackError(
        `PR #${options.pullRequestNumber} is ${pullRequest.state}; only open feature PRs can be updated.`,
      );
    }
    branch = pullRequest.headRefName;
    prNumber = pullRequest.number;
    prBaseRefName = pullRequest.baseRefName;
    run(
      "git",
      ["fetch", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
      sourceRoot,
    );
    run("git", ["switch", branch], sourceRoot);
    // Prefer the remote tip when updating a named PR so local drift does not win.
    const remoteTip = run("git", ["rev-parse", `origin/${branch}`], sourceRoot);
    run("git", ["reset", "--hard", remoteTip], sourceRoot);
  } else {
    const open = resolveOpenPullRequestForBranch(sourceRoot, branch);
    if (open !== null) {
      prNumber = open.number;
      prBaseRefName = open.baseRefName;
    }
  }

  const baseRef = `origin/${expectedBase}`;
  const ancestorCheck = runAllowFailure(
    "git",
    ["merge-base", "--is-ancestor", baseRef, "HEAD"],
    sourceRoot,
  );
  const baseIsAncestorOfHead = ancestorCheck.status === 0;
  const behindCount = Number(run("git", ["rev-list", "--count", `HEAD..${baseRef}`], sourceRoot));
  const aheadCount = Number(run("git", ["rev-list", "--count", `${baseRef}..HEAD`], sourceRoot));
  const prOids = prNumber === null ? [] : pullRequestCommitOids(sourceRoot, prNumber);
  const plan = planFeatureBranchUpdate({
    baseIsAncestorOfHead,
    behindCount,
    aheadCount,
    pullRequestCommitOids: prOids,
  });

  if (plan.action === "rebase") {
    const result = runAllowFailure(
      "git",
      ["-c", "commit.gpgsign=false", "rebase", baseRef],
      sourceRoot,
    );
    if (result.status !== 0) {
      runAllowFailure("git", ["rebase", "--abort"], sourceRoot);
      throw new StackError(
        `Rebase onto ${expectedBase} failed:\n${result.stderr.trim() || result.stdout.trim()}\nResolve conflicts, then re-run with a clean tree or finish manually.`,
      );
    }
    console.log(`Rebased ${branch} onto ${expectedBase}.`);
  } else if (plan.action === "replay") {
    const tipBefore = run("git", ["rev-parse", "HEAD"], sourceRoot);
    run("git", ["reset", "--hard", baseRef], sourceRoot);
    const cherry = runAllowFailure(
      "git",
      ["-c", "commit.gpgsign=false", "cherry-pick", ...plan.replayOids],
      sourceRoot,
    );
    if (cherry.status !== 0) {
      runAllowFailure("git", ["cherry-pick", "--abort"], sourceRoot);
      run("git", ["reset", "--hard", tipBefore], sourceRoot);
      throw new StackError(
        `Replay onto ${expectedBase} failed while cherry-picking PR commits:\n${cherry.stderr.trim() || cherry.stdout.trim()}`,
      );
    }
    console.log(
      `Replayed ${plan.replayOids.length} PR commit(s) onto ${expectedBase} (was misbased).`,
    );
  } else {
    console.log(`${branch} is already up to date with ${expectedBase}.`);
  }

  if (prNumber !== null && shouldRetargetPullRequestBase(prBaseRefName, expectedBase)) {
    run(
      "gh",
      ["pr", "edit", String(prNumber), "--repo", FORK_REPOSITORY, "--base", expectedBase],
      sourceRoot,
    );
    console.log(`Retargeted PR #${prNumber} base ${prBaseRefName} → ${expectedBase}.`);
  }

  if (options.push) {
    run(
      "git",
      ["push", "--force-with-lease", "-u", "origin", `HEAD:refs/heads/${branch}`],
      sourceRoot,
    );
    console.log(`Pushed ${branch} with --force-with-lease.`);
  } else {
    console.log("Dry run complete (no push). Re-run with --push to update the remote PR branch.");
  }

  if (prNumber !== null) {
    const status = run(
      "gh",
      [
        "pr",
        "view",
        String(prNumber),
        "--repo",
        FORK_REPOSITORY,
        "--json",
        "url,baseRefName,mergeable,mergeStateStatus",
      ],
      sourceRoot,
    );
    console.log(status);
  }
}

/**
 * Safely update a local checkout after the remote branch was force-pushed
 * (stack rebase / feature auto-rebase).
 *
 * If local commits are patch-id-equivalent to the remote tip (`git cherry` has
 * no `+` lines), hard-reset to remote. If local has unique unpushed patches,
 * rebase those onto the remote tip.
 */
function pullLocalBranch(sourceRoot: string, options: { readonly remote?: string }): void {
  ensureClean(sourceRoot);
  const remote = options.remote ?? "origin";
  const branch = currentBranchName(sourceRoot);
  run("git", ["fetch", remote, branch], sourceRoot);
  const remoteRef = `${remote}/${branch}`;
  const remoteExists = runAllowFailure("git", ["rev-parse", "--verify", remoteRef], sourceRoot);
  if (remoteExists.status !== 0) {
    throw new StackError(`Remote tip ${remoteRef} not found after fetch.`);
  }
  const localTip = run("git", ["rev-parse", "HEAD"], sourceRoot);
  const remoteTip = run("git", ["rev-parse", remoteRef], sourceRoot);
  if (localTip === remoteTip) {
    console.log(`${branch} already matches ${remoteRef}.`);
    return;
  }
  const cherry = run("git", ["cherry", remoteRef, "HEAD"], sourceRoot);
  const uniqueLocal = uniqueLocalCommitsFromCherry(cherry);
  const plan = planLocalSyncWithRemote({
    uniqueLocalCommitOids: uniqueLocal,
    remoteTipExists: true,
  });
  if (plan.action === "reset-to-remote") {
    run("git", ["reset", "--hard", remoteRef], sourceRoot);
    console.log(
      `No unique local patches (git cherry clean). Reset ${branch} to ${remoteRef} (${remoteTip.slice(0, 12)}).`,
    );
    return;
  }
  const result = runAllowFailure(
    "git",
    ["-c", "commit.gpgsign=false", "rebase", remoteRef],
    sourceRoot,
  );
  if (result.status !== 0) {
    runAllowFailure("git", ["rebase", "--abort"], sourceRoot);
    throw new StackError(
      `Local has ${plan.uniqueLocalCommitOids.length} unique commit(s) not on ${remoteRef}, but rebase failed:\n${stripAnsi(result.stderr.trim() || result.stdout.trim())}\nResolve manually, or stash/reset if you intended to discard local work.`,
    );
  }
  console.log(
    `Rebased ${plan.uniqueLocalCommitOids.length} unique local commit(s) onto ${remoteRef}.`,
  );
}

function usage(): string {
  return `Usage:
  node scripts/fork-stack.ts start <branch>
  node scripts/fork-stack.ts start-upstream <branch>
  node scripts/fork-stack.ts update [--push] [pr-number]
  node scripts/fork-stack.ts pull
  node scripts/fork-stack.ts promote <private-pr-number> <upstream-branch>
  node scripts/fork-stack.ts adopt <upstream-branch> <private-branch>
  node scripts/fork-stack.ts demote <upstream-pr-number> <private-pr-number>
  node scripts/fork-stack.ts register <pr-number>
  node scripts/fork-stack.ts unregister <pr-number>
  node scripts/fork-stack.ts find <query>
  node scripts/fork-stack.ts find-upstream <query>
  node scripts/fork-stack.ts status`;
}

async function main(args: ReadonlyArray<string>): Promise<void> {
  const sourceRoot = process.cwd();
  const manifest = readManifest(sourceRoot);
  const [command, value, ...extra] = args;

  if (command === "start" && value && extra.length === 0) {
    ensureClean(sourceRoot);
    const parent = featurePullRequestBaseBranch(manifest);
    run("git", ["fetch", "origin", parent], sourceRoot);
    run("git", ["switch", "-c", value, `origin/${parent}`], sourceRoot);
    console.log(`Created ${value} from ${parent}. Open its PR against ${parent}.`);
    return;
  }

  if (command === "update") {
    const tokens = [value, ...extra].filter((token): token is string => token !== undefined);
    let push = false;
    let pullRequestNumber: number | undefined;
    for (const token of tokens) {
      if (token === "--push") {
        push = true;
        continue;
      }
      if (token === "--dry-run") {
        push = false;
        continue;
      }
      const number = Number(token);
      if (Number.isSafeInteger(number) && number > 0 && pullRequestNumber === undefined) {
        pullRequestNumber = number;
        continue;
      }
      throw new StackError(usage());
    }
    updateFeatureBranch(sourceRoot, manifest, { pullRequestNumber, push });
    return;
  }

  if (command === "pull" && value === undefined && extra.length === 0) {
    pullLocalBranch(sourceRoot, {});
    return;
  }

  if (command === "start-upstream" && value && extra.length === 0) {
    ensureClean(sourceRoot);
    run(
      "git",
      [
        "fetch",
        manifest.upstreamRemote,
        `+refs/heads/${manifest.upstreamBranch}:refs/remotes/${manifest.upstreamRemote}/${manifest.upstreamBranch}`,
      ],
      sourceRoot,
    );
    run(
      "git",
      ["switch", "-c", value, `${manifest.upstreamRemote}/${manifest.upstreamBranch}`],
      sourceRoot,
    );
    console.log(
      `Created ${value} from ${manifest.upstreamRemote}/${manifest.upstreamBranch}. Open it to pingdotgg/t3code:${manifest.upstreamBranch}.`,
    );
    return;
  }

  if (command === "promote" && value && extra.length === 1) {
    const number = Number(value);
    const upstreamBranch = extra[0]!;
    if (!Number.isSafeInteger(number) || number <= 0) throw new StackError(usage());
    ensureClean(sourceRoot);
    const pullRequest = parsePossiblyColoredJson(
      run(
        "gh",
        [
          "pr",
          "view",
          String(number),
          "--repo",
          FORK_REPOSITORY,
          "--json",
          "state,baseRefName,commits",
        ],
        sourceRoot,
      ),
    ) as PullRequestCommitsView;
    if (
      pullRequest.state.toLowerCase() !== "merged" ||
      pullRequest.baseRefName !== manifest.forkChangesBranch ||
      pullRequest.commits.length === 0
    ) {
      throw new StackError(
        `Private PR #${number} must be merged into ${manifest.forkChangesBranch} before promotion.`,
      );
    }
    run(
      "git",
      ["fetch", "origin", `+refs/pull/${number}/head:refs/remotes/origin/pr/${number}`],
      sourceRoot,
    );
    run(
      "git",
      [
        "fetch",
        manifest.upstreamRemote,
        `+refs/heads/${manifest.upstreamBranch}:refs/remotes/${manifest.upstreamRemote}/${manifest.upstreamBranch}`,
      ],
      sourceRoot,
    );
    run(
      "git",
      ["switch", "-c", upstreamBranch, `${manifest.upstreamRemote}/${manifest.upstreamBranch}`],
      sourceRoot,
    );
    run(
      "git",
      ["cherry-pick", "--no-commit", ...pullRequest.commits.map(({ oid }) => oid)],
      sourceRoot,
    );
    console.log(
      `Extracted private PR #${number} onto ${upstreamBranch}. Remove private assumptions, test, commit, and open it to pingdotgg/t3code:${manifest.upstreamBranch}.`,
    );
    return;
  }

  if (command === "adopt" && value && extra.length === 1) {
    const upstreamBranch = value;
    const privateBranch = extra[0]!;
    ensureClean(sourceRoot);
    run(
      "git",
      [
        "fetch",
        manifest.upstreamRemote,
        `+refs/heads/${manifest.upstreamBranch}:refs/remotes/${manifest.upstreamRemote}/${manifest.upstreamBranch}`,
      ],
      sourceRoot,
    );
    run(
      "git",
      ["fetch", "origin", `+refs/heads/${upstreamBranch}:refs/remotes/origin/${upstreamBranch}`],
      sourceRoot,
    );
    run("git", ["fetch", "origin", manifest.forkChangesBranch], sourceRoot);
    const commits = run(
      "git",
      [
        "rev-list",
        "--reverse",
        "--no-merges",
        `${manifest.upstreamRemote}/${manifest.upstreamBranch}..origin/${upstreamBranch}`,
      ],
      sourceRoot,
    )
      .split("\n")
      .filter(Boolean);
    if (commits.length === 0) {
      throw new StackError(`No portable commits found on origin/${upstreamBranch}.`);
    }
    run("git", ["switch", "-c", privateBranch, `origin/${manifest.forkChangesBranch}`], sourceRoot);
    run("git", ["cherry-pick", ...commits], sourceRoot);
    console.log(
      `Adopted ${upstreamBranch} as ${privateBranch}. Open it against ${manifest.forkChangesBranch}.`,
    );
    return;
  }

  if (command === "demote" && value && extra.length === 1) {
    const upstreamNumber = Number(value);
    const privateNumber = Number(extra[0]);
    if (
      !Number.isSafeInteger(upstreamNumber) ||
      upstreamNumber <= 0 ||
      !Number.isSafeInteger(privateNumber) ||
      privateNumber <= 0
    ) {
      throw new StackError(usage());
    }
    run(
      "gh",
      [
        "pr",
        "close",
        String(upstreamNumber),
        "--repo",
        "pingdotgg/t3code",
        "--comment",
        `Keeping this implementation private in ${FORK_REPOSITORY}#${privateNumber}.`,
      ],
      sourceRoot,
    );
    run(
      "gh",
      [
        "pr",
        "comment",
        String(privateNumber),
        "--repo",
        FORK_REPOSITORY,
        "--body",
        `Upstream projection pingdotgg/t3code#${upstreamNumber} was closed; this private implementation remains canonical.`,
      ],
      sourceRoot,
    );
    console.log(
      `Demoted pingdotgg/t3code#${upstreamNumber}; private PR #${privateNumber} remains canonical.`,
    );
    return;
  }

  if (command === "register" && value && extra.length === 0) {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number <= 0) throw new StackError(usage());
    const next = registerPullRequest(manifest, readPullRequest(sourceRoot, number));
    writeManifest(sourceRoot, next);
    console.log(`Registered PR #${number}. Commit the manifest change into fork/changes.`);
    return;
  }

  if (command === "unregister" && value && extra.length === 0) {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number <= 0) throw new StackError(usage());
    writeManifest(sourceRoot, unregisterTopPullRequest(manifest, number));
    console.log(`Unregistered PR #${number}. Commit the manifest change into fork/changes.`);
    return;
  }

  if ((command === "find" || command === "find-upstream") && value && extra.length === 0) {
    const repository = command === "find-upstream" ? "pingdotgg/t3code" : FORK_REPOSITORY;
    const output = run(
      "gh",
      [
        "pr",
        "list",
        "--repo",
        repository,
        "--state",
        "all",
        "--search",
        value,
        "--limit",
        "30",
        "--json",
        "number,title,state,headRefName,baseRefName,url",
      ],
      sourceRoot,
    );
    console.log(output);
    return;
  }

  if (command === "status" && value === undefined && extra.length === 0) {
    const rows: ReadonlyArray<StackPullRequest> = manifest.pullRequests;
    console.log(
      JSON.stringify(
        {
          upstream: `${manifest.upstreamRemote}/${manifest.upstreamBranch}`,
          forkChangesBranch: manifest.forkChangesBranch,
          integrationBranch: manifest.integrationBranch,
          nextBaseBranch: stackParentBranch(manifest),
          pullRequests: rows,
        },
        undefined,
        2,
      ),
    );
    return;
  }

  throw new StackError(usage());
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === NodeURL.pathToFileURL(NodePath.resolve(process.argv[1])).href;

if (isMain) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
