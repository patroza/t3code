import { describe, expect, it } from "@effect/vitest";

import {
  mergeOrderedUnique,
  normalizeGitHubPullRequestRef,
  normalizeJiraIssueKey,
  resolveJiraIssueFromRecords,
} from "./ThreadWorkItemStore.ts";

describe("ThreadWorkItemStore helpers", () => {
  it("normalizes Jira keys and drops false positives", () => {
    expect(normalizeJiraIssueKey("sa-402")).toBe("SA-402");
    expect(normalizeJiraIssueKey("UTF-8")).toBeNull();
    expect(normalizeJiraIssueKey("not-a-key")).toBeNull();
  });

  it("normalizes GitHub PR URLs and short refs", () => {
    expect(normalizeGitHubPullRequestRef("https://github.com/Acme/Widgets/pull/42")).toBe(
      "github.com/acme/widgets/pull/42",
    );
    expect(normalizeGitHubPullRequestRef("https://github.com/acme/widgets/pull/42/files")).toBe(
      "github.com/acme/widgets/pull/42",
    );
    expect(normalizeGitHubPullRequestRef("Acme/Widgets#42")).toBe(
      "github.com/acme/widgets/pull/42",
    );
    expect(normalizeGitHubPullRequestRef("not-a-pr")).toBeNull();
  });

  it("merges ordered unique values", () => {
    expect(mergeOrderedUnique(["SA-1"], ["sa-2", "SA-1", "bad"], normalizeJiraIssueKey)).toEqual([
      "SA-1",
      "SA-2",
    ]);
  });

  it("resolves unique / ambiguous / unlinked Jira associations", () => {
    const records = [
      { threadId: "t1" as never, jiraIssueKeys: ["SA-402", "SA-409"] },
      { threadId: "t2" as never, jiraIssueKeys: ["CFG-1"] },
    ];
    expect(resolveJiraIssueFromRecords(records, "SA-402")).toEqual({
      _tag: "linked",
      threadId: "t1",
    });
    expect(resolveJiraIssueFromRecords(records, "NOPE-1")).toEqual({ _tag: "unlinked" });
    expect(
      resolveJiraIssueFromRecords(
        [...records, { threadId: "t3" as never, jiraIssueKeys: ["SA-402"] }],
        "SA-402",
      ),
    ).toMatchObject({ _tag: "ambiguous" });
  });
});
