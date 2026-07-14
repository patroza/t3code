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
import { ProviderSessionRuntimeRepository } from "../persistence/ProviderSessionRuntime.ts";
import { ProjectionThreadMessageRepository } from "../persistence/Services/ProjectionThreadMessages.ts";
import {
  planGrokBackfill,
  readGrokDisplayMessages,
  resolveGrokChatHistoryPath,
  type ExistingThreadMessage,
} from "./backfillGrokSession.ts";
import { stableUuid } from "./sqlite.ts";

const GROK_PROVIDER = "grok";

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

  const resyncThread = Effect.fn("GrokTranscriptResync.resyncThread")(function* (
    threadId: ThreadId,
  ) {
    const runtime = yield* runtimeRepository.getByThreadId({ threadId });
    if (Option.isNone(runtime) || runtime.value.providerName !== GROK_PROVIDER) {
      return;
    }
    // A running session is streaming over ACP right now; that stream is the
    // authority. Resyncing mid-turn would race it and could duplicate a message
    // whose streamed text is still partial.
    if (runtime.value.status === "running") {
      return;
    }
    const sessionId = readStringField(runtime.value.resumeCursor, "sessionId");
    const cwd = readStringField(runtime.value.runtimePayload, "cwd");
    if (sessionId === null || cwd === null) {
      return;
    }

    const grokMessages = readGrokDisplayMessages(resolveGrokChatHistoryPath({ cwd, sessionId }));
    if (grokMessages.length === 0) {
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

    const plan = planGrokBackfill({ grokMessages, existingMessages, sessionId });
    if (plan.error !== undefined || plan.newMessages.length === 0) {
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
