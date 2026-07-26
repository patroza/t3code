// @effect-diagnostics globalErrorInEffectCatch:off globalErrorInEffectFailure:off preferSchemaOverJson:off tryCatchInEffectGen:off missingEffectError:off nodeBuiltinImport:off globalDate:off
import type { ProjectId, ThreadId } from "@t3tools/contracts";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

export const LINKS_DOCUMENT_VERSION = 2 as const;

export const ThreadLinkStatus = Schema.Literals(["active", "tombstone"]);
export type ThreadLinkStatus = typeof ThreadLinkStatus.Type;

/**
 * Durable Discord ↔ T3 link (links.json v2).
 *
 * Keeps existing Discord-bot fields (threadTalkMode, task/stream/sent message ids)
 * and adds restore hints (activity, tombstone, last finalized assistant).
 */
export const ThreadLink = Schema.Struct({
  discordThreadId: Schema.String,
  t3ThreadId: Schema.String,
  projectId: Schema.String,
  channelId: Schema.String,
  guildId: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  lastActivityAt: Schema.String,
  status: ThreadLinkStatus,
  lastSeenTurnId: Schema.NullOr(Schema.String),
  lastFinalizedAssistantId: Schema.NullOr(Schema.String),
  /**
   * Last applied orchestration event/snapshot sequence for this linked T3 thread.
   * Scalar marker only — we never persist pre-sync event history. Used with
   * `lastDeliveredSequence` to resume `subscribeThread({ afterSequence })` without
   * re-walking the whole event log. Advances when T3 state is observed (WS/HTTP), not
   * when Discord I/O finishes. Partial bridge hint writes must not clear this.
   * Optional in schema so older links.json rows still decode (default null).
   */
  lastThreadSnapshotSequence: Schema.optional(Schema.NullOr(Schema.Number)),
  /**
   * Last orchestration sequence that was successfully applied to Discord
   * (stream tip and/or finalize path finished without fatal process failure).
   * Scalar marker only (not message/event history). Resume prefers this cursor
   * (minus a small buffer) so already-synced sequences are not re-read.
   * May lag `lastThreadSnapshotSequence` when Discord I/O is slow/hung or the
   * process dies mid-delivery. Used for HTTP reconcile + rehydrate catch-up.
   * Optional for older links.json rows (default null = unknown).
   */
  lastDeliveredSequence: Schema.optional(Schema.NullOr(Schema.Number)),
  threadTalkMode: Schema.optional(Schema.Literal("all-messages")),
  taskDiscordMessageId: Schema.optional(Schema.String),
  /** In-progress Discord stream tip ids (+ stale tips). Deleted on finalize / restart cleanup. */
  streamDiscordMessageIds: Schema.optional(Schema.Array(Schema.String)),
  sentDiscordUserMessageIds: Schema.optional(Schema.Array(Schema.String)),
  /**
   * Jira issue keys observed for this Discord thread, in first-seen order (no duplicates).
   * Surfaced on the pinned thread-info message.
   */
  jiraIssueKeys: Schema.optional(Schema.Array(Schema.String)),
  /**
   * GitHub pull request URLs observed for this Discord thread, in first-seen order
   * (canonical https://github.com/owner/repo/pull/N, no duplicates).
   * Surfaced on the pinned thread-info message next to Jira.
   */
  prUrls: Schema.optional(Schema.Array(Schema.String)),
  /** Discord message id of the pinned Model / worktree / Open in Omegent / Jira / PRs info message. */
  infoDiscordMessageId: Schema.optional(Schema.String),
  /** First model used when this Discord↔T3 link was created (`instanceId/model`). */
  initialModelLine: Schema.optional(Schema.String),
  /** Last known model on the linked T3 thread (`instanceId/model`). */
  currentModelLine: Schema.optional(Schema.String),
  /**
   * When `currentModelLine` became active if it differs from `initialModelLine`
   * (ISO timestamp). Cleared when current matches initial.
   */
  modelSinceAt: Schema.optional(Schema.String),
});
export type ThreadLink = {
  readonly discordThreadId: string;
  readonly t3ThreadId: ThreadId;
  readonly projectId: ProjectId;
  readonly channelId: string;
  readonly guildId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastActivityAt: string;
  readonly status: ThreadLinkStatus;
  readonly lastSeenTurnId: string | null;
  readonly lastFinalizedAssistantId: string | null;
  readonly lastThreadSnapshotSequence: number | null;
  readonly lastDeliveredSequence: number | null;
  readonly threadTalkMode?: "all-messages" | undefined;
  readonly taskDiscordMessageId?: string | undefined;
  readonly streamDiscordMessageIds?: ReadonlyArray<string> | undefined;
  readonly sentDiscordUserMessageIds?: ReadonlyArray<string> | undefined;
  readonly jiraIssueKeys?: ReadonlyArray<string> | undefined;
  readonly prUrls?: ReadonlyArray<string> | undefined;
  readonly infoDiscordMessageId?: string | undefined;
  readonly initialModelLine?: string | undefined;
  readonly currentModelLine?: string | undefined;
  readonly modelSinceAt?: string | undefined;
};

