import { describe, expect, it } from "@effect/vitest";

import { inferPullRequestStack, stackBranchesForMatching } from "./GitHubPullRequestStack.ts";

const pullRequest = (number: number, headBranch: string, baseBranch: string) => ({
  number,
  headBranch,
  headSha: `sha-${number}`,
  baseBranch,
});

describe("GitHub pull request stack inference", () => {
  it("infers the ordered parent and child chain around the requested PR", () => {
    const context = inferPullRequestStack({
      target: pullRequest(12, "feature-api", "feature-core"),
      openPullRequests: [
        pullRequest(13, "feature-ui", "feature-api"),
        pullRequest(12, "feature-api", "feature-core"),
        pullRequest(11, "feature-core", "main"),
        pullRequest(99, "unrelated", "main"),
      ],
    });

    expect(context.source).toBe("inferred");
    expect(context.baseBranch).toBe("main");
    expect(context.pullRequests.map(({ number }) => number)).toEqual([11, 12, 13]);
    expect(stackBranchesForMatching(context, 12)).toEqual([
      "feature-api",
      "feature-core",
      "feature-ui",
    ]);
  });

  it("stops at ambiguous branches instead of joining unrelated PRs", () => {
    const context = inferPullRequestStack({
      target: pullRequest(11, "feature-core", "main"),
      openPullRequests: [
        pullRequest(11, "feature-core", "main"),
        pullRequest(12, "feature-api", "feature-core"),
        pullRequest(13, "feature-ui", "feature-core"),
      ],
    });

    expect(context.source).toBe("exact");
    expect(context.pullRequests.map(({ number }) => number)).toEqual([11]);
  });

  it("falls back to exact context when no chain exists", () => {
    const context = inferPullRequestStack({
      target: pullRequest(42, "feature", "main"),
      openPullRequests: [pullRequest(42, "feature", "main")],
    });

    expect(context).toMatchObject({
      source: "exact",
      stackNumber: null,
      baseBranch: "main",
    });
    expect(context.pullRequests.map(({ number }) => number)).toEqual([42]);
  });
});
