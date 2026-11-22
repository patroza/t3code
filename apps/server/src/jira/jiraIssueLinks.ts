import {
  IssueTrackerKind,
  type IssueLinkedThreadsResult,
  type ThreadId,
  type ThreadIssueKey,
} from "@t3tools/contracts";

export const JIRA_ISSUE_TRACKER_KIND = IssueTrackerKind.make("jira");

export type JiraLinkedThreadLookup =
  | { readonly _tag: "unlinked" }
  | { readonly _tag: "ambiguous"; readonly threadIds: ReadonlyArray<ThreadId> }
  | { readonly _tag: "linked"; readonly threadId: ThreadId };

/** The Jira site's host, which is what a thread link and the issue tracker call `host`. */
export function jiraSiteHost(siteUrl: string): string {
  return new URL(siteUrl).host.toLowerCase();
}

export function jiraIssueBrowseUrl(siteUrl: string, issueKey: string): string {
  return `${siteUrl.replace(/\/+$/u, "")}/browse/${encodeURIComponent(issueKey)}`;
}

/** The upstream thread ↔ issue key for a Jira issue: scope is the Jira project key. */
export function jiraThreadIssueKey(input: {
  readonly siteUrl: string;
  readonly issueKey: string;
  readonly projectKey: string;
}): ThreadIssueKey {
  return {
    tracker: JIRA_ISSUE_TRACKER_KIND,
    host: jiraSiteHost(input.siteUrl),
    scope: input.projectKey.trim().toUpperCase(),
    key: input.issueKey.trim().toUpperCase(),
  };
}

/** One linked thread joins it; several are ambiguous and the bridge refuses to pick. */
export function jiraThreadLookupFromLinkedThreads(
  linked: IssueLinkedThreadsResult,
): JiraLinkedThreadLookup {
  const ids = [...new Set(linked.threads.map((thread) => thread.id))];
  if (ids.length === 0) return { _tag: "unlinked" };
  if (ids.length > 1) return { _tag: "ambiguous", threadIds: ids };
  return { _tag: "linked", threadId: ids[0]! };
}