/** Fields callers may omit on put — filled with durable defaults. */
export type ThreadLinkInput = {
  readonly discordThreadId: string;
  readonly t3ThreadId: ThreadId;
  readonly projectId: ProjectId;
  readonly channelId: string;
  readonly guildId: string;
  readonly createdAt: string;
  readonly updatedAt?: string;
  readonly lastActivityAt?: string;
  readonly status?: ThreadLinkStatus;
  readonly lastSeenTurnId?: string | null;
  readonly lastFinalizedAssistantId?: string | null;
  readonly lastThreadSnapshotSequence?: number | null;
  readonly lastDeliveredSequence?: number | null;
  readonly threadTalkMode?: "all-messages" | undefined;
  readonly taskDiscordMessageId?: string | undefined;
  readonly streamDiscordMessageIds?: ReadonlyArray<string> | undefined;
  readonly sentDiscordUserMessageIds?: ReadonlyArray<string> | undefined;
  readonly jiraIssueKeys?: ReadonlyArray<string> | undefined;
  readonly prUrls?: ReadonlyArray<string> | undefined;
  readonly infoDiscordMessageId?: string | undefined;
  readonly initialModelLine?: string | undefined;
  readonly currentModelLine?: string | undefined;
  readonly modelSinceAt?: string | undefined;
};

/** Partial durable bridge hints written while streaming / finalizing. */
export type ThreadLinkBridgeHints = {
  readonly lastSeenTurnId?: string | null;
  readonly lastFinalizedAssistantId?: string | null;
  readonly lastThreadSnapshotSequence?: number | null;
  readonly lastDeliveredSequence?: number | null;
  readonly streamDiscordMessageIds?: ReadonlyArray<string>;
};

export type ThreadLinkModelHistory = {
  readonly initialModelLine?: string | null | undefined;
  readonly currentModelLine?: string | null | undefined;
  readonly modelSinceAt?: string | null | undefined;
};

const LinksDocumentV2 = Schema.Struct({
  version: Schema.Literal(LINKS_DOCUMENT_VERSION),
  links: Schema.Array(ThreadLink),
});

const decodeLinksArray = Schema.decodeUnknownSync(Schema.Array(ThreadLink));
const decodeLinksDocumentV2 = Schema.decodeUnknownSync(LinksDocumentV2);

/** Legacy v1 link (pre-restore fields). Extra keys are ignored by the decoder. */
const ThreadLinkV1 = Schema.Struct({
  discordThreadId: Schema.String,
  t3ThreadId: Schema.String,
  projectId: Schema.String,
  channelId: Schema.String,
  guildId: Schema.String,
  createdAt: Schema.String,
  threadTalkMode: Schema.optional(Schema.Literal("all-messages")),
  taskDiscordMessageId: Schema.optional(Schema.String),
  streamDiscordMessageIds: Schema.optional(Schema.Array(Schema.String)),
  sentDiscordUserMessageIds: Schema.optional(Schema.Array(Schema.String)),
  jiraIssueKeys: Schema.optional(Schema.Array(Schema.String)),
  prUrls: Schema.optional(Schema.Array(Schema.String)),
  infoDiscordMessageId: Schema.optional(Schema.String),
});
const decodeLinksV1 = Schema.decodeUnknownSync(Schema.Array(ThreadLinkV1));

