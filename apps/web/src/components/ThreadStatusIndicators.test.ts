import type { VcsStatusResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { prStatusIndicator, resolveThreadPr } from "./ThreadStatusIndicators";

const openPr = {
  number: 42,
  title: "Add feature",
  url: "https://github.com/org/repo/pull/42",
  baseRef: "main",
  headRef: "feature/demo",
  state: "open" as const,
};

function gitStatus(
  overrides: Partial<VcsStatusResult> & Pick<VcsStatusResult, "refName">,
): VcsStatusResult {
  return {
    isRepo: true,
    hasPrimaryRemote: true,
    isDefaultRef: false,
    hasWorkingTreeChanges: false,
    workingTree: { files: [], insertions: 0, deletions: 0 },
    hasUpstream: true,
    aheadCount: 0,
    behindCount: 0,
    aheadOfDefaultCount: 0,
    pr: null,
    ...overrides,
  };
}

describe("resolveThreadPr", () => {
  it("returns the PR when checkout ref matches the thread branch", () => {
    expect(
      resolveThreadPr("feature/demo", gitStatus({ refName: "feature/demo", pr: openPr })),
    ).toEqual(openPr);
  });

  it("returns the PR when the PR head matches the thread branch but checkout differs", () => {
    expect(resolveThreadPr("feature/demo", gitStatus({ refName: "main", pr: openPr }))).toEqual(
      openPr,
    );
  });

  it("returns null when neither checkout nor PR head match the thread branch", () => {
    expect(
      resolveThreadPr(
        "feature/other",
        gitStatus({
          refName: "main",
          pr: openPr,
        }),
      ),
    ).toBeNull();
  });
});

describe("prStatusIndicator", () => {
  it("maps open PRs to the emerald indicator class", () => {
    expect(
      prStatusIndicator(openPr, { kind: "github", name: "GitHub", baseUrl: "" }),
    ).toMatchObject({
      label: "PR open",
      colorClass: "text-emerald-600 dark:text-emerald-300/90",
    });
  });
});
