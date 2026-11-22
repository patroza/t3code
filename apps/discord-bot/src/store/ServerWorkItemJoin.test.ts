import { IssueTrackerKind, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  findUniqueExternalWorkItemThread,
  jiraSiteHostFromUrl,
  normalizeGitHubPullRequestRef,
  type WorkItemThread,
} from "./ServerWorkItemJoin.ts";

const linkedAt = "2026-07-30T00:00:00.000Z";

function jiraLink(key: string, host = "example.atlassian.net") {
  return {
    tracker: IssueTrackerKind.make("jira"),
    host,
    scope: key.slice(0, key.lastIndexOf("-")),
    key,
    projectId: ProjectId.make("project-1"),
    url: `https://${host}/browse/${key}`,
    source: "agent" as const,
    linkedAt,
    displayKey: key,
    title: key,
  };
}

function prLink(
  repository: string,
  number: number,
  source: WorkItemThread["pullRequests"][number]["source"] = "created",
) {
  return {
    host: "github.com",
    repository,
    number,
    url: `https://github.com/${repository}/pull/${number}`,
    source,
    linkedAt,
    snapshot: null,
    stack: null,
  };
}

function thread(
  id: string,
  links: {
    readonly issues?: WorkItemThread["issues"];
    readonly pullRequests?: WorkItemThread["pullRequests"];
    readonly deletedAt?: string | null;
  },
): WorkItemThread {
  return {
    id: ThreadId.make(id),
    deletedAt: links.deletedAt ?? null,
    issues: links.issues ?? [],
    pullRequests: links.pullRequests ?? [],
  };
}

const host = jiraSiteHostFromUrl("https://Example.atlassian.net/");

describe("findUniqueExternalWorkItemThread", () => {
  it("normalizes PR refs and the Jira site host", () => {
    expect(normalizeGitHubPullRequestRef("https://github.com/Acme/Repo/pull/9")).toBe(
      "github.com/acme/repo/pull/9",
    );
    expect(normalizeGitHubPullRequestRef("acme/repo#9")).toBe("github.com/acme/repo/pull/9");
    expect(host).toBe("example.atlassian.net");
    expect(jiraSiteHostFromUrl("not a url")).toBeUndefined();
  });

  it("finds the one thread linked to a Jira key and fails closed on ambiguity", () => {
    const threads = [
      thread("t-jira", { issues: [jiraLink("SA-401")] }),
      thread("t-other", { issues: [jiraLink("SA-402")] }),
    ];
    const find = (jiraIssueKeys: ReadonlyArray<string>) =>
      findUniqueExternalWorkItemThread({ jiraIssueKeys, prUrls: [], threads, jiraSiteHost: host });

    expect(find(["sa-401"])).toBe("t-jira");
    expect(find(["SA-401", "SA-402"])).toBeNull();
    expect(find(["SA-999"])).toBeNull();
    expect(find(["UTF-8"])).toBeNull();
  });

  it("matches a bare key only on the configured Jira site", () => {
    const threads = [
      thread("t-elsewhere", { issues: [jiraLink("SA-401", "other.atlassian.net")] }),
    ];
    expect(
      findUniqueExternalWorkItemThread({
        jiraIssueKeys: ["SA-401"],
        prUrls: [],
        threads,
        jiraSiteHost: host,
      }),
    ).toBeNull();
    expect(
      findUniqueExternalWorkItemThread({
        jiraIssueKeys: ["SA-401"],
        prUrls: [],
        threads,
        jiraSiteHost: undefined,
      }),
    ).toBe("t-elsewhere");
  });

  it("finds a thread by linked pull request and skips dismissed and deleted links", () => {
    const find = (threads: ReadonlyArray<WorkItemThread>) =>
      findUniqueExternalWorkItemThread({
        jiraIssueKeys: [],
        prUrls: ["https://github.com/Acme/Repo/pull/9"],
        threads,
        jiraSiteHost: host,
      });

    expect(find([thread("t-pr", { pullRequests: [prLink("acme/repo", 9)] })])).toBe("t-pr");
    expect(
      find([thread("t-pr", { pullRequests: [prLink("acme/repo", 9, "stack-dismissed")] })]),
    ).toBeNull();
    expect(
      find([thread("t-pr", { pullRequests: [prLink("acme/repo", 9)], deletedAt: linkedAt })]),
    ).toBeNull();
  });
});
