import type { VcsStatusChangeRequest, VcsStatusResult } from "@t3tools/contracts";
import { SourceControlProviderKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  getChangeRequestTerminologyForKind,
  resolveChangeRequestIndicator,
  resolveChangeRequestPresentation,
  resolveThreadChangeRequest,
} from "./sourceControl.ts";

const openPr: VcsStatusChangeRequest = {
  number: 42,
  title: "Add feature",
  url: "https://github.com/org/repo/pull/42",
  baseRef: "main",
  headRef: "feature/demo",
  state: "open",
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

describe("resolveThreadChangeRequest", () => {
  it("matches on the live ref or on the change request's head ref", () => {
    expect(
      resolveThreadChangeRequest("feature/demo", gitStatus({ refName: "main", pr: openPr })),
    ).toEqual(openPr);
    expect(
      resolveThreadChangeRequest(
        "feature/demo",
        gitStatus({ refName: "feature/demo", pr: openPr }),
      ),
    ).toEqual(openPr);
  });

  it("returns null when the branch, the status, or the change request is absent", () => {
    expect(
      resolveThreadChangeRequest("feature/other", gitStatus({ refName: "main", pr: openPr })),
    ).toBeNull();
    expect(resolveThreadChangeRequest(null, gitStatus({ refName: "main", pr: openPr }))).toBeNull();
    expect(resolveThreadChangeRequest("feature/demo", null)).toBeNull();
    expect(resolveThreadChangeRequest("feature/demo", gitStatus({ refName: "main" }))).toBeNull();
  });
});

describe("resolveChangeRequestIndicator", () => {
  it("labels each state with the provider's own terminology", () => {
    expect(resolveChangeRequestIndicator(openPr, undefined)).toEqual({
      state: "open",
      number: 42,
      label: "PR open",
      tooltip: "#42 PR open: Add feature",
      url: "https://github.com/org/repo/pull/42",
    });
    expect(
      resolveChangeRequestIndicator(
        { ...openPr, state: "merged" },
        {
          kind: SourceControlProviderKind.make("gitlab"),
          name: "GitLab",
          baseUrl: "https://gitlab.com",
        },
      ),
    ).toMatchObject({ state: "merged", label: "MR merged", tooltip: "#42 MR merged: Add feature" });
  });

  it("returns null without a change request", () => {
    expect(resolveChangeRequestIndicator(null, undefined)).toBeNull();
    expect(resolveChangeRequestIndicator(undefined, undefined)).toBeNull();
  });
});

describe("source control presentation", () => {
  it("uses merge request terminology for GitLab", () => {
    expect(getChangeRequestTerminologyForKind(SourceControlProviderKind.make("gitlab"))).toEqual({
      shortLabel: "MR",
      singular: "merge request",
    });
  });

  it("uses pull request terminology for GitHub-compatible providers", () => {
    expect(getChangeRequestTerminologyForKind(SourceControlProviderKind.make("github"))).toEqual({
      shortLabel: "PR",
      singular: "pull request",
    });
    expect(
      getChangeRequestTerminologyForKind(SourceControlProviderKind.make("azure-devops")),
    ).toEqual({
      shortLabel: "PR",
      singular: "pull request",
    });
    expect(getChangeRequestTerminologyForKind(SourceControlProviderKind.make("bitbucket"))).toEqual(
      {
        shortLabel: "PR",
        singular: "pull request",
      },
    );
  });

  it("falls back to generic change request copy for unknown providers", () => {
    expect(
      resolveChangeRequestPresentation({
        kind: SourceControlProviderKind.make("unknown"),
        name: "forge",
        baseUrl: "",
      }),
    ).toEqual(
      expect.objectContaining({
        shortName: "change request",
        longName: "change request",
      }),
    );
  });
});
