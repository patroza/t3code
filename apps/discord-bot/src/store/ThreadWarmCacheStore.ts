// @effect-diagnostics globalErrorInEffectCatch:off globalErrorInEffectFailure:off preferSchemaOverJson:off tryCatchInEffectGen:off missingEffectError:off nodeBuiltinImport:off globalDate:off globalRandom:off globalDateInEffect:off
/**
 * Durable trimmed warm base for Discord bridge resume.
 *
 * Mirrors web/desktop EnvironmentCacheStore thread snapshots: keep a reduced
 * OrchestrationThread + snapshotSequence on disk so restart can
 * `subscribeThread({ afterSequence })` without re-downloading the full tip over HTTP.
 *
 * Storage: `$dataDir/thread-cache/<threadId>.json` (atomic write), same dataDir as links.json.
 */
import type { OrchestrationThread, ThreadId } from "@t3tools/contracts";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

export const THREAD_WARM_CACHE_VERSION = 1 as const;

export const WarmThreadCacheDocument = Schema.Struct({
  version: Schema.Literal(THREAD_WARM_CACHE_VERSION),
  threadId: Schema.String,
  snapshotSequence: Schema.Number,
  lastFinalizedAssistantId: Schema.NullOr(Schema.String),
  /** ISO timestamp of last successful write. */
  updatedAt: Schema.String,
  /**
   * Full OrchestrationThread JSON. Intentionally not Schema-validated field-by-field
   * (contracts evolve); structural checks happen in parseWarmThreadCacheDocument.
   */
  thread: Schema.Unknown,
});
export type WarmThreadCacheDocument = typeof WarmThreadCacheDocument.Type;

export type WarmThreadCacheEntry = {
  readonly threadId: ThreadId;
  readonly snapshotSequence: number;
  readonly lastFinalizedAssistantId: string | null;
  readonly updatedAt: string;
  readonly thread: OrchestrationThread;
};

const decodeDocument = Schema.decodeUnknownSync(WarmThreadCacheDocument);

function expandHome(path: string): string {
  if (path === "~") return NodeOS.homedir();
  if (path.startsWith("~/")) return NodePath.join(NodeOS.homedir(), path.slice(2));
  return path;
}

function safeThreadFileName(threadId: string): string {
  // Thread ids are UUIDs / opaque tokens; strip path separators just in case.
  return `${threadId.replaceAll(/[/\\]/gu, "_")}.json`;
}

export function parseWarmThreadCacheDocument(raw: unknown): WarmThreadCacheEntry | null {
  try {
    const doc = decodeDocument(raw);
    const thread = doc.thread as OrchestrationThread | null;
    if (thread === null || typeof thread !== "object") return null;
    if (typeof (thread as { id?: unknown }).id !== "string") return null;
    if (!Array.isArray((thread as { messages?: unknown }).messages)) return null;
    if (!Number.isFinite(doc.snapshotSequence) || doc.snapshotSequence < 0) return null;
    return {
      threadId: doc.threadId as ThreadId,
      snapshotSequence: doc.snapshotSequence,
      lastFinalizedAssistantId: doc.lastFinalizedAssistantId,
      updatedAt: doc.updatedAt,
      thread,
    };
  } catch {
    return null;
  }
}

/**
 * Whether a warm cache entry can seed subscribe without HTTP.
 * Requires a finite sequence (same bar as dual-cursor afterSequence).
 */
export function canResumeFromWarmThreadCache(entry: WarmThreadCacheEntry | null): boolean {
  return entry !== null && Number.isFinite(entry.snapshotSequence) && entry.snapshotSequence >= 0;
}

async function atomicWriteFile(filePath: string, contents: string): Promise<void> {
  const dir = NodePath.dirname(filePath);
  await NodeFSP.mkdir(dir, { recursive: true, mode: 0o700 });
  const tempPath = NodePath.join(
    dir,
    `.${NodePath.basename(filePath)}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
  );
  await NodeFSP.writeFile(tempPath, contents, { mode: 0o600 });
  await NodeFSP.rename(tempPath, filePath);
}

export interface ThreadWarmCacheStoreService {
  readonly load: (threadId: ThreadId | string) => Effect.Effect<WarmThreadCacheEntry | null>;
  readonly save: (input: {
    readonly threadId: ThreadId | string;
    readonly snapshotSequence: number;
    readonly thread: OrchestrationThread;
    readonly lastFinalizedAssistantId?: string | null;
  }) => Effect.Effect<void>;
  readonly remove: (threadId: ThreadId | string) => Effect.Effect<void>;
}

export class ThreadWarmCacheStore extends Context.Service<
  ThreadWarmCacheStore,
  ThreadWarmCacheStoreService
>()("@t3tools/discord-bot/store/ThreadWarmCacheStore") {}

export const makeThreadWarmCacheStore = (dataDirRaw: string) =>
  Effect.gen(function* () {
    const dataDir = expandHome(dataDirRaw);
    const cacheDir = NodePath.join(dataDir, "thread-cache");
    yield* Effect.promise(() => NodeFSP.mkdir(cacheDir, { recursive: true, mode: 0o700 }));
    const writeLock = yield* Semaphore.make(1);

    const pathFor = (threadId: string) => NodePath.join(cacheDir, safeThreadFileName(threadId));

    return ThreadWarmCacheStore.of({
      load: (threadId) =>
        Effect.tryPromise({
          try: async () => {
            const raw = await NodeFSP.readFile(pathFor(String(threadId)), "utf8");
            return parseWarmThreadCacheDocument(JSON.parse(raw) as unknown);
          },
          catch: () => null as WarmThreadCacheEntry | null,
        }).pipe(Effect.orElseSucceed(() => null)),

      save: (input) =>
        writeLock.withPermit(
          Effect.gen(function* () {
            if (!Number.isFinite(input.snapshotSequence) || input.snapshotSequence < 0) {
              return;
            }
            const doc: WarmThreadCacheDocument = {
              version: THREAD_WARM_CACHE_VERSION,
              threadId: String(input.threadId),
              snapshotSequence: input.snapshotSequence,
              lastFinalizedAssistantId: input.lastFinalizedAssistantId ?? null,
              updatedAt: new Date().toISOString(),
              thread: input.thread,
            };
            const body = `${JSON.stringify(doc)}\n`;
            yield* Effect.promise(() => atomicWriteFile(pathFor(String(input.threadId)), body));
          }),
        ),

      remove: (threadId) =>
        Effect.tryPromise({
          try: () => NodeFSP.unlink(pathFor(String(threadId))),
          catch: () => undefined,
        }).pipe(
          Effect.asVoid,
          Effect.orElseSucceed(() => undefined),
          Effect.asVoid,
        ),
    });
  });

export const layer = (dataDir: string) =>
  Layer.effect(ThreadWarmCacheStore, makeThreadWarmCacheStore(dataDir));
