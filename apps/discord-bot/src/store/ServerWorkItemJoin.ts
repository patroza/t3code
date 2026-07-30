// @effect-diagnostics nodeBuiltinImport:off
/**
 * Join an existing T3 thread by shared work-item identity (Jira key / GitHub PR)
 * before Discord creates a new session.
 *
 * Sources (in order):
 * 1. Discord bot links.json (other channels already bound to a T3 thread)
 * 2. Server `thread-work-items.json` next to state.sqlite (Jira/GitHub bridges)
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
 * Return a unique T3 thread id if the given Jira keys / PR URLs map to exactly one thread.
 * Fail closed on zero or many matches.
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

  for (const link of input.discordLinks) {
    if (link.status !== undefined && link.status !== "active") continue;
    const linkKeys = (link.jiraIssueKeys ?? [])
      .map((key) => normalizeJiraIssueKey(key))
      .filter((key): key is string => key !== null);
    const linkPrs = (link.prUrls ?? [])
      .map((url) => normalizeGitHubPullRequestRef(url))
      .filter((ref): ref is string => ref !== null);
    const jiraHit = jiraKeys.some((key) => linkKeys.includes(key));
    const prHit = prRefs.some((ref) => linkPrs.includes(ref));
    if (jiraHit || prHit) threadIds.add(link.t3ThreadId);
  }

  const serverRecords = readServerWorkItemRecords(input.serverWorkItemsPath);
  for (const record of serverRecords) {
    const recordKeys = (record.jiraIssueKeys ?? [])
      .map((key) => normalizeJiraIssueKey(key))
      .filter((key): key is string => key !== null);
    const recordPrs = (record.githubPullRequests ?? [])
      .map((url) => normalizeGitHubPullRequestRef(url))
      .filter((ref): ref is string => ref !== null);
    const jiraHit = jiraKeys.some((key) => recordKeys.includes(key));
    const prHit = prRefs.some((ref) => recordPrs.includes(ref));
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
