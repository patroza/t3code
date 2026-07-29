// @effect-diagnostics nodeBuiltinImport:off
/**
 * Detects that a grok session's own log has run ahead of the T3 thread and
 * dispatches a resync.
 *
 * A grok session can advance without T3 seeing it: the ACP stream can drop
 * updates, or the session can be driven from another grok client entirely. Grok
 * records every message to its `updates.jsonl` regardless of who drives it, so
 * that log — not T3's transcript — is the authority on what was said.
 *
 * This runs when a client opens a thread. Dispatching (rather than writing the
 * projection) is what makes it visible: the event flows through the projector
 * and out to every subscriber, so an open thread heals in place.
 */
import * as NodeFSP from "node:fs/promises";

import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import {
  CommandId,
  MessageId,
  TurnId,
  type OrchestrationMessage,
  type ThreadId,
} from "@t3tools/contracts";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { OrphanSessionRecovery } from "../orchestration/Services/OrphanSessionRecovery.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderSessionRuntimeRepository } from "../persistence/ProviderSessionRuntime.ts";
import { ProjectionThreadMessageRepository } from "../persistence/Services/ProjectionThreadMessages.ts";
import {
  planGrokBackfill,
  readGrokDisplayMessagesTail,
  resolveGrokChatHistoryPath,
  type ExistingThreadMessage,
  type GrokDisplayMessage,
} from "./backfillGrokSession.ts";
import { stableUuid } from "./sqlite.ts";

const GROK_PROVIDER = "grok";

/**
 * How much of the tail of `updates.jsonl` to read, widening only if the anchor
 * is not in the smaller window.
 *
 * These logs are overwhelmingly tool-call traffic and grow without bound: a 150MB
 * log measured here held ~140 transcript messages, i.e. roughly **one message per
 * MB**. Windows must be sized against that density, not against intuition — on
 * that file a 512KB tail contained zero messages, while 4MB held 8 (11ms) and
 * 32MB held 43 (81ms). 4MB therefore covers an in-sync thread, whose anchor is
 * its newest message.
 *
 * We stop at the second window rather than falling back to the whole file: this
 * runs on thread open, and no UI interaction should pay a multi-hundred-MB read
 * (that cost ~570ms of blocked event loop). A thread stale beyond the last window
 * is left to the `backfill-grok` CLI, which is offline and may read everything.
 */
const TAIL_WINDOW_BYTES = [4 * 1024 * 1024, 32 * 1024 * 1024] as const;

interface LogFingerprint {
  readonly mtimeMs: number;
  readonly size: number;
}

function readStringField(value: unknown, field: string): string | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const raw = (value as Record<string, unknown>)[field];
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

export class GrokTranscriptResync extends Context.Service<
  GrokTranscriptResync,
  {
    /**
     * Bring the thread's transcript up to date with the grok session log.
     *
     * Best-effort and side-effect free when there is nothing to do. Never fails:
     * a thread must still open if its provider log is unreadable.
     */
    readonly resyncThread: (threadId: ThreadId) => Effect.Effect<void>;
  }
>()("t3/externalSessions/GrokTranscriptResync") {}

