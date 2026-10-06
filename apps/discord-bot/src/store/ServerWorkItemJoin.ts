// @effect-diagnostics nodeBuiltinImport:off
/**
 * Join an existing T3 thread by shared work-item identity (Jira key / GitHub PR)
 * before Discord creates a new session.
 *
 * Sources:
 * - Server `thread-work-items.json` next to state.sqlite (Jira/GitHub bridges)
 *
 * Active Discord links are exclusions: one T3 thread must never be implicitly
 * joined from more than one Discord thread.
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
};

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

/**
 * True when every Discord row for this T3 thread lists the key as pin-backfill
 * only, and none lists it as link identity. Those keys stay on the pin and must
 * not join a thread.
 */
export function jiraKeyBlockedByPinBackfill(input: {
  readonly discordLinks: ReadonlyArray<
    Pick<ThreadLink, "t3ThreadId" | "linkedJiraIssueKeys" | "backfillJiraIssueKeys">
  >;
  readonly t3ThreadId: string;
  readonly issueKey: string;
}): boolean {
  const issueKey = input.issueKey.trim().toUpperCase();
  if (issueKey.length === 0) return false;
  let backfill = false;
  let linked = false;
  for (const link of input.discordLinks) {
    if (link.t3ThreadId !== input.t3ThreadId) continue;
    if ((link.linkedJiraIssueKeys ?? []).some((key) => key.trim().toUpperCase() === issueKey)) {
      linked = true;
    }
    if ((link.backfillJiraIssueKeys ?? []).some((key) => key.trim().toUpperCase() === issueKey)) {
      backfill = true;
    }
  }
  return backfill && !linked;
}

/**
 * Return a unique T3 thread id if the given Jira keys / PR URLs map to exactly one thread.
 * Fail closed on zero or many matches.
 * Pin-backfill keys do not count as a match.
 */
export function resolveUniqueT3ThreadIdForWorkItems(input: {
  readonly jiraIssueKeys: ReadonlyArray<string>;
  readonly prUrls: ReadonlyArray<string>;
  readonly discordLinks: ReadonlyArray<ThreadLink>;
  readonly serverWorkItemsPath: string;
}): ThreadId | null {
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
  if (jiraKeys.length === 0 && prRefs.length === 0) return null;

  const threadIds = new Set<string>();
  const discordLinkedThreadIds = new Set<string>(
    input.discordLinks
      .filter((link) => link.status === "active" && (link.sourceKind ?? "discord") === "discord")
      .map((link) => link.t3ThreadId),
  );

  const serverRecords = readServerWorkItemRecords(input.serverWorkItemsPath);
  for (const record of serverRecords) {
    if (discordLinkedThreadIds.has(record.threadId)) continue;
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
    const jiraHit = jiraKeys.some(
      (key) =>
        recordKeys.has(key) &&
        !jiraKeyBlockedByPinBackfill({
          discordLinks: input.discordLinks,
          t3ThreadId: record.threadId,
          issueKey: key,
        }),
    );
    const prHit = prRefs.some((ref) => recordPrs.has(ref));
    if (jiraHit || prHit) threadIds.add(record.threadId);
  }

  if (threadIds.size !== 1) return null;
  const [only] = threadIds;
  return only as ThreadId;
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
