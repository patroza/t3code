// @effect-diagnostics anyUnknownInErrorContext:off missingEffectContext:off missingEffectError:off globalDate:off
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import { formatAlertCause, postFatalAlert } from "./Alerts.ts";

/** Hard cap on concurrent live Discord↔T3 bridges (design decision 4). */
export const MAX_ACTIVE_BRIDGES = 50;

export type BridgeEnsureMode = "interactive" | "rehydrate";

export type DiscordBridgePresentationMode = "full" | "final-only";

export type BridgeEnsureInput = {
  readonly discordChannelId: string;
  readonly t3ThreadId: string;
  /** Pre-posted "_Working.._" message — reused as stream tip and deleted on finalize. */
  readonly workingAckMessageId?: string | null;
  /** Discord-originated T3 user message ids that may appear immediately after subscribe. */
  readonly sentDiscordUserMessageIds?: ReadonlyArray<string>;
  /** Final-only avoids progress chatter for ambient conversational turns. */
  readonly presentationMode?: DiscordBridgePresentationMode;
  /**
   * `interactive` — mention path (may seed Working..).
   * `rehydrate` — boot/reconnect restore; skips new Working.. unless needed.
   */
  readonly mode?: BridgeEnsureMode;
  /**
   * Activity timestamp for eviction ranking (ISO). Defaults to now on ensure.
   * Prefer the durable link's `lastActivityAt` when known.
   */
  readonly lastActivityAt?: string;
  /**
   * When true, this bridge is preferred to keep under cap pressure (running/pending).
   * Interactive ensures are always treated as preferred.
   */
  readonly preferred?: boolean;
};

export type ActiveBridge = {
  readonly discordChannelId: string;
  readonly t3ThreadId: string;
  readonly lastActivityAt: string;
  readonly preferred: boolean;
  readonly mode: BridgeEnsureMode;
};

/** Control surface filled by runBridge so mid-turn follow-ups can reuse the live fiber. */
export type BridgeControlSlot = {
  noteSentUserMessageIds: (ids: ReadonlyArray<string>) => Effect.Effect<void>;
  adoptWorkingAckMessageId: (messageId: string) => Effect.Effect<void>;
  /**
   * Force-refresh Discord thread title indicators (PR/VCS badges).
   * Clears title settle cache, re-queries VCS/PR, and renames the Discord thread.
   */
  refreshThreadIndicators: () => Effect.Effect<RefreshThreadIndicatorsResult>;
};

export type RefreshThreadIndicatorsResult =
  | { readonly ok: true; readonly title: string }
  | { readonly ok: false; readonly error: string };

type BridgeEntry = {
  readonly fiber: Fiber.Fiber<void, unknown>;
  readonly t3ThreadId: string;
  /** Singleflight: concurrent ensure for the same channel waits on this. */
  readonly ready: Deferred.Deferred<void>;
  readonly lastActivityAt: string;
  readonly preferred: boolean;
  readonly mode: BridgeEnsureMode;
  readonly control: BridgeControlSlot;
};

/**
 * Starts a bridge fiber and waits until the first T3 snapshot (or failure/timeout).
 * Injected so BridgeHub does not import the full ResponseBridge module graph.
 * Requirements (T3Session, DiscordREST, …) come from the ambient ensure call context.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type BridgeRunner = (
  input: BridgeEnsureInput,
  ready: Deferred.Deferred<void>,
  controlSlot: BridgeControlSlot,
) => Effect.Effect<void, any, any>;

export interface LiveDiscordBridge {
  readonly t3ThreadId: string;
  readonly noteSentUserMessageIds: (ids: ReadonlyArray<string>) => Effect.Effect<void>;
  readonly adoptWorkingAckMessageId: (messageId: string) => Effect.Effect<void>;
  readonly refreshThreadIndicators: () => Effect.Effect<RefreshThreadIndicatorsResult>;
}

export interface BridgeHubService {
  readonly ensure: (input: BridgeEnsureInput) => Effect.Effect<void>;
  readonly drop: (discordChannelId: string) => Effect.Effect<void>;
  /** Interrupt every live bridge fiber (T3 reconnect / ops). Durable links stay. */
  readonly dropAll: () => Effect.Effect<void>;
  readonly listActive: () => Effect.Effect<ReadonlyArray<ActiveBridge>>;
  readonly activeCount: () => Effect.Effect<number>;
  /** Update activity timestamp used for eviction ranking. */
  readonly touch: (discordChannelId: string, at?: string) => Effect.Effect<void>;
  readonly getLive: (
    discordChannelId: string,
    t3ThreadId?: string,
  ) => Effect.Effect<LiveDiscordBridge | null>;
}

