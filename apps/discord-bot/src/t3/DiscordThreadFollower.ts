// @effect-diagnostics anyUnknownInErrorContext:off missingEffectError:off
/**
 * Headless orchestration-thread follower for the Discord bot.
 *
 * Intentionally mirrors packages/client-runtime EnvironmentThreadState apply/reload
 * semantics (sequence cursor, snapshot seed, reload-required → HTTP) without pulling
 * in EnvironmentSupervisor / Atom / React. Core packages stay untouched; Discord only
 * adapts the same reducer + transport patterns clients already use.
 *
 * Source of truth for event application: `applyThreadDetailEvent` from
 * `@t3tools/client-runtime/state/threads` (re-export of threadReducer).
 *
 * Discord-specific projection (ResponseBridge tips / finalize) sits *on top* of this
 * follower — same split as web: runtime holds OrchestrationThread, UI/surface paints it.
 */

import type {
  OrchestrationThread,
  OrchestrationThreadDetailSnapshot,
  OrchestrationThreadStreamItem,
} from "@t3tools/contracts";
import { applyThreadDetailEvent } from "@t3tools/client-runtime/state/threads";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";

import { formatAlertCause } from "../features/Alerts.ts";

/** Same short retry clients use for expected stream failures (`retryExpectedFailureAfter`). */
export const DISCORD_THREAD_SUBSCRIBE_RETRY_DELAY = "250 millis" as const;

/** Cap reconnect backoff when the whole subscription dies (session drop, etc.). */
export const DISCORD_THREAD_SUBSCRIBE_MAX_BACKOFF = "30 seconds" as const;

/**
 * How to seed the follower after a transport death.
 *
 * - `resume-after` — we already applied a tip this process; only WS after lastSequence
 *   (do **not** re-deliver a stale in-memory warm tip — that re-finalized old Discord posts).
 * - `replay-warm` — first seed this process; paint durable warm tip once.
 * - `http-or-cold` — no warm tip; HTTP snapshot or wait for stream.
 */
export type ThreadFollowerReconnectSeedPlan = "resume-after" | "replay-warm" | "http-or-cold";

export function planThreadFollowerReconnectSeed(input: {
  /** Last sequence successfully applied this process (−1 = never). */
  readonly lastAppliedSequence: number;
  readonly hasWarmSeed: boolean;
}): ThreadFollowerReconnectSeedPlan {
  if (Number.isFinite(input.lastAppliedSequence) && input.lastAppliedSequence >= 0) {
    return "resume-after";
  }
  if (input.hasWarmSeed) return "replay-warm";
  return "http-or-cold";
}

export type DiscordThreadFollowerState = {
  readonly current: OrchestrationThread | null;
  /** Last applied snapshot/event sequence (−1 = no base yet). */
  readonly lastSequence: number;
};

export type DiscordThreadFollowerApplyResult =
  | {
      readonly _tag: "deliver";
      readonly state: DiscordThreadFollowerState;
      readonly thread: OrchestrationThread;
      readonly sequence: number;
    }
  | {
      readonly _tag: "none";
      readonly state: DiscordThreadFollowerState;
    }
  | {
      readonly _tag: "deleted";
      readonly state: DiscordThreadFollowerState;
      readonly sequence: number;
    }
  | {
      readonly _tag: "reload-required";
      readonly state: DiscordThreadFollowerState;
      readonly sequence: number;
      readonly eventType: string;
    };

export function initialDiscordThreadFollowerState(
  seed?: Partial<DiscordThreadFollowerState>,
): DiscordThreadFollowerState {
  return {
    current: seed?.current ?? null,
    lastSequence: seed?.lastSequence ?? -1,
  };
}

/**
 * Pure apply step — parity with EnvironmentThreadState.applyItem
 * (packages/client-runtime/src/state/threads.ts).
 */
