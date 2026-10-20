// @effect-diagnostics nodeBuiltinImport:off
/**
 * Look up an existing T3 thread by shared work-item identity (Jira key / GitHub PR).
 *
 * Sources are server `thread-work-items.json` rows written by a Jira or GitHub
 * webhook. Discord mentions and pin backfill are not identity.
 *
 * Discord does not join that thread. It points at the conversation and can
 * start a new one only when asked. `resolveUniqueT3ThreadIdForWorkItems` still
 * skips a thread that already has an active Discord link, for callers that
 * must not attach a second Discord thread to it.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { ThreadLink } from "./ThreadLinkStore.ts";

const FALSE_POSITIVE_JIRA_KEYS = new Set(["UTF-8", "ISO-8601", "HTTP-1", "HTTP-2", "TLS-1"]);

export function normalizeJiraIssueKey(raw: string): string | null {
  const key = raw.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9]{1,9}-\d{1,7}$/u.test(key)) return null;
  if (FALSE_POSITIVE_JIRA_KEYS.has(key)) return null;
  return key;
}

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

type ServerWorkItemRecord = {
  readonly threadId: string;
  readonly jiraIssueKeys?: ReadonlyArray<string>;
  readonly githubPullRequests?: ReadonlyArray<string>;
  readonly sources?: ReadonlyArray<string>;
};

const EXTERNAL_WORK_ITEM_SOURCES = new Set(["jira-webhook", "github-webhook"]);

function hasExternalWorkItemSource(sources: ReadonlyArray<string> | undefined): boolean {
  if (!Array.isArray(sources)) return false;
  return sources.some(
    (source) =>
      typeof source === "string" && EXTERNAL_WORK_ITEM_SOURCES.has(source.trim().toLowerCase()),
  );
}

function readServerWorkItemRecords(filePath: string): ReadonlyArray<ServerWorkItemRecord> {
  try {
    const raw = NodeFS.readFileSync(filePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return [];
    const records = (parsed as { records?: unknown }).records;
    if (!Array.isArray(records)) return [];
    return records.filter(
      (row): row is ServerWorkItemRecord =>
        row !== null &&
        typeof row === "object" &&
        typeof (row as ServerWorkItemRecord).threadId === "string",
    );
  } catch {
    return [];
  }
}

function externalWorkItemThreadIds(input: {
  readonly jiraIssueKeys: ReadonlyArray<string>;
  readonly prUrls: ReadonlyArray<string>;
  readonly serverWorkItemsPath: string;
  readonly excludedThreadIds?: ReadonlySet<string>;
}): Set<string> {
  const jiraKeys = [
    ...new Set(
      input.jiraIssueKeys
        .map((key) => normalizeJiraIssueKey(key))
        .filter((key): key is string => key !== null),
    ),
  ];
  const prRefs = [
    ...new Set(
      input.prUrls
        .map((url) => normalizeGitHubPullRequestRef(url))
        .filter((ref): ref is string => ref !== null),
    ),
  ];
  if (jiraKeys.length === 0 && prRefs.length === 0) return new Set();

  const threadIds = new Set<string>();
  const serverRecords = readServerWorkItemRecords(input.serverWorkItemsPath);
  for (const record of serverRecords) {
    if (!hasExternalWorkItemSource(record.sources)) continue;
    if (input.excludedThreadIds?.has(record.threadId) === true) continue;
    const recordKeys = new Set(
      (record.jiraIssueKeys ?? [])
        .map((key) => normalizeJiraIssueKey(key))
        .filter((key): key is string => key !== null),
    );
    const recordPrs = new Set(
      (record.githubPullRequests ?? [])
        .map((url) => normalizeGitHubPullRequestRef(url))
        .filter((ref): ref is string => ref !== null),
    );
    const jiraHit = jiraKeys.some((key) => recordKeys.has(key));
    const prHit = prRefs.some((ref) => recordPrs.has(ref));
    if (jiraHit || prHit) threadIds.add(record.threadId);
  }
  return threadIds;
}

function uniqueThreadId(threadIds: ReadonlySet<string>): ThreadId | null {
  if (threadIds.size !== 1) return null;
  const [only] = threadIds;
  return (only ?? null) as ThreadId | null;
}

/**
 * Return a unique T3 thread id if the given Jira keys / PR URLs map to exactly one thread
 * that Jira or GitHub recorded. Fail closed on zero or many matches.
 * Discord-only rows do not count. A thread that already has an active Discord link
 * is excluded so a second Discord thread is not attached to it.
 */
export function resolveUniqueT3ThreadIdForWorkItems(input: {
  readonly jiraIssueKeys: ReadonlyArray<string>;
  readonly prUrls: ReadonlyArray<string>;
  readonly discordLinks: ReadonlyArray<ThreadLink>;
  readonly serverWorkItemsPath: string;
}): ThreadId | null {
  const discordLinkedThreadIds = new Set<string>(
    input.discordLinks
      .filter((link) => link.status === "active" && (link.sourceKind ?? "discord") === "discord")
      .map((link) => link.t3ThreadId),
  );
  return uniqueThreadId(
    externalWorkItemThreadIds({
      jiraIssueKeys: input.jiraIssueKeys,
      prUrls: input.prUrls,
      serverWorkItemsPath: input.serverWorkItemsPath,
      excludedThreadIds: discordLinkedThreadIds,
    }),
  );
}

/**
 * The one T3 thread Jira or GitHub recorded for these keys, including a thread
 * that already has a Discord home. Null when none or more than one match.
 * Discord uses this to link the existing conversation instead of joining it.
 */
export function findUniqueExternalWorkItemThread(input: {
  readonly jiraIssueKeys: ReadonlyArray<string>;
  readonly prUrls: ReadonlyArray<string>;
  readonly serverWorkItemsPath: string;
}): ThreadId | null {
  return uniqueThreadId(
    externalWorkItemThreadIds({
      jiraIssueKeys: input.jiraIssueKeys,
      prUrls: input.prUrls,
      serverWorkItemsPath: input.serverWorkItemsPath,
    }),
  );
}

export function serverWorkItemsPathFromStateSqlite(stateSqlitePath: string): string {
  return NodePath.join(NodePath.dirname(stateSqlitePath), "thread-work-items.json");
}

export const resolveUniqueT3ThreadIdForWorkItemsEffect = (input: {
  readonly jiraIssueKeys: ReadonlyArray<string>;
  readonly prUrls: ReadonlyArray<string>;
  readonly discordLinks: ReadonlyArray<ThreadLink>;
  readonly serverWorkItemsPath: string;
}) => Effect.sync(() => resolveUniqueT3ThreadIdForWorkItems(input));
