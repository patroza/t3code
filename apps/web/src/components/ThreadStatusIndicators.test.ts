import type { VcsStatusResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  prStatusIndicator,
  resolveThreadPr,
  computeGroupPrConsensus,
  type PrStatusIndicator,
} from "./ThreadStatusIndicators";

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

const openIndicator: PrStatusIndicator = {
  label: "PR open",
  colorClass: "text-emerald-600 dark:text-emerald-300/90",
  tooltip: "#42 PR open: Add feature",
  url: "https://github.com/org/repo/pull/42",
};

const mergedIndicator: PrStatusIndicator = {
  label: "PR merged",
  colorClass: "text-violet-600 dark:text-violet-300/90",
  tooltip: "#7 PR merged: Other",
  url: "https://github.com/org/repo/pull/7",
};

describe("computeGroupPrConsensus", () => {
  it("returns a rolled-up shared indicator when every member agrees", () => {
    const consensus = computeGroupPrConsensus([openIndicator, openIndicator, openIndicator]);
    expect(consensus.allSame).toBe(true);
    expect(consensus.shared).toEqual(openIndicator);
  });

  it("defers to per-member indicators when any member differs", () => {
    const consensus = computeGroupPrConsensus([openIndicator, mergedIndicator, openIndicator]);
    expect(consensus.allSame).toBe(false);
    expect(consensus.shared).toBeNull();
  });

  it("still rolls up when every member lacks a PR", () => {
    const consensus = computeGroupPrConsensus([null, null]);
    expect(consensus.allSame).toBe(true);
    expect(consensus.shared).toBeNull();
  });

  it("does not roll up when some members lack a PR and others have one", () => {
    const consensus = computeGroupPrConsensus([openIndicator, null]);
    expect(consensus.allSame).toBe(false);
    expect(consensus.shared).toBeNull();
  });

  it("treats an empty group as agreeing on nothing", () => {
    const consensus = computeGroupPrConsensus([]);
    expect(consensus.allSame).toBe(true);
    expect(consensus.shared).toBeNull();
    expect(consensus.indicators).toEqual([]);
  });
});