function nowIso(): string {
  return new Date().toISOString();
}

/** First-seen order, case-normalized uppercase, no duplicates. */
function mergeJiraKeysOrdered(
  existing: ReadonlyArray<string> | null | undefined,
  incoming: ReadonlyArray<string> | null | undefined,
): ReadonlyArray<string> {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const raw of [...(existing ?? []), ...(incoming ?? [])]) {
    const key = raw.trim().toUpperCase();
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    result.push(key);
  }
  return result;
}

/**
 * First-seen order for GitHub PR URLs. Light normalize: trim, strip query/hash/subpaths,
 * lowercase host path for dedup key. Full URL validation lives in presentation/prLinks.
 */
function mergePrUrlsOrdered(
  existing: ReadonlyArray<string> | null | undefined,
  incoming: ReadonlyArray<string> | null | undefined,
): ReadonlyArray<string> {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const raw of [...(existing ?? []), ...(incoming ?? [])]) {
    const normalized = normalizeStoredPrUrl(raw);
    if (normalized === null || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function normalizeStoredPrUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const match =
    /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)(?:\/[^?#]*)?(?:[?#].*)?$/iu.exec(
      trimmed,
    );
  if (match === null) return null;
  const owner = (match[1] ?? "").toLowerCase();
  const repo = (match[2] ?? "").replace(/\.git$/iu, "").toLowerCase();
  const number = match[3] ?? "";
  if (owner.length === 0 || repo.length === 0 || number.length === 0) return null;
  return `https://github.com/${owner}/${repo}/pull/${number}`;
}

function asThreadLink(link: {
  readonly discordThreadId: string;
  readonly t3ThreadId: string;
  readonly projectId: string;
  readonly channelId: string;
  readonly guildId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastActivityAt: string;
  readonly status: ThreadLinkStatus;
  readonly lastSeenTurnId: string | null;
  readonly lastFinalizedAssistantId: string | null;
  readonly lastThreadSnapshotSequence?: number | null | undefined;
  readonly lastDeliveredSequence?: number | null | undefined;
  readonly threadTalkMode?: "all-messages" | undefined;
  readonly taskDiscordMessageId?: string | undefined;
  readonly streamDiscordMessageIds?: ReadonlyArray<string> | undefined;
  readonly sentDiscordUserMessageIds?: ReadonlyArray<string> | undefined;
  readonly jiraIssueKeys?: ReadonlyArray<string> | undefined;
  readonly prUrls?: ReadonlyArray<string> | undefined;
  readonly infoDiscordMessageId?: string | undefined;
  readonly initialModelLine?: string | undefined;
  readonly currentModelLine?: string | undefined;
  readonly modelSinceAt?: string | undefined;
}): ThreadLink {
  return {
    discordThreadId: link.discordThreadId,
    t3ThreadId: link.t3ThreadId as ThreadId,
    projectId: link.projectId as ProjectId,
    channelId: link.channelId,
    guildId: link.guildId,
    createdAt: link.createdAt,
    updatedAt: link.updatedAt,
    lastActivityAt: link.lastActivityAt,
    status: link.status,
    lastSeenTurnId: link.lastSeenTurnId,
    lastFinalizedAssistantId: link.lastFinalizedAssistantId,
    lastThreadSnapshotSequence: link.lastThreadSnapshotSequence ?? null,
    lastDeliveredSequence: link.lastDeliveredSequence ?? null,
    threadTalkMode: link.threadTalkMode,
    taskDiscordMessageId: link.taskDiscordMessageId,
    streamDiscordMessageIds: link.streamDiscordMessageIds,
    sentDiscordUserMessageIds: link.sentDiscordUserMessageIds,
    jiraIssueKeys: link.jiraIssueKeys,
    prUrls: link.prUrls,
    infoDiscordMessageId: link.infoDiscordMessageId,
    initialModelLine: link.initialModelLine,
    currentModelLine: link.currentModelLine,
    modelSinceAt: link.modelSinceAt,
  };
}

/** Migrate a bare v1 array entry to full v2 shape. */
export function migrateV1Link(link: {
  readonly discordThreadId: string;
  readonly t3ThreadId: string;
  readonly projectId: string;
  readonly channelId: string;
  readonly guildId: string;
  readonly createdAt: string;
  readonly threadTalkMode?: "all-messages" | undefined;
  readonly taskDiscordMessageId?: string | undefined;
  readonly streamDiscordMessageIds?: ReadonlyArray<string> | undefined;
  readonly sentDiscordUserMessageIds?: ReadonlyArray<string> | undefined;
  readonly jiraIssueKeys?: ReadonlyArray<string> | undefined;
  readonly prUrls?: ReadonlyArray<string> | undefined;
  readonly infoDiscordMessageId?: string | undefined;
  readonly initialModelLine?: string | undefined;
  readonly currentModelLine?: string | undefined;
  readonly modelSinceAt?: string | undefined;
}): ThreadLink {
  return asThreadLink({
    discordThreadId: link.discordThreadId,
    t3ThreadId: link.t3ThreadId,
    projectId: link.projectId,
    channelId: link.channelId,
    guildId: link.guildId,
    createdAt: link.createdAt,
    updatedAt: link.createdAt,
    lastActivityAt: link.createdAt,
    status: "active",
    lastSeenTurnId: null,
    lastFinalizedAssistantId: null,
    lastThreadSnapshotSequence: null,
    lastDeliveredSequence: null,
    threadTalkMode: link.threadTalkMode,
    taskDiscordMessageId: link.taskDiscordMessageId,
    streamDiscordMessageIds: link.streamDiscordMessageIds,
    sentDiscordUserMessageIds: link.sentDiscordUserMessageIds,
    jiraIssueKeys: link.jiraIssueKeys,
    prUrls: link.prUrls,
    infoDiscordMessageId: link.infoDiscordMessageId,
    initialModelLine: link.initialModelLine,
    currentModelLine: link.currentModelLine,
    modelSinceAt: link.modelSinceAt,
  });
}

export function normalizeThreadLinkInput(link: ThreadLinkInput): ThreadLink {
  const createdAt = link.createdAt;
  return asThreadLink({
    discordThreadId: link.discordThreadId,
    t3ThreadId: link.t3ThreadId,
    projectId: link.projectId,
    channelId: link.channelId,
    guildId: link.guildId,
    createdAt,
    updatedAt: link.updatedAt ?? createdAt,
    lastActivityAt: link.lastActivityAt ?? createdAt,
    status: link.status ?? "active",
    lastSeenTurnId: link.lastSeenTurnId ?? null,
    lastFinalizedAssistantId: link.lastFinalizedAssistantId ?? null,
    lastThreadSnapshotSequence: link.lastThreadSnapshotSequence ?? null,
    lastDeliveredSequence: link.lastDeliveredSequence ?? null,
    threadTalkMode: link.threadTalkMode,
    taskDiscordMessageId: link.taskDiscordMessageId,
    streamDiscordMessageIds: link.streamDiscordMessageIds,
    sentDiscordUserMessageIds: link.sentDiscordUserMessageIds,
    jiraIssueKeys: link.jiraIssueKeys,
    prUrls: link.prUrls,
    infoDiscordMessageId: link.infoDiscordMessageId,
    initialModelLine: link.initialModelLine,
    currentModelLine: link.currentModelLine,
    modelSinceAt: link.modelSinceAt,
  });
}

/**
 * Parse links.json (v1 bare array or v2 document). Corrupt / unknown → empty list.
 * Exported for unit tests.
 */
export function parseLinksDocument(raw: unknown): {
  readonly version: typeof LINKS_DOCUMENT_VERSION;
  readonly links: ReadonlyArray<ThreadLink>;
  readonly migratedFromV1: boolean;
} {
  if (Array.isArray(raw)) {
    try {
      // Prefer strict v2 array decode (if someone wrote plain array of v2 objects).
      try {
        const v2Array = decodeLinksArray(raw);
        return {
          version: LINKS_DOCUMENT_VERSION,
          links: v2Array.map((link) => asThreadLink(link)),
          migratedFromV1: false,
        };
      } catch {
        const v1 = decodeLinksV1(raw);
        return {
          version: LINKS_DOCUMENT_VERSION,
          links: v1.map(migrateV1Link),
          migratedFromV1: true,
        };
      }
    } catch {
      return { version: LINKS_DOCUMENT_VERSION, links: [], migratedFromV1: false };
    }
  }

  if (raw !== null && typeof raw === "object") {
    try {
      const doc = decodeLinksDocumentV2(raw);
      return {
        version: LINKS_DOCUMENT_VERSION,
        links: doc.links.map((link) => asThreadLink(link)),
        migratedFromV1: false,
      };
    } catch {
      return { version: LINKS_DOCUMENT_VERSION, links: [], migratedFromV1: false };
    }
  }

  return { version: LINKS_DOCUMENT_VERSION, links: [], migratedFromV1: false };
}

function serializeLinksDocument(links: ReadonlyArray<ThreadLink>): string {
  return `${JSON.stringify(
    {
      version: LINKS_DOCUMENT_VERSION,
      links: [...links],
    },
    null,
    2,
  )}\n`;
}

export interface ThreadLinkStoreService {
  readonly getByDiscordThreadId: (discordThreadId: string) => Effect.Effect<ThreadLink | null>;
  readonly getByT3ThreadId: (t3ThreadId: string) => Effect.Effect<ThreadLink | null>;
  readonly put: (link: ThreadLinkInput) => Effect.Effect<void>;
  readonly touch: (discordThreadId: string, at?: string) => Effect.Effect<ThreadLink | null>;
  readonly tombstone: (discordThreadId: string) => Effect.Effect<ThreadLink | null>;
  readonly updateBridgeHints: (
    discordThreadId: string,
    partial: ThreadLinkBridgeHints,
  ) => Effect.Effect<ThreadLink | null>;
  readonly setThreadTalkMode: (
    discordThreadId: string,
    mode: "all-messages" | null,
  ) => Effect.Effect<void>;
  readonly setTaskDiscordMessageId: (
    discordThreadId: string,
    taskDiscordMessageId: string | null,
  ) => Effect.Effect<void>;
  readonly setStreamDiscordMessageIds: (
    discordThreadId: string,
    streamDiscordMessageIds: ReadonlyArray<string>,
  ) => Effect.Effect<void>;
  readonly setSentDiscordUserMessageIds: (
    discordThreadId: string,
    sentDiscordUserMessageIds: ReadonlyArray<string>,
  ) => Effect.Effect<void>;
  /** Merge newly observed Jira keys in first-seen order (no duplicates). */
  readonly appendJiraIssueKeys: (
    discordThreadId: string,
    jiraIssueKeys: ReadonlyArray<string>,
  ) => Effect.Effect<ThreadLink | null>;
  readonly setJiraIssueKeys: (
    discordThreadId: string,
    jiraIssueKeys: ReadonlyArray<string>,
  ) => Effect.Effect<ThreadLink | null>;
  /** Merge newly observed GitHub PR URLs in first-seen order (no duplicates). */
  readonly appendPrUrls: (
    discordThreadId: string,
    prUrls: ReadonlyArray<string>,
  ) => Effect.Effect<ThreadLink | null>;
  readonly setPrUrls: (
    discordThreadId: string,
    prUrls: ReadonlyArray<string>,
  ) => Effect.Effect<ThreadLink | null>;
  readonly setInfoDiscordMessageId: (
    discordThreadId: string,
    infoDiscordMessageId: string | null,
  ) => Effect.Effect<void>;
  readonly setModelHistory: (
    discordThreadId: string,
    history: ThreadLinkModelHistory,
  ) => Effect.Effect<ThreadLink | null>;
  readonly list: () => Effect.Effect<ReadonlyArray<ThreadLink>>;
}

export class ThreadLinkStore extends Context.Service<ThreadLinkStore, ThreadLinkStoreService>()(
  "@t3tools/discord-bot/store/ThreadLinkStore",
) {}

function expandHome(path: string): string {
  if (path === "~") return NodeOS.homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return NodePath.join(NodeOS.homedir(), path.slice(2));
  }
  return path;
}