export const make = Effect.gen(function* () {
  const runtimeRepository = yield* ProviderSessionRuntimeRepository;
  const messageRepository = yield* ProjectionThreadMessageRepository;
  const orchestrationEngine = yield* OrchestrationEngineService;
  // Per-thread fingerprint of the grok log as of the last check, so an unchanged
  // log costs one stat() instead of a read. In-memory: losing it on restart just
  // means one extra read per thread.
  const lastSeenLog = new Map<string, LogFingerprint>();
  const orphanSessionRecovery = yield* OrphanSessionRecovery;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;

  const resyncThread = Effect.fn("GrokTranscriptResync.resyncThread")(function* (
    threadId: ThreadId,
  ) {
    const runtime = yield* runtimeRepository.getByThreadId({ threadId });
    if (Option.isNone(runtime) || runtime.value.providerName !== GROK_PROVIDER) {
      return;
    }

    // Only skip resync while a *live* process is mid-turn. Grok routinely keeps
    // a process + `provider_session_runtime.status=running` after the turn
    // settles (`session.status=ready`) so the next prompt is fast — that idle
    // hold must NOT block catching up external CLI activity from updates.jsonl.
    //
    // Mid-turn with no live process is a zombie: settle it, then resync.
    const shell = yield* projectionSnapshotQuery.getThreadShellById(threadId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.orElseSucceed(() => undefined),
    );
    const session = shell?.session ?? null;
    const midTurn = session?.status === "running" && session.activeTurnId !== null;
    if (midTurn) {
      const live = yield* orphanSessionRecovery.hasLiveProcess(threadId);
      if (live) {
        return;
      }
      yield* orphanSessionRecovery.settleIfOrphan(threadId, "resync_zombie_running");
    }

    const sessionId = readStringField(runtime.value.resumeCursor, "sessionId");
    const cwd = readStringField(runtime.value.runtimePayload, "cwd");
    if (sessionId === null || cwd === null) {
      return;
    }

    const updatesPath = resolveGrokChatHistoryPath({ cwd, sessionId });

    // Nothing can have been appended since we last looked, so there is nothing to
    // catch up on. Thread opens are frequent and this is the common case, so it
    // must cost a stat() rather than a read.
    const stats = yield* Effect.tryPromise(() => NodeFSP.stat(updatesPath)).pipe(
      Effect.option,
      Effect.map(Option.getOrUndefined),
    );
    if (!stats) {
      return;
    }
    const fingerprint: LogFingerprint = { mtimeMs: stats.mtimeMs, size: stats.size };
    const seen = lastSeenLog.get(threadId);
    if (seen && seen.mtimeMs === fingerprint.mtimeMs && seen.size === fingerprint.size) {
      return;
    }

    const existingMessages: ReadonlyArray<ExistingThreadMessage> =
      (yield* messageRepository.listByThreadId({ threadId })).map((row) => ({
        messageId: row.messageId,
        role: row.role,
        text: row.text,
        turnId: row.turnId,
        attachmentsJson: JSON.stringify(row.attachments ?? []),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      }));

    // Widen only on a miss: a plan error here means the anchor was not inside the
    // window, which is indistinguishable from "the anchor is older than what we
    // read". Anything else (including "nothing new") is a final answer.
    let plan: ReturnType<typeof planGrokBackfill> | undefined;
    for (const windowBytes of TAIL_WINDOW_BYTES) {
      const grokMessages = yield* Effect.tryPromise(() =>
        readGrokDisplayMessagesTail(updatesPath, windowBytes),
      ).pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<GrokDisplayMessage>));
      if (grokMessages.length === 0) {
        continue;
      }
      plan = planGrokBackfill({ grokMessages, existingMessages, sessionId });
      if (plan.error === undefined) {
        break;
      }
      if (windowBytes >= fingerprint.size) {
        // We already had the whole file; a wider window cannot help.
        break;
      }
    }

    // Record the fingerprint regardless of outcome: re-reading an unchanged file
    // would reach the same conclusion, including "the anchor is too far back".
    lastSeenLog.set(threadId, fingerprint);

    if (!plan || plan.error !== undefined || plan.newMessages.length === 0) {
      return;
    }

    const now = yield* DateTime.now;
    // Derived from the resync's content, not a fresh uuid: several clients can
    // open the same thread at once and each compute this identical plan before
    // any of their dispatches lands. A stable id lets command-receipt dedup
    // collapse those into one event instead of a burst of identical ones.
    const commandId = stableUuid(
      "grok-resync",
      `${threadId}:${plan.anchorMessageId ?? "*"}:${plan.tail.map((m) => m.messageId).join(",")}`,
    );
    yield* orchestrationEngine.dispatch({
      type: "thread.messages.resync",
      commandId: CommandId.make(`grok-resync:${commandId}`),
      threadId,
      afterMessageId: plan.anchorMessageId === null ? null : MessageId.make(plan.anchorMessageId),
      messages: plan.tail.map(
        (message) =>
          ({
            id: MessageId.make(message.messageId),
            role: message.role,
            text: message.text,
            turnId: message.turnId === null ? null : TurnId.make(message.turnId),
            streaming: false,
            createdAt: message.createdAt,
            updatedAt: message.updatedAt,
          }) satisfies OrchestrationMessage,
      ),
      reason: `grok-session:${sessionId}`,
      createdAt: DateTime.formatIso(now),
    });
    yield* Effect.logInfo("Resynced grok transcript from the session log.", {
      threadId,
      sessionId,
      added: plan.newMessages.length,
    });
  });

  return {
    // Opening a thread must never fail because its provider log is unreadable or
    // a resync races something else, so swallow everything here.
    resyncThread: (threadId: ThreadId) =>
      resyncThread(threadId).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Failed to resync grok transcript.", { threadId, cause }),
        ),
      ),
  } satisfies GrokTranscriptResync["Service"];
});

export const GrokTranscriptResyncLive = Layer.effect(GrokTranscriptResync, make);
