import { describe, expect, it } from "vite-plus/test";

import { parseManifest, StackError, type StackManifest } from "./rebase-pr-stack.ts";
import {
  featurePullRequestBaseBranch,
  orderUniqueCommitsOldestFirst,
  planFeatureBranchUpdate,
  planLocalSyncWithRemote,
  registerPullRequest,
  shouldAutoSkipConflictingTransplant,
  shouldRetargetPullRequestBase,
  stackParentBranch,
  uniqueLocalCommitsFromCherry,
  unregisterTopPullRequest,
} from "./fork-stack.ts";
import { selectOpenFeaturePullRequests } from "./rebase-pr-stack.ts";

const manifest: StackManifest = {
  upstreamRemote: "upstream",
  upstreamBranch: "main",
  forkChangesBranch: "fork/changes",
  integrationBranch: "fork/integration",
  pullRequests: [],
};

describe("fork stack helpers", () => {
  it("accepts an empty manifest before the one-time cutover", () => {
    expect(parseManifest(JSON.stringify(manifest))).toEqual(manifest);
    expect(stackParentBranch(manifest)).toBe("fork/changes");
  });

  it("targets ordinary feature PRs at fork/changes", () => {
    expect(featurePullRequestBaseBranch(manifest)).toBe("fork/changes");
    expect(shouldRetargetPullRequestBase("main", "fork/changes")).toBe(true);
    expect(shouldRetargetPullRequestBase("fork/changes", "fork/changes")).toBe(false);
  });

  it("plans a simple rebase when behind an ancestor base", () => {
    expect(
      planFeatureBranchUpdate({
        baseIsAncestorOfHead: true,
        behindCount: 3,
        aheadCount: 1,
        uniquePatchOidsOldestFirst: ["abc"],
      }),
    ).toEqual({ action: "rebase", replayOids: [] });
  });

  it("is a noop when already up to date with the base tip", () => {
    expect(
      planFeatureBranchUpdate({
        baseIsAncestorOfHead: true,
        behindCount: 0,
        aheadCount: 2,
        uniquePatchOidsOldestFirst: ["abc", "def"],
      }),
    ).toEqual({ action: "noop", replayOids: [] });
  });

  it("cherry-picks only patch-id unique commits when history diverged after a base rewrite", () => {
    expect(
      planFeatureBranchUpdate({
        baseIsAncestorOfHead: false,
        behindCount: 50,
        aheadCount: 600,
        uniquePatchOidsOldestFirst: ["only-feature-commit"],
      }),
    ).toEqual({ action: "cherry-pick-unique", replayOids: ["only-feature-commit"] });
  });

  it("is a noop when diverged but every patch already exists on the new base", () => {
    expect(
      planFeatureBranchUpdate({
        baseIsAncestorOfHead: false,
        behindCount: 10,
        aheadCount: 10,
        uniquePatchOidsOldestFirst: [],
      }),
    ).toEqual({ action: "noop", replayOids: [] });
  });

  it("orders unique commits oldest-first from rev-list order", () => {
    expect(orderUniqueCommitsOldestFirst(["a", "b", "c", "d"], ["d", "b"])).toEqual(["b", "d"]);
  });

  it("auto-skips only large conflicting transplants", () => {
    expect(shouldAutoSkipConflictingTransplant({ changedFileCount: 7 })).toBe(false);
    expect(shouldAutoSkipConflictingTransplant({ changedFileCount: 31 })).toBe(true);
  });

  it("resets local to remote when git cherry has no unique patches", () => {
    expect(
      planLocalSyncWithRemote({
        uniqueLocalCommitOids: [],
        remoteTipExists: true,
      }),
    ).toEqual({ action: "reset-to-remote", uniqueLocalCommitOids: [] });
  });

  it("rebases unique local patches onto a force-pushed remote", () => {
    expect(
      planLocalSyncWithRemote({
        uniqueLocalCommitOids: ["local-only"],
        remoteTipExists: true,
      }),
    ).toEqual({
      action: "rebase-onto-remote",
      uniqueLocalCommitOids: ["local-only"],
    });
  });

  it("parses git cherry output for unique local commits", () => {
    expect(
      uniqueLocalCommitsFromCherry(`+ abc123
- def456
+ ghi789
`),
    ).toEqual(["abc123", "ghi789"]);
  });

  it("selects only open feature PRs targeting fork/changes", () => {
    const withStack: StackManifest = {
      ...manifest,
      pullRequests: [
        { number: 1, branch: "fork/tim" },
        { number: 27, branch: "fork/candidates" },
        { number: 2, branch: "fork/changes" },
      ],
    };
    expect(
      selectOpenFeaturePullRequests({
        openPulls: [
          {
            number: 41,
            headBranch: "draft/restore-external-session-import",
            baseBranch: "fork/changes",
            headRepository: "patroza/t3code",
          },
          {
            number: 2,
            headBranch: "fork/changes",
            baseBranch: "fork/candidates",
            headRepository: "patroza/t3code",
          },
          {
            number: 10,
            headBranch: "t3-discord/f7d37879-desktop-deeplinks",
            baseBranch: "fork/changes",
            headRepository: "patroza/t3code",
          },
          {
            number: 99,
            headBranch: "someone/else",
            baseBranch: "fork/changes",
            headRepository: "other/t3code",
          },
        ],
        manifest: withStack,
        expectedRepository: "patroza/t3code",
      }),
    ).toEqual([
      { number: 41, branch: "draft/restore-external-session-import" },
      { number: 10, branch: "t3-discord/f7d37879-desktop-deeplinks" },
    ]);
  });

  it("registers the permanent fork changes PR first", () => {
    const next = registerPullRequest(manifest, {
      number: 201,
      state: "OPEN",
      headRefName: "fork/changes",
      baseRefName: "main",
    });
    expect(next.pullRequests).toEqual([{ number: 201, branch: "fork/changes" }]);
    expect(stackParentBranch(next)).toBe("fork/changes");
  });

  it("registers a clean dependent PR against the current top", () => {
    const withForkChanges: StackManifest = {
      ...manifest,
      pullRequests: [{ number: 201, branch: "fork/changes" }],
    };
    const next = registerPullRequest(withForkChanges, {
      number: 202,
      state: "OPEN",
      headRefName: "import/tim-2026-07-24",
      baseRefName: "fork/changes",
    });
    expect(next.pullRequests.at(-1)).toEqual({
      number: 202,
      branch: "import/tim-2026-07-24",
    });
  });

  it("rejects a first PR that is not the fork changes branch", () => {
    expect(() =>
      registerPullRequest(manifest, {
        number: 202,
        state: "OPEN",
        headRefName: "feature/wrong",
        baseRefName: "main",
      }),
    ).toThrow(StackError);
  });

  it("rejects a PR based on the wrong parent", () => {
    const withForkChanges: StackManifest = {
      ...manifest,
      pullRequests: [{ number: 201, branch: "fork/changes" }],
    };
    expect(() =>
      registerPullRequest(withForkChanges, {
        number: 202,
        state: "OPEN",
        headRefName: "feature/new",
        baseRefName: "main",
      }),
    ).toThrow(/expected fork\/changes/);
  });

  it("only unregisters the top PR", () => {
    const stacked: StackManifest = {
      ...manifest,
      pullRequests: [
        { number: 201, branch: "fork/changes" },
        { number: 202, branch: "feature/new" },
      ],
    };
    expect(unregisterTopPullRequest(stacked, 202).pullRequests).toEqual([
      { number: 201, branch: "fork/changes" },
    ]);
    expect(() => unregisterTopPullRequest(stacked, 201)).toThrow(/Only the top PR/);
  });
});