async function atomicWriteFile(filePath: string, contents: string): Promise<void> {
  const dir = NodePath.dirname(filePath);
  const tempPath = NodePath.join(
    dir,
    `.${NodePath.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  await NodeFSP.writeFile(tempPath, contents, { mode: 0o600 });
  await NodeFSP.rename(tempPath, filePath);
}

export const makeThreadLinkStore = (dataDirRaw: string) =>
  Effect.gen(function* () {
    const dataDir = expandHome(dataDirRaw);
    const filePath = NodePath.join(dataDir, "links.json");
    yield* Effect.promise(() => NodeFSP.mkdir(dataDir, { recursive: true, mode: 0o700 }));

    // Missing/unreadable file is fine (first run). Effect async failures are not JS throwables,
    // so recover with orElseSucceed rather than try/catch around yield*.
    const loaded = yield* Effect.tryPromise({
      try: () => NodeFSP.readFile(filePath, "utf8"),
      catch: () => "unreadable" as const,
    }).pipe(
      Effect.map((raw) => {
        try {
          return parseLinksDocument(JSON.parse(raw) as unknown);
        } catch {
          return parseLinksDocument(null);
        }
      }),
      Effect.orElseSucceed(() => parseLinksDocument(null)),
    );

    const state = yield* Ref.make(
      new Map(loaded.links.map((link) => [link.discordThreadId, link] as const)),
    );

    // Persist migrated v1 → v2 so the next boot does not re-migrate.
    if (loaded.migratedFromV1 && loaded.links.length > 0) {
      yield* Effect.promise(() => atomicWriteFile(filePath, serializeLinksDocument(loaded.links)));
    }

    const persist = (map: Map<string, ThreadLink>) =>
      Effect.promise(() => atomicWriteFile(filePath, serializeLinksDocument([...map.values()])));

    // Serialize mutate+persist so concurrent hint writers cannot flush a stale map
    // over a newer in-memory state (stream ids vs sequence marker, etc.).
    const writeLock = yield* Semaphore.make(1);

    const updateLink = (
      discordThreadId: string,
      mutate: (current: ThreadLink) => ThreadLink,
    ): Effect.Effect<ThreadLink | null> =>
      writeLock.withPermit(
        Effect.gen(function* () {
          let updated: ThreadLink | null = null;
          const next = yield* Ref.updateAndGet(state, (map) => {
            const current = map.get(discordThreadId);
            if (current === undefined) return map;
            updated = mutate(current);
            const copy = new Map(map);
            copy.set(discordThreadId, updated);
            return copy;
          });
          if (updated === null) return null;
          yield* persist(next);
          return updated;
        }),
      );

    return ThreadLinkStore.of({
      getByDiscordThreadId: (discordThreadId) =>
        Ref.get(state).pipe(Effect.map((map) => map.get(discordThreadId) ?? null)),

      getByT3ThreadId: (t3ThreadId) =>
        Ref.get(state).pipe(
          Effect.map((map) => {
            for (const link of map.values()) {
              if (link.t3ThreadId === t3ThreadId) return link;
            }
            return null;
          }),
        ),

      put: (link) =>
        writeLock.withPermit(
          Effect.gen(function* () {
            const normalized = normalizeThreadLinkInput(link);
            const next = yield* Ref.updateAndGet(state, (map) => {
              const existing = map.get(normalized.discordThreadId);
              // Preserve durable bridge hints when callers re-put a minimal link.
              const merged =
                existing === undefined
                  ? normalized
                  : asThreadLink({
                      ...normalized,
                      // Never wipe durable hints on a minimal re-put (overlapping writers).
                      lastFinalizedAssistantId:
                        link.lastFinalizedAssistantId !== undefined
                          ? normalized.lastFinalizedAssistantId
                          : existing.lastFinalizedAssistantId,
                      lastSeenTurnId:
                        link.lastSeenTurnId !== undefined
                          ? normalized.lastSeenTurnId
                          : existing.lastSeenTurnId,
                      lastThreadSnapshotSequence:
                        link.lastThreadSnapshotSequence !== undefined
                          ? normalized.lastThreadSnapshotSequence
                          : existing.lastThreadSnapshotSequence,
                      lastDeliveredSequence:
                        link.lastDeliveredSequence !== undefined
                          ? normalized.lastDeliveredSequence
                          : existing.lastDeliveredSequence,
                      streamDiscordMessageIds:
                        link.streamDiscordMessageIds !== undefined
                          ? normalized.streamDiscordMessageIds
                          : existing.streamDiscordMessageIds,
                      taskDiscordMessageId:
                        link.taskDiscordMessageId !== undefined
                          ? normalized.taskDiscordMessageId
                          : existing.taskDiscordMessageId,
                      threadTalkMode:
                        link.threadTalkMode !== undefined
                          ? normalized.threadTalkMode
                          : existing.threadTalkMode,
                      sentDiscordUserMessageIds:
                        link.sentDiscordUserMessageIds !== undefined
                          ? normalized.sentDiscordUserMessageIds
                          : existing.sentDiscordUserMessageIds,
                      jiraIssueKeys:
                        link.jiraIssueKeys !== undefined
                          ? normalized.jiraIssueKeys
                          : existing.jiraIssueKeys,
                      prUrls: link.prUrls !== undefined ? normalized.prUrls : existing.prUrls,
                      infoDiscordMessageId:
                        link.infoDiscordMessageId !== undefined
                          ? normalized.infoDiscordMessageId
                          : existing.infoDiscordMessageId,
                      initialModelLine:
                        link.initialModelLine !== undefined
                          ? normalized.initialModelLine
                          : existing.initialModelLine,
                      currentModelLine:
                        link.currentModelLine !== undefined
                          ? normalized.currentModelLine
                          : existing.currentModelLine,
                      modelSinceAt:
                        link.modelSinceAt !== undefined
                          ? normalized.modelSinceAt
                          : existing.modelSinceAt,
                      lastActivityAt: normalized.lastActivityAt,
                      updatedAt: nowIso(),
                    });
              const copy = new Map(map);
              copy.set(merged.discordThreadId, merged);
              return copy;
            });
            yield* persist(next);
          }),
        ),

      touch: (discordThreadId, at) => {
        const when = at ?? nowIso();
        return updateLink(discordThreadId, (current) => ({
          ...current,
          lastActivityAt: when,
          updatedAt: when,
        }));
      },

      tombstone: (discordThreadId) => {
        const when = nowIso();
        return updateLink(discordThreadId, (current) => ({
          ...current,
          status: "tombstone",
          updatedAt: when,
        }));
      },

      updateBridgeHints: (discordThreadId, partial) => {
        const when = nowIso();
        return updateLink(discordThreadId, (current) => ({
          ...current,
          updatedAt: when,
          lastActivityAt: when,
          ...(partial.lastSeenTurnId !== undefined
            ? { lastSeenTurnId: partial.lastSeenTurnId }
            : {}),
          ...(partial.lastFinalizedAssistantId !== undefined
            ? { lastFinalizedAssistantId: partial.lastFinalizedAssistantId }
            : {}),
          ...(partial.lastThreadSnapshotSequence !== undefined
            ? { lastThreadSnapshotSequence: partial.lastThreadSnapshotSequence }
            : {}),
          ...(partial.lastDeliveredSequence !== undefined
            ? { lastDeliveredSequence: partial.lastDeliveredSequence }
            : {}),
          ...(partial.streamDiscordMessageIds !== undefined
            ? {
                streamDiscordMessageIds:
                  partial.streamDiscordMessageIds.length > 0
                    ? [...new Set(partial.streamDiscordMessageIds.filter((id) => id.trim() !== ""))]
                    : undefined,
              }
            : {}),
        }));
      },

      setThreadTalkMode: (discordThreadId, mode) =>
        updateLink(discordThreadId, (existing) => ({
          ...existing,
          threadTalkMode: mode ?? undefined,
          updatedAt: nowIso(),
        })).pipe(Effect.asVoid),

      setTaskDiscordMessageId: (discordThreadId, taskDiscordMessageId) =>
        updateLink(discordThreadId, (existing) => ({
          ...existing,
          taskDiscordMessageId: taskDiscordMessageId ?? undefined,
          updatedAt: nowIso(),
        })).pipe(Effect.asVoid),

      setStreamDiscordMessageIds: (discordThreadId, streamDiscordMessageIds) => {
        const normalizedIds = [
          ...new Set(streamDiscordMessageIds.filter((id) => id.trim() !== "")),
        ];
        return updateLink(discordThreadId, (existing) => ({
          ...existing,
          streamDiscordMessageIds: normalizedIds.length > 0 ? normalizedIds : undefined,
          updatedAt: nowIso(),
          lastActivityAt: nowIso(),
        })).pipe(Effect.asVoid);
      },

      setSentDiscordUserMessageIds: (discordThreadId, sentDiscordUserMessageIds) => {
        const normalizedIds = [
          ...new Set(sentDiscordUserMessageIds.filter((id) => id.trim() !== "")),
        ];
        return updateLink(discordThreadId, (existing) => ({
          ...existing,
          sentDiscordUserMessageIds: normalizedIds.length > 0 ? normalizedIds : undefined,
          updatedAt: nowIso(),
        })).pipe(Effect.asVoid);
      },

      appendJiraIssueKeys: (discordThreadId, jiraIssueKeys) =>
        updateLink(discordThreadId, (existing) => {
          const merged = mergeJiraKeysOrdered(existing.jiraIssueKeys, jiraIssueKeys);
          if (
            merged.length === (existing.jiraIssueKeys?.length ?? 0) &&
            merged.every((key, index) => key === existing.jiraIssueKeys?.[index])
          ) {
            return existing;
          }
          return {
            ...existing,
            jiraIssueKeys: merged.length > 0 ? merged : undefined,
            updatedAt: nowIso(),
          };
        }),

      setJiraIssueKeys: (discordThreadId, jiraIssueKeys) =>
        updateLink(discordThreadId, (existing) => {
          const merged = mergeJiraKeysOrdered([], jiraIssueKeys);
          return {
            ...existing,
            jiraIssueKeys: merged.length > 0 ? merged : undefined,
            updatedAt: nowIso(),
          };
        }),

      appendPrUrls: (discordThreadId, prUrls) =>
        updateLink(discordThreadId, (existing) => {
          const merged = mergePrUrlsOrdered(existing.prUrls, prUrls);
          if (
            merged.length === (existing.prUrls?.length ?? 0) &&
            merged.every((url, index) => url === existing.prUrls?.[index])
          ) {
            return existing;
          }
          return {
            ...existing,
            prUrls: merged.length > 0 ? merged : undefined,
            updatedAt: nowIso(),
          };
        }),

      setPrUrls: (discordThreadId, prUrls) =>
        updateLink(discordThreadId, (existing) => {
          const merged = mergePrUrlsOrdered([], prUrls);
          return {
            ...existing,
            prUrls: merged.length > 0 ? merged : undefined,
            updatedAt: nowIso(),
          };
        }),

      setInfoDiscordMessageId: (discordThreadId, infoDiscordMessageId) =>
        updateLink(discordThreadId, (existing) => ({
          ...existing,
          infoDiscordMessageId: infoDiscordMessageId ?? undefined,
          updatedAt: nowIso(),
        })).pipe(Effect.asVoid),

      setModelHistory: (discordThreadId, history) =>
        updateLink(discordThreadId, (existing) => ({
          ...existing,
          initialModelLine:
            history.initialModelLine === undefined
              ? existing.initialModelLine
              : (history.initialModelLine ?? undefined),
          currentModelLine:
            history.currentModelLine === undefined
              ? existing.currentModelLine
              : (history.currentModelLine ?? undefined),
          modelSinceAt:
            history.modelSinceAt === undefined
              ? existing.modelSinceAt
              : (history.modelSinceAt ?? undefined),
          updatedAt: nowIso(),
        })),

      list: () => Ref.get(state).pipe(Effect.map((map) => [...map.values()])),
    });
  });

export const layer = (dataDir: string) =>
  Layer.effect(ThreadLinkStore, makeThreadLinkStore(dataDir));
