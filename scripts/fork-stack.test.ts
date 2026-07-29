import { describe, expect, it } from "vite-plus/test";

import {
  appendBaseHistory,
  parseBaseHistory,
  parseManifest,
  recoverOldBaseTip,
  selectOpenFeaturePullRequests,
  StackError,
  type StackManifest,
} from "./rebase-pr-stack.ts";
import {
  featurePullRequestBaseBranch,
  planFeatureBranchUpdate,
  planLocalSyncWithRemote,
  registerPullRequest,
  registerIntegrationOverlay,
  resolveFeaturePullRequestBaseBranch,
  shouldRetargetPullRequestBase,
  stackParentBranch,
  uniqueLocalCommitsFromCherry,
  unregisterTopPullRequest,
  unregisterIntegrationOverlay,
} from "./fork-stack.ts";

const manifest: StackManifest = {
  upstreamRemote: "upstream",
  upstreamBranch: "main",
  forkChangesBranch: "fork/changes",
  integrationBranch: "fork/integration",
  pullRequests: [],
  integrationOverlays: [],
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

  it("preserves an intentional overlay parent for dependent PR updates", () => {
    const withOverlay: StackManifest = {
      ...manifest,
      integrationOverlays: [{ number: 80, branch: "fork/discord" }],
    };
    expect(
      resolveFeaturePullRequestBaseBranch({
        manifest: withOverlay,
        currentBase: "fork/discord",
        baseHasOpenPullRequest: true,
      }),
    ).toBe("fork/discord");
    expect(
      resolveFeaturePullRequestBaseBranch({
        manifest: withOverlay,
        currentBase: "main",
        baseHasOpenPullRequest: false,
      }),
    ).toBe("fork/changes");
  });

  it("plans a simple rebase when behind an ancestor base", () => {
    expect(
      planFeatureBranchUpdate({
        newBaseIsAncestorOfHead: true,
        behindCount: 3,
        recoveredOldBaseOid: null,
      }),
    ).toEqual({ action: "rebase", oldBaseOid: null });
  });

  it("is a noop when already up to date with the base tip", () => {
    expect(
      planFeatureBranchUpdate({
        newBaseIsAncestorOfHead: true,
        behindCount: 0,
        recoveredOldBaseOid: null,
      }),
    ).toEqual({ action: "noop", oldBaseOid: null });
  });

  it("plans rebase --onto when the old base tip is recovered after a rewrite", () => {
    expect(
      planFeatureBranchUpdate({
        newBaseIsAncestorOfHead: false,
        behindCount: 50,
        recoveredOldBaseOid: "oldbase123",
      }),
    ).toEqual({ action: "rebase-onto", oldBaseOid: "oldbase123" });
  });

  it("throws when diverged and no old base tip can be recovered", () => {
    expect(() =>
      planFeatureBranchUpdate({
        newBaseIsAncestorOfHead: false,
        behindCount: 10,
        recoveredOldBaseOid: null,
      }),
    ).toThrow(StackError);
  });

  it("recovers the newest historical base tip that is still an ancestor of head", () => {
    const ancestors = new Set(["aaa", "bbb"]);
    expect(
      recoverOldBaseTip({
        historicalBaseTipsNewestFirst: ["ccc", "bbb", "aaa"],
        isAncestorOfHead: (tip) => ancestors.has(tip),
      }),
    ).toBe("bbb");
  });

  it("returns null when no historical base tip is an ancestor", () => {
    expect(
      recoverOldBaseTip({
        historicalBaseTipsNewestFirst: ["ccc", "ddd"],
        isAncestorOfHead: () => false,
      }),
    ).toBeNull();
  });

  it("appends base history newest-first without duplicates", () => {
    expect(parseBaseHistory("aaa1111\nbbb2222\n")).toEqual(["aaa1111", "bbb2222"]);
    expect(appendBaseHistory(["bbb2222", "aaa1111"], ["ccc3333", "bbb2222"], 10)).toEqual([
      "ccc3333",
      "bbb2222",
      "aaa1111",
    ]);
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

  it("registers only draft overlays based on fork/changes", () => {
    const next = registerIntegrationOverlay(manifest, {
      number: 10,
      state: "OPEN",
      headRefName: "feature/deep-links",
      baseRefName: "fork/changes",
      isDraft: true,
    });
    expect(next.integrationOverlays).toEqual([{ number: 10, branch: "feature/deep-links" }]);
    expect(() =>
      registerIntegrationOverlay(manifest, {
        number: 11,
        state: "OPEN",
        headRefName: "feature/ready",
        baseRefName: "fork/changes",
        isDraft: false,
      }),
    ).toThrow(/must be a draft/);
    expect(() =>
      registerIntegrationOverlay(manifest, {
        number: 12,
        state: "OPEN",
        headRefName: "feature/wrong-base",
        baseRefName: "main",
        isDraft: true,
      }),
    ).toThrow(/expected fork\/changes/);
    expect(unregisterIntegrationOverlay(next, 10).integrationOverlays).toEqual([]);
  });
});
