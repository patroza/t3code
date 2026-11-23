/**
 * Jira issue keys on a GitHub PR mention: found in the PR title and the comment, they let the
 * bridge join the thread a Jira issue is already linked to, and get linked onto the PR's main
 * thread so later Jira and Discord mentions land on the same thread.
 */
import type { OrchestrationV2ThreadShell, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  JIRA_ISSUE_TRACKER_KIND,
  jiraIssueBrowseUrl,
  jiraSiteHost,
  jiraThreadIssueKey,
} from "../jira/jiraIssueLinks.ts";
import { ThreadIssueService } from "../orchestration-v2/ThreadIssueService.ts";

const JIRA_KEY_PATTERN = /^[A-Z][A-Z0-9]{1,9}-\d{1,7}$/u;
const BARE_KEY_PATTERN = /\b([A-Z][A-Z0-9]{1,9}-\d{1,7})\b/gu;
const BROWSE_URL_PATTERN =
  /https?:\/\/[^\s<>"']+\.atlassian\.net\/(?:browse|jira\/browse)\/([A-Z][A-Z0-9]{1,9}-\d{1,7})/giu;
const SELECTED_ISSUE_PATTERN = /[?&]selectedIssue=([A-Z][A-Z0-9]{1,9}-\d{1,7})\b/giu;
// Tokens shaped like a key that are never Jira issues.
const FALSE_POSITIVE_KEYS = new Set(["UTF-8", "ISO-8601", "HTTP-1", "HTTP-2", "TLS-1"]);

function normalizeJiraIssueKey(raw: string): string | null {
  const key = raw.trim().toUpperCase();
  return JIRA_KEY_PATTERN.test(key) && !FALSE_POSITIVE_KEYS.has(key) ? key : null;
}

function jiraProjectKeyOf(issueKey: string): string {
  return issueKey.slice(0, issueKey.lastIndexOf("-"));
}

/**
 * Jira keys in the PR title and the mention comment, first seen first. An Atlassian link counts
 * for any project; bare `PROJ-123` text counts only for the repo's t3.json `jiraProjects`.
 */
export function extractGitHubJiraIssueKeys(
  invocation: { readonly pullRequestTitle: string; readonly prompt: string },
  bareKeyProjects: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const text = `${invocation.pullRequestTitle}\n${invocation.prompt}`;
  const projects = new Set(bareKeyProjects.map((project) => project.trim().toUpperCase()));
  const hits: Array<{ readonly index: number; readonly key: string }> = [];
  const collect = (pattern: RegExp, bare: boolean) => {
    for (const match of text.matchAll(pattern)) {
      const key = normalizeJiraIssueKey(match[1] ?? "");
      if (key === null || (bare && !projects.has(jiraProjectKeyOf(key)))) continue;
      hits.push({ index: match.index, key });
    }
  };
  collect(BROWSE_URL_PATTERN, false);
  collect(SELECTED_ISSUE_PATTERN, false);
  collect(BARE_KEY_PATTERN, true);
  hits.sort((left, right) => left.index - right.index);
  return [...new Set(hits.map((hit) => hit.key))];
}

type BridgeThreadCandidate = Pick<OrchestrationV2ThreadShell, "archivedAt" | "lineage">;

/** Archived threads, side chats, and subagents never take a bridged mention. */
export function isJoinableBridgeThread(thread: BridgeThreadCandidate): boolean {
  return (
    thread.archivedAt === null &&
    thread.lineage.sideChat !== true &&
    thread.lineage.relationshipToParent !== "subagent"
  );
}

export type JiraLinkedThreadSelection<T> =
  | { readonly _tag: "none" }
  | { readonly _tag: "ambiguous"; readonly threadIds: ReadonlyArray<ThreadId> }
  | { readonly _tag: "linked"; readonly thread: T };

/**
 * The one joinable thread linked to any of these Jira keys. Links match on key, and on the Jira
 * site host when one is configured, since a key names an issue only within one site. Several
 * matching threads are ambiguous: the bridge does not guess.
 */
export function selectJiraLinkedThread<
  T extends BridgeThreadCandidate & Pick<OrchestrationV2ThreadShell, "id" | "issues">,
>(
  threads: ReadonlyArray<T>,
  issueKeys: ReadonlyArray<string>,
  siteHost: string | undefined,
): JiraLinkedThreadSelection<T> {
  const keys = new Set(issueKeys);
  if (keys.size === 0) return { _tag: "none" };
  const matches = threads.filter(
    (thread) =>
      isJoinableBridgeThread(thread) &&
      (thread.issues ?? []).some(
        (link) =>
          link.tracker === JIRA_ISSUE_TRACKER_KIND &&
          (siteHost === undefined || link.host.toLowerCase() === siteHost) &&
          keys.has(link.key.trim().toUpperCase()),
      ),
  );
  if (matches.length === 0) return { _tag: "none" };
  if (matches.length > 1) {
    return { _tag: "ambiguous", threadIds: matches.map((thread) => thread.id) };
  }
  return { _tag: "linked", thread: matches[0]! };
}

/** The Jira site the Jira bridge links issues under, from the same variables it reads. */
export const githubJiraSiteUrl = Config.String("T3CODE_JIRA_SITE_URL").pipe(
  Config.orElse(() => Config.String("T3CODE_JIRA_URL")),
  Config.orElse(() => Config.String("JIRA_URL")),
  Config.option,
  Config.map((value) => Option.getOrUndefined(Option.filter(value, (url) => url.trim() !== ""))),
);

export function githubJiraSiteHost(siteUrl: string | undefined): string | undefined {
  if (siteUrl === undefined) return undefined;
  try {
    return jiraSiteHost(siteUrl.trim());
  } catch {
    return undefined;
  }
}

/** Links each issue to the thread as the Jira bridge would; already linked is a no-op. */
export const linkJiraIssuesToThread = Effect.fn("GitHubPrBridge.linkJiraIssuesToThread")(
  function* (input: {
    readonly threadId: ThreadId;
    readonly projectId: ProjectId;
    readonly issueKeys: ReadonlyArray<string>;
    readonly siteUrl: string | undefined;
  }) {
    if (input.issueKeys.length === 0) return;
    const siteUrl = input.siteUrl?.trim();
    if (siteUrl === undefined || githubJiraSiteHost(siteUrl) === undefined) {
      yield* Effect.logInfo("No Jira site configured; not linking PR Jira keys to the thread", {
        threadId: input.threadId,
        issueKeys: input.issueKeys,
      });
      return;
    }
    const threadIssues = yield* ThreadIssueService;
    for (const issueKey of input.issueKeys) {
      yield* threadIssues
        .link({
          threadId: input.threadId,
          ref: {
            ...jiraThreadIssueKey({ siteUrl, issueKey, projectKey: jiraProjectKeyOf(issueKey) }),
            projectId: input.projectId,
          },
          url: jiraIssueBrowseUrl(siteUrl, issueKey),
          displayKey: issueKey,
          title: issueKey,
          source: "agent",
        })
        .pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Could not link the PR's Jira issue to its thread", {
              threadId: input.threadId,
              issueKey,
              cause,
            }),
          ),
        );
    }
  },
);