export function applyDiscordThreadStreamItem(
  state: DiscordThreadFollowerState,
  item: OrchestrationThreadStreamItem,
): DiscordThreadFollowerApplyResult {
  if (item.kind === "snapshot") {
    const sequence = item.snapshot.snapshotSequence;
    const thread = item.snapshot.thread;
    return {
      _tag: "deliver",
      state: { current: thread, lastSequence: sequence },
      thread,
      sequence,
    };
  }

  if (item.kind === "synchronized") {
    return { _tag: "none", state };
  }

  const sequence = item.event.sequence;
  if (sequence <= state.lastSequence) {
    return { _tag: "none", state };
  }

  if (state.current === null) {
    // Event before we hold a transcript — caller must HTTP-seed (same as client).
    return {
      _tag: "reload-required",
      state: { ...state, lastSequence: sequence },
      sequence,
      eventType: item.event.type,
    };
  }

  const result = applyThreadDetailEvent(state.current, item.event);
  if (result.kind === "updated") {
    return {
      _tag: "deliver",
      state: { current: result.thread, lastSequence: sequence },
      thread: result.thread,
      sequence,
    };
  }
  if (result.kind === "deleted") {
    return {
      _tag: "deleted",
      state: { current: null, lastSequence: sequence },
      sequence,
    };
  }
  if (result.kind === "reload-required") {
    return {
      _tag: "reload-required",
      state: { ...state, lastSequence: sequence },
      sequence,
      eventType: item.event.type,
    };
  }
  // unchanged — advance sequence so we do not re-apply
  return {
    _tag: "none",
    state: { ...state, lastSequence: sequence },
  };
}

export type FollowOrchestrationThreadInput = {
  readonly threadId: string;
  /**
   * Open a WS subscribeThread stream. May end with failure (transport drop);
   * the follower retries.
   */
  readonly openStream: (input: {
    readonly afterSequence: number | undefined;
  }) => Stream.Stream<OrchestrationThreadStreamItem, unknown>;
  /** HTTP full snapshot — used for resume seed + reload-required when warm seed missing. */
  readonly fetchSnapshot: () => Effect.Effect<OrchestrationThreadDetailSnapshot | null>;
  readonly onThread: (thread: OrchestrationThread) => Effect.Effect<void, unknown, unknown>;
  /**
   * Durable cursor. With no warmSeed: HTTP-seed then WS afterSequence (cold/HTTP path).
   * With warmSeed: ignored for seed base; warmSeed.snapshotSequence drives afterSequence.
   */
  readonly afterSequence?: number | null;
  /**
   * Durable trimmed tip (web/desktop EnvironmentCacheStore-style). When set, skips HTTP
   * full-tip download and resumes via afterSequence from this base.
   */
  readonly warmSeed?: {
    readonly snapshotSequence: number;
    readonly thread: OrchestrationThread;
  } | null;
  /**
   * Optional projection applied before onThread and retained as the apply base
   * (e.g. drop Discord-finalized messages beyond a small buffer).
   */
  readonly projectThread?: (thread: OrchestrationThread) => OrchestrationThread;
  readonly onSequence?: (sequence: number) => Effect.Effect<void, unknown, unknown>;
  /**
   * When true (default), reconnect forever with backoff — matches client durable
   * subscription intent. Set false for tests / one-shot.
   */
  readonly retryForever?: boolean;
};

/**
 * Follow a thread the way other T3 clients do: seed snapshot, apply events in order,
 * reload on reload-required, retry the subscription on transport death.
 */
