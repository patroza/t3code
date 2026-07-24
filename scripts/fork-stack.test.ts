import { describe, expect, it } from "vite-plus/test";

import { parseManifest, StackError, type StackManifest } from "./rebase-pr-stack.ts";
import { registerPullRequest, stackParentBranch, unregisterTopPullRequest } from "./fork-stack.ts";

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