export class BridgeHub extends Context.Service<BridgeHub, BridgeHubService>()(
  "@t3tools/discord-bot/features/BridgeHub",
) {}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Pick the best eviction victim under cap pressure.
 * Prefer non-preferred (idle) bridges with oldest lastActivityAt.
 * Falls back to oldest preferred when every active bridge is preferred.
 */
export function pickEvictionVictim(
  active: ReadonlyArray<ActiveBridge>,
  exceptChannelId: string,
): ActiveBridge | null {
  const candidates = active.filter((entry) => entry.discordChannelId !== exceptChannelId);
  if (candidates.length === 0) return null;
  const idle = candidates.filter((entry) => !entry.preferred);
  const pool = idle.length > 0 ? idle : candidates;
  return [...pool].sort((a, b) => a.lastActivityAt.localeCompare(b.lastActivityAt))[0] ?? null;
}

/**
 * In-memory registry of live bridge fibers with singleflight ensure / drop / cap eviction.
 *
 * Same-thread interactive ensure **reuses** the live fiber (preserves mid-turn stream tips).
 * Rehydrate ensure is a no-op when the same t3ThreadId is already live.
 * Different t3ThreadId always replaces the fiber.
 */
export const makeBridgeHub = (runBridge: BridgeRunner) =>
  Effect.gen(function* () {
    const bridges = yield* Ref.make(new Map<string, BridgeEntry>());

    const dropInternal = (discordChannelId: string) =>
      Effect.gen(function* () {
        const entry = yield* Ref.modify(bridges, (map) => {
          const current = map.get(discordChannelId);
          if (current === undefined) return [undefined, map] as const;
          const copy = new Map(map);
          copy.delete(discordChannelId);
          return [current, copy] as const;
        });
        if (entry === undefined) return;
        yield* Fiber.interrupt(entry.fiber).pipe(Effect.ignore);
      });

    const listActiveInternal = () =>
      Ref.get(bridges).pipe(
        Effect.map((map) =>
          [...map.entries()].map(
            ([discordChannelId, entry]): ActiveBridge => ({
              discordChannelId,
              t3ThreadId: entry.t3ThreadId,
              lastActivityAt: entry.lastActivityAt,
              preferred: entry.preferred,
              mode: entry.mode,
            }),
          ),
        ),
      );

    const enforceCap = (exceptChannelId: string) =>
      Effect.gen(function* () {
        // Leave room for the bridge we are about to start.
        while (true) {
          const active = yield* listActiveInternal();
          if (active.length < MAX_ACTIVE_BRIDGES) return;
          const victim = pickEvictionVictim(active, exceptChannelId);
          if (victim === null) {
            yield* Effect.logWarning("BridgeHub at hard capacity with no eviction victim", {
              active: active.length,
              cap: MAX_ACTIVE_BRIDGES,
              exceptChannelId,
            });
            return;
          }
          yield* Effect.logWarning("BridgeHub evicting bridge under capacity pressure", {
            victim: victim.discordChannelId,
            victimT3: victim.t3ThreadId,
            lastActivityAt: victim.lastActivityAt,
            preferred: victim.preferred,
            active: active.length,
            cap: MAX_ACTIVE_BRIDGES,
          });
          yield* dropInternal(victim.discordChannelId);
        }
      });

    const ensure = (input: BridgeEnsureInput): Effect.Effect<void> =>
      Effect.gen(function* () {
        const mode = input.mode ?? "interactive";
        const preferred = input.preferred ?? mode === "interactive";
        const activityAt = input.lastActivityAt ?? nowIso();
        const existing = yield* Ref.get(bridges).pipe(
          Effect.map((map) => map.get(input.discordChannelId)),
        );

        // Same T3 thread already bridging: reuse live fiber (mid-turn steers + rehydrate).
        if (existing !== undefined && existing.t3ThreadId === input.t3ThreadId) {
          yield* Effect.logInfo("BridgeHub.ensure reusing live fiber", {
            discordChannelId: input.discordChannelId,
            t3ThreadId: input.t3ThreadId,
            mode,
          });
          yield* Ref.update(bridges, (map) => {
            const current = map.get(input.discordChannelId);
            if (current === undefined) return map;
            const copy = new Map(map);
            copy.set(input.discordChannelId, {
              ...current,
              lastActivityAt: activityAt,
              preferred: preferred || current.preferred,
              mode,
            });
            return copy;
          });
          if (
            input.sentDiscordUserMessageIds !== undefined &&
            input.sentDiscordUserMessageIds.length > 0
          ) {
            yield* existing.control.noteSentUserMessageIds(input.sentDiscordUserMessageIds);
          }
          if (
            input.workingAckMessageId !== undefined &&
            input.workingAckMessageId !== null &&
            input.workingAckMessageId !== ""
          ) {
            yield* existing.control.adoptWorkingAckMessageId(input.workingAckMessageId);
          }
          yield* Deferred.await(existing.ready).pipe(
            Effect.timeout("15 seconds"),
            Effect.catch(() => Effect.void),
          );
          return;
        }

        if (existing !== undefined) {
          yield* Effect.logInfo("BridgeHub.ensure interrupting previous fiber", {
            discordChannelId: input.discordChannelId,
            previousT3ThreadId: existing.t3ThreadId,
            nextT3ThreadId: input.t3ThreadId,
            mode,
          });
          yield* dropInternal(input.discordChannelId);
        }

        yield* enforceCap(input.discordChannelId);

        const ready = yield* Deferred.make<void>();
        const controlSlot: BridgeControlSlot = {
          noteSentUserMessageIds: () => Effect.void,
          adoptWorkingAckMessageId: () => Effect.void,
          refreshThreadIndicators: () =>
            Effect.succeed({ ok: false as const, error: "Bridge control not ready yet" }),
        };

        const fiber = yield* runBridge(input, ready, controlSlot).pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              const pretty = formatAlertCause(cause);
              yield* Effect.logError("Discord bridge fiber failed", {
                discordChannelId: input.discordChannelId,
                t3ThreadId: input.t3ThreadId,
                cause: pretty,
              });
              yield* postFatalAlert(
                `bridge:${input.discordChannelId}`,
                "Discord bridge fiber failed",
                `channel=\`${input.discordChannelId}\` thread=\`${input.t3ThreadId}\`\n${pretty}`,
              );
              yield* Deferred.succeed(ready, undefined).pipe(Effect.ignore);
            }).pipe(Effect.asVoid),
          ),
          Effect.ensuring(
            Ref.update(bridges, (map) => {
              const current = map.get(input.discordChannelId);
              if (current === undefined || current.ready !== ready) return map;
              const copy = new Map(map);
              copy.delete(input.discordChannelId);
              return copy;
            }),
          ),
          // forkDetach: mention handler returns after startTurn; forkChild would kill the
          // bridge mid-upload and leave Working.. + partial attachments behind.
          Effect.forkDetach,
        );

        yield* Ref.update(bridges, (map) => {
          const copy = new Map(map);
          copy.set(input.discordChannelId, {
            fiber,
            t3ThreadId: input.t3ThreadId,
            ready,
            lastActivityAt: activityAt,
            preferred,
            mode,
            control: controlSlot,
          });
          return copy;
        });

        yield* Effect.logInfo("BridgeHub fiber started; waiting for first snapshot", {
          discordChannelId: input.discordChannelId,
          t3ThreadId: input.t3ThreadId,
          mode,
        });

        // Do not return until subscription is live — otherwise startTurn can finish
        // before any events are observed (fast providers).
        yield* Deferred.await(ready).pipe(
          Effect.timeout("15 seconds"),
          Effect.catch((error) =>
            Effect.logError("Timed out / failed waiting for T3 thread subscription snapshot", {
              discordChannelId: input.discordChannelId,
              t3ThreadId: input.t3ThreadId,
              error: String(error),
            }),
          ),
        );
        yield* Effect.logInfo("BridgeHub subscription ready (snapshot received)", {
          discordChannelId: input.discordChannelId,
          t3ThreadId: input.t3ThreadId,
        });
      }) as Effect.Effect<void>;

    return BridgeHub.of({
      ensure,
      drop: dropInternal,
      dropAll: () =>
        Effect.gen(function* () {
          const active = yield* listActiveInternal();
          for (const entry of active) {
            yield* dropInternal(entry.discordChannelId);
          }
        }),
      listActive: listActiveInternal,
      activeCount: () => Ref.get(bridges).pipe(Effect.map((map) => map.size)),
      touch: (discordChannelId, at) =>
        Ref.update(bridges, (map) => {
          const current = map.get(discordChannelId);
          if (current === undefined) return map;
          const copy = new Map(map);
          copy.set(discordChannelId, {
            ...current,
            lastActivityAt: at ?? nowIso(),
          });
          return copy;
        }),
      getLive: (discordChannelId, t3ThreadId) =>
        Ref.get(bridges).pipe(
          Effect.map((map) => {
            const entry = map.get(discordChannelId);
            if (entry === undefined) return null;
            if (t3ThreadId !== undefined && entry.t3ThreadId !== t3ThreadId) return null;
            return {
              t3ThreadId: entry.t3ThreadId,
              noteSentUserMessageIds: entry.control.noteSentUserMessageIds,
              adoptWorkingAckMessageId: entry.control.adoptWorkingAckMessageId,
              refreshThreadIndicators: entry.control.refreshThreadIndicators,
            } satisfies LiveDiscordBridge;
          }),
        ),
    });
  });

export const layer = (runBridge: BridgeRunner) => Layer.effect(BridgeHub, makeBridgeHub(runBridge));
