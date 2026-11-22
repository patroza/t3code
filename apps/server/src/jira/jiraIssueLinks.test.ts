import { describe, expect, it } from "@effect/vitest";
import { ProjectId, ThreadId } from "@t3tools/contracts";

import { jiraThreadIssueKey, jiraThreadLookupFromLinkedThreads } from "./jiraIssueLinks.ts";

const thread = (id: string) => ({
  id: ThreadId.make(id),
  projectId: ProjectId.make("project"),
  title: id,
  archivedAt: null,
  settled: false,
});

describe("Jira thread issue links", () => {
  it("keys an issue by site host and project", () => {
    expect(
      jiraThreadIssueKey({
        siteUrl: "https://Acme.atlassian.net/",
        issueKey: "sa-12",
        projectKey: "sa",
      }),
    ).toEqual({ tracker: "jira", host: "acme.atlassian.net", scope: "SA", key: "SA-12" });
  });

  it("joins one linked thread and refuses to pick between several", () => {
    expect(jiraThreadLookupFromLinkedThreads({ threads: [] })).toEqual({ _tag: "unlinked" });
    expect(jiraThreadLookupFromLinkedThreads({ threads: [thread("a")] })).toEqual({
      _tag: "linked",
      threadId: "a",
    });
    expect(jiraThreadLookupFromLinkedThreads({ threads: [thread("a"), thread("b")] })).toEqual({
      _tag: "ambiguous",
      threadIds: ["a", "b"],
    });
  });
});
