/**
 * Server-native associations between T3 threads and external work items
 * (Jira issue keys, GitHub PR URLs).
 *
 * Source of truth for inbound bridges (Jira mentions, future GitHub lookup aids).
 * Not limited to Discord — Discord may still mirror keys for pin UX, and its
 * links.json can be imported as a migration/fallback source.
 */

import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import { ServerConfig } from "../config.ts";

const FALSE_POSITIVE_JIRA_KEYS = new Set(["UTF-8", "ISO-8601", "HTTP-1", "HTTP-2", "TLS-1"]);

export function normalizeJiraIssueKey(raw: string): string | null {
  const key = raw.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9]{1,9}-\d{1,7}$/u.test(key)) return null;
  if (FALSE_POSITIVE_JIRA_KEYS.has(key)) return null;
  return key;
}

/** Normalize a GitHub PR URL or `owner/repo#n` form to a stable key. */
export function normalizeGitHubPullRequestRef(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  const urlMatch = trimmed.match(
    /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/[^?\s]*)?(?:[?#]\S*)?$/iu,
  );
  if (urlMatch) {
    const owner = urlMatch[1]!.toLowerCase();
    const repo = urlMatch[2]!.toLowerCase();
    const number = urlMatch[3]!;
    return `github.com/${owner}/${repo}/pull/${number}`;
  }

  const shortMatch = trimmed.match(/^([^/\s]+)\/([^#\s]+)#(\d+)$/u);
  if (shortMatch) {
    const owner = shortMatch[1]!.toLowerCase();
    const repo = shortMatch[2]!.toLowerCase();
    const number = shortMatch[3]!;
    return `github.com/${owner}/${repo}/pull/${number}`;
  }

  return null;
}

export function mergeOrderedUnique(
  existing: ReadonlyArray<string> | null | undefined,
  incoming: ReadonlyArray<string> | null | undefined,
  normalize: (raw: string) => string | null,
): ReadonlyArray<string> {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const raw of [...(existing ?? []), ...(incoming ?? [])]) {
    const key = normalize(raw);
    if (key === null || seen.has(key)) continue;
    seen.add(key);
    result.push(key);
  }
  return result;
}

export type WorkItemLookupResult =
  | { readonly _tag: "unlinked" }
  | { readonly _tag: "ambiguous"; readonly threadIds: ReadonlyArray<ThreadId> }
  | { readonly _tag: "linked"; readonly threadId: ThreadId };

export const ThreadWorkItemRecord = Schema.Struct({
  threadId: Schema.String,
  jiraIssueKeys: Schema.Array(Schema.String),
  githubPullRequests: Schema.Array(Schema.String),
  /** Optional sources that contributed (discord, jira-webhook, github-webhook, manual). */
  sources: Schema.optional(Schema.Array(Schema.String)),
  updatedAt: Schema.String,
});
export type ThreadWorkItemRecord = {
  readonly threadId: ThreadId;
  readonly jiraIssueKeys: ReadonlyArray<string>;
  readonly githubPullRequests: ReadonlyArray<string>;
  readonly sources: ReadonlyArray<string>;
  readonly updatedAt: string;
};

const ThreadWorkItemFile = Schema.Struct({
  version: Schema.Number,
  records: Schema.Array(ThreadWorkItemRecord),
});

const decodeFile = Schema.decodeUnknownSync(Schema.fromJsonString(ThreadWorkItemFile));

const DiscordThreadLink = Schema.Struct({
  t3ThreadId: Schema.String,
  status: Schema.optional(Schema.String),
  jiraIssueKeys: Schema.optional(Schema.Array(Schema.String)),
  prUrls: Schema.optional(Schema.Array(Schema.String)),
});
const DiscordLinksFile = Schema.Struct({
  version: Schema.optional(Schema.Number),
  links: Schema.Array(DiscordThreadLink),
});
const decodeDiscordLinks = Schema.decodeUnknownSync(Schema.fromJsonString(DiscordLinksFile));

function parseDiscordLinksOrEmpty(linksJson: string): ReadonlyArray<typeof DiscordThreadLink.Type> {
  try {
    return decodeDiscordLinks(linksJson).links;
  } catch {
    return [];
  }
}

export class ThreadWorkItemStore extends Context.Service<
  ThreadWorkItemStore,
  {
    readonly getByThreadId: (threadId: ThreadId) => Effect.Effect<ThreadWorkItemRecord | null>;
    readonly list: () => Effect.Effect<ReadonlyArray<ThreadWorkItemRecord>>;
    readonly appendForThread: (input: {
      readonly threadId: ThreadId;
      readonly jiraIssueKeys?: ReadonlyArray<string>;
      readonly githubPullRequests?: ReadonlyArray<string>;
      readonly source: string;
    }) => Effect.Effect<ThreadWorkItemRecord>;
    readonly resolveJiraIssue: (issueKey: string) => Effect.Effect<WorkItemLookupResult>;
    readonly resolveGitHubPullRequest: (prRef: string) => Effect.Effect<WorkItemLookupResult>;
    /**
     * Import associations from a Discord bot links.json (active links only).
     * Merges into the server store without removing existing entries.
     */
    readonly importDiscordLinksJson: (linksJson: string) => Effect.Effect<{
      readonly threadsTouched: number;
      readonly jiraKeysAdded: number;
      readonly prsAdded: number;
    }>;
  }
>()("t3/workItems/ThreadWorkItemStore") {}

function emptyRecord(threadId: ThreadId, updatedAt: string): ThreadWorkItemRecord {
  return {
    threadId,
    jiraIssueKeys: [],
    githubPullRequests: [],
    sources: [],
    updatedAt,
  };
}

function resolveKey(
  records: ReadonlyMap<string, ThreadWorkItemRecord>,
  match: (record: ThreadWorkItemRecord) => boolean,
): WorkItemLookupResult {
  const matches = new Set<string>();
  for (const record of records.values()) {
    if (!match(record)) continue;
    matches.add(record.threadId);
  }
  if (matches.size === 0) return { _tag: "unlinked" };
  if (matches.size > 1) {
    return { _tag: "ambiguous", threadIds: [...matches] as ThreadId[] };
  }
  const [only] = matches;
  return { _tag: "linked", threadId: only as ThreadId };
}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const filePath = path.join(config.stateDir, "thread-work-items.json");

  const initial = yield* fileSystem.readFileString(filePath).pipe(
    Effect.map((raw) => {
      try {
        const decoded = decodeFile(raw);
        return decoded.records.map(
          (record): ThreadWorkItemRecord => ({
            threadId: record.threadId as ThreadId,
            jiraIssueKeys: mergeOrderedUnique([], record.jiraIssueKeys, normalizeJiraIssueKey),
            githubPullRequests: mergeOrderedUnique(
              [],
              record.githubPullRequests,
              normalizeGitHubPullRequestRef,
            ),
            sources: record.sources ?? [],
            updatedAt: record.updatedAt,
          }),
        );
      } catch {
        return [];
      }
    }),
    Effect.orElseSucceed((): ThreadWorkItemRecord[] => []),
  );

  const state = yield* Ref.make(
    new Map(initial.map((record) => [record.threadId, record] as const)),
  );
  const lock = yield* Semaphore.make(1);

  const persist = (records: ReadonlyMap<string, ThreadWorkItemRecord>) => {
    const retained = [...records.values()].sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt),
    );
    return writeFileStringAtomically({
      filePath,
      contents: `${JSON.stringify({ version: 1, records: retained }, null, 2)}\n`,
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.orDie,
    );
  };

  return ThreadWorkItemStore.of({
    getByThreadId: (threadId) =>
      Ref.get(state).pipe(Effect.map((records) => records.get(threadId) ?? null)),

    list: () => Ref.get(state).pipe(Effect.map((records) => [...records.values()])),

    appendForThread: (input) =>
      lock.withPermit(
        Effect.gen(function* () {
          const now = DateTime.formatIso(yield* DateTime.now);
          const next = yield* Ref.updateAndGet(state, (records) => {
            const existing = records.get(input.threadId) ?? emptyRecord(input.threadId, now);
            const jiraIssueKeys = mergeOrderedUnique(
              existing.jiraIssueKeys,
              input.jiraIssueKeys,
              normalizeJiraIssueKey,
            );
            const githubPullRequests = mergeOrderedUnique(
              existing.githubPullRequests,
              input.githubPullRequests,
              normalizeGitHubPullRequestRef,
            );
            const sources = mergeOrderedUnique(existing.sources, [input.source], (raw) => {
              const value = raw.trim().toLowerCase();
              return value.length > 0 ? value : null;
            });
            const updated: ThreadWorkItemRecord = {
              threadId: input.threadId,
              jiraIssueKeys,
              githubPullRequests,
              sources,
              updatedAt: now,
            };
            const copy = new Map(records);
            copy.set(input.threadId, updated);
            return copy;
          });
          yield* persist(next);
          return next.get(input.threadId)!;
        }),
      ),

    resolveJiraIssue: (issueKey) =>
      Ref.get(state).pipe(
        Effect.map((records) => {
          const normalized = normalizeJiraIssueKey(issueKey);
          if (normalized === null) return { _tag: "unlinked" as const };
          return resolveKey(records, (record) => record.jiraIssueKeys.includes(normalized));
        }),
      ),

    resolveGitHubPullRequest: (prRef) =>
      Ref.get(state).pipe(
        Effect.map((records) => {
          const normalized = normalizeGitHubPullRequestRef(prRef);
          if (normalized === null) return { _tag: "unlinked" as const };
          return resolveKey(records, (record) => record.githubPullRequests.includes(normalized));
        }),
      ),

    importDiscordLinksJson: (linksJson) =>
      lock.withPermit(
        Effect.gen(function* () {
          const links = parseDiscordLinksOrEmpty(linksJson);
          if (links.length === 0) {
            return { threadsTouched: 0, jiraKeysAdded: 0, prsAdded: 0 };
          }

          const now = DateTime.formatIso(yield* DateTime.now);
          let threadsTouched = 0;
          let jiraKeysAdded = 0;
          let prsAdded = 0;

          const next = yield* Ref.updateAndGet(state, (records) => {
            const copy = new Map(records);
            for (const link of links) {
              if (link.status !== undefined && link.status !== "active") continue;
              const threadId = link.t3ThreadId.trim() as ThreadId;
              if (threadId.length === 0) continue;

              const existing = copy.get(threadId) ?? emptyRecord(threadId, now);
              const beforeJira = existing.jiraIssueKeys.length;
              const beforePr = existing.githubPullRequests.length;
              const jiraIssueKeys = mergeOrderedUnique(
                existing.jiraIssueKeys,
                link.jiraIssueKeys,
                normalizeJiraIssueKey,
              );
              const githubPullRequests = mergeOrderedUnique(
                existing.githubPullRequests,
                link.prUrls,
                normalizeGitHubPullRequestRef,
              );
              const sources = mergeOrderedUnique(existing.sources, ["discord"], (raw) => {
                const value = raw.trim().toLowerCase();
                return value.length > 0 ? value : null;
              });

              if (
                jiraIssueKeys.length === beforeJira &&
                githubPullRequests.length === beforePr &&
                copy.has(threadId)
              ) {
                continue;
              }

              jiraKeysAdded += jiraIssueKeys.length - beforeJira;
              prsAdded += githubPullRequests.length - beforePr;
              threadsTouched += 1;
              copy.set(threadId, {
                threadId,
                jiraIssueKeys,
                githubPullRequests,
                sources,
                updatedAt: now,
              });
            }
            return copy;
          });

          if (threadsTouched > 0) yield* persist(next);
          return { threadsTouched, jiraKeysAdded, prsAdded };
        }),
      ),
  });
});

export const layer = Layer.effect(ThreadWorkItemStore, make);

/** Pure helper for tests / Discord fallback without the Effect store. */
export function resolveJiraIssueFromRecords(
  records: ReadonlyArray<Pick<ThreadWorkItemRecord, "threadId" | "jiraIssueKeys">>,
  issueKey: string,
): WorkItemLookupResult {
  const normalized = normalizeJiraIssueKey(issueKey);
  if (normalized === null) return { _tag: "unlinked" };
  const map = new Map(
    records.map((record) => [
      record.threadId,
      {
        threadId: record.threadId,
        jiraIssueKeys: record.jiraIssueKeys,
        githubPullRequests: [] as string[],
        sources: [] as string[],
        updatedAt: "",
      } satisfies ThreadWorkItemRecord,
    ]),
  );
  return resolveKey(map, (record) => record.jiraIssueKeys.includes(normalized));
}
