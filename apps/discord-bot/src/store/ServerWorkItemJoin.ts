/** Find the T3 thread a Jira issue or GitHub pull request is linked to on the server.
 * Links are upstream thread issue / pull request links (Jira webhook, agent, or manual),
 * read from the shell snapshot. Keys a Discord message mentions never create one.
 */
import type { ThreadId } from "@t3tools/contracts";
import type { IntegrationThreadShellView } from "@t3tools/shared/integrationThreadView";

import { normalizeJiraIssueKey } from "../presentation/jiraLinks.ts";

export type WorkItemThread = Pick<
  IntegrationThreadShellView,
  "id" | "deletedAt" | "issues" | "pullRequests"
>;

export function normalizeGitHubPullRequestRef(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const urlMatch = trimmed.match(
    /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/[^?\s]*)?(?:[?#]\S*)?$/iu,
  );
  if (urlMatch) {
    return `github.com/${urlMatch[1]!.toLowerCase()}/${urlMatch[2]!.toLowerCase()}/pull/${urlMatch[3]!}`;
  }
  const shortMatch = trimmed.match(/^([^/\s]+)\/([^#\s]+)#(\d+)$/u);
  if (shortMatch) {
    return `github.com/${shortMatch[1]!.toLowerCase()}/${shortMatch[2]!.toLowerCase()}/pull/${shortMatch[3]!}`;
  }
  return null;
}

/** The host a server-side Jira thread link carries; `undefined` when no site URL parses. */
export function jiraSiteHostFromUrl(siteUrl: string | undefined): string | undefined {
  if (siteUrl === undefined || siteUrl.trim().length === 0) return undefined;
  try {
    return new URL(siteUrl.trim()).host.toLowerCase();
  } catch {
    return undefined;
  }
}

function normalizedSet(
  values: ReadonlyArray<string>,
  normalize: (value: string) => string | null,
): ReadonlySet<string> {
  return new Set(values.map(normalize).filter((value): value is string => value !== null));
}

/**
 * The one live thread linked to any of these Jira keys or PR URLs, including a thread that
 * already has a Discord home. Null when none or more than one match.
 * Jira links match on key, and on the Jira site host when it is known, since a bare key
 * names an issue only within one site.
 */
export function findUniqueExternalWorkItemThread(input: {
  readonly jiraIssueKeys: ReadonlyArray<string>;
  readonly prUrls: ReadonlyArray<string>;
  readonly threads: ReadonlyArray<WorkItemThread>;
  readonly jiraSiteHost: string | undefined;
}): ThreadId | null {
  const jiraKeys = normalizedSet(input.jiraIssueKeys, normalizeJiraIssueKey);
  const prRefs = normalizedSet(input.prUrls, normalizeGitHubPullRequestRef);
  if (jiraKeys.size === 0 && prRefs.size === 0) return null;

  const matches = new Set<ThreadId>();
  for (const thread of input.threads) {
    if (thread.deletedAt !== null) continue;
    const jiraHit = thread.issues.some(
      (link) =>
        link.tracker === "jira" &&
        (input.jiraSiteHost === undefined || link.host.toLowerCase() === input.jiraSiteHost) &&
        jiraKeys.has(link.key.trim().toUpperCase()),
    );
    const prHit = thread.pullRequests.some(
      (link) =>
        link.source !== "stack-dismissed" &&
        prRefs.has(`${link.host}/${link.repository}/pull/${link.number}`.toLowerCase()),
    );
    if (jiraHit || prHit) matches.add(thread.id);
  }
  if (matches.size !== 1) return null;
  const [only] = matches;
  return only ?? null;
}