export function followOrchestrationThread(
  input: FollowOrchestrationThreadInput,
): Effect.Effect<void, never, unknown> {
  const retryForever = input.retryForever !== false;
  const noteSequence = (sequence: number) =>
    input.onSequence === undefined
      ? Effect.void
      : input.onSequence(sequence).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Failed to persist thread sequence marker", {
              threadId: input.threadId,
              sequence,
              cause: formatAlertCause(cause, 300),
            }),
          ),
        );

  const projectThread = input.projectThread;
  const warmSeed = input.warmSeed ?? null;
  const hasWarmSeed =
    warmSeed !== null &&
    Number.isFinite(warmSeed.snapshotSequence) &&
    warmSeed.snapshotSequence >= 0;

  const deliver = (thread: OrchestrationThread, sequence: number) =>
    Effect.gen(function* () {
      // Project first so the retained apply base matches what Discord keeps in memory.
      const projected = projectThread !== undefined ? projectThread(thread) : thread;
      yield* noteSequence(sequence);
      yield* input.onThread(projected).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("Thread follower onThread failed", {
            threadId: input.threadId,
            cause: formatAlertCause(cause),
          }),
        ),
      );
      return projected;
    });

  // Retained across SocketClose retries so we never re-paint Discord from a stale
  // in-memory warmSeed after the tip has already been applied this process.
  let resumeState: DiscordThreadFollowerState | null = null;

  const runOnce = Effect.gen(function* () {
    const seedPlan = planThreadFollowerReconnectSeed({
      lastAppliedSequence: resumeState?.lastSequence ?? -1,
      hasWarmSeed,
    });

    let state =
      seedPlan === "resume-after" && resumeState !== null
        ? resumeState
        : initialDiscordThreadFollowerState();
    let subscribeAfter: number | undefined =
      seedPlan === "resume-after" && resumeState !== null && resumeState.lastSequence >= 0
        ? resumeState.lastSequence
        : input.afterSequence !== undefined &&
            input.afterSequence !== null &&
            Number.isFinite(input.afterSequence) &&
            input.afterSequence >= 0
          ? input.afterSequence
          : undefined;

    if (seedPlan === "replay-warm" && warmSeed !== null) {
      // First seed this process only — durable tip + afterSequence, no HTTP.
      const projected = yield* deliver(warmSeed.thread, warmSeed.snapshotSequence);
      state = {
        current: projected,
        lastSequence: warmSeed.snapshotSequence,
      };
      resumeState = state;
      subscribeAfter = warmSeed.snapshotSequence;
      yield* Effect.logInfo("Thread follower seeding from durable warm cache", {
        threadId: input.threadId,
        snapshotSequence: warmSeed.snapshotSequence,
        messageCount: projected.messages.length,
      });
    } else if (seedPlan === "resume-after") {
      yield* Effect.logInfo("Thread follower resuming after disconnect (skip warm re-seed)", {
        threadId: input.threadId,
        afterSequence: subscribeAfter ?? null,
        lastSequence: resumeState?.lastSequence ?? null,
      });
    } else if (seedPlan === "http-or-cold" && subscribeAfter !== undefined) {
      // HTTP base snapshot, then events after that sequence.
      const seed = yield* input.fetchSnapshot();
      if (seed !== null) {
        const projected = yield* deliver(seed.thread, seed.snapshotSequence);
        state = {
          current: projected,
          lastSequence: seed.snapshotSequence,
        };
        resumeState = state;
        subscribeAfter = seed.snapshotSequence;
      } else {
        subscribeAfter = undefined;
        state = initialDiscordThreadFollowerState();
      }
    }

    yield* input.openStream({ afterSequence: subscribeAfter }).pipe(
      Stream.runForEach((item) =>
        Effect.gen(function* () {
          let applied = applyDiscordThreadStreamItem(state, item);

          if (applied._tag === "reload-required") {
            yield* Effect.logWarning(
              "Thread event requires snapshot reload; fetching HTTP thread snapshot",
              {
                threadId: input.threadId,
                eventType: applied.eventType,
                sequence: applied.sequence,
              },
            );
            const fresh = yield* input.fetchSnapshot();
            if (fresh === null) {
              // Keep last known current; skip corrupt apply (client leaves state in place).
              state = applied.state;
              resumeState = state;
              return;
            }
            const sequence = Math.max(fresh.snapshotSequence, applied.sequence);
            const projected = yield* deliver(fresh.thread, sequence);
            state = {
              current: projected,
              lastSequence: sequence,
            };
            resumeState = state;
            return;
          }

          if (applied._tag === "deliver") {
            const projected = yield* deliver(applied.thread, applied.sequence);
            state = {
              current: projected,
              lastSequence: applied.sequence,
            };
            resumeState = state;
          } else if (applied._tag === "deleted") {
            state = applied.state;
            resumeState = state;
            yield* noteSequence(applied.sequence);
          } else {
            state = applied.state;
            resumeState = state;
          }
        }),
      ),
    );
  });

  if (!retryForever) {
    // One-shot / test path. The retry branch below inspects failures via
    // `Effect.result` and loops; the one-shot path has no retry loop, so surface a
    // terminal stream failure as a defect rather than swallowing it.
    return runOnce.pipe(Effect.orDie);
  }

  return Effect.gen(function* () {
    let attempt = 0;
    while (true) {
      attempt += 1;
      const outcome = yield* runOnce.pipe(Effect.result);
      if (Result.isSuccess(outcome)) {
        return;
      }
      const pretty = formatAlertCause(outcome.failure);
      yield* Effect.logError("Orchestration thread subscription ended; resubscribing", {
        threadId: input.threadId,
        attempt,
        cause: pretty,
        resumeAfterSequence: resumeState?.lastSequence ?? null,
        seedPlan: planThreadFollowerReconnectSeed({
          lastAppliedSequence: resumeState?.lastSequence ?? -1,
          hasWarmSeed,
        }),
      });
      // Do not re-deliver warm/HTTP tips between attempts when we already applied a
      // sequence — runOnce will resume WS only. Cold path still HTTP-seeds on next runOnce.
      const delayMs = Math.min(30_000, 250 * 2 ** Math.min(attempt - 1, 7));
      yield* Effect.sleep(`${delayMs} millis`);
    }
  });
}
