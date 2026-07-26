// @effect-diagnostics anyUnknownInErrorContext:off missingEffectContext:off missingEffectError:off
/**
 * Boot / T3-reconnect rehydrate of Discord↔T3 bridges.
 *
 * Restore set (design decision 1 + catch-up):
 * - shell thread running / starting / pending approval / pending user-input
 * - OR session interrupted (Wake Required — convert Working tips + ❗ title)
 * - OR durable `streamDiscordMessageIds` non-empty (need finalize/cleanup after offline completion)
 * - OR dual-cursor lag (`lastDeliveredSequence` behind `lastThreadSnapshotSequence`)
 *
 * Cap 50 by lastActivityAt desc. Concurrent ensure 4.
 */
import type { OrchestrationThreadShell, ThreadId } from "@t3tools/contracts";
import { sessionNeedsWakeUp } from "@t3tools/shared/sessionWake";
import { DiscordREST } from "dfx";
import * as Effect from "effect/Effect";

import { ThreadLinkStore, type ThreadLink } from "../store/ThreadLinkStore.ts";
import { T3Session } from "../t3/T3Session.ts";
import { formatAlertCause, postFatalAlert } from "./Alerts.ts";
import { BridgeHub, MAX_ACTIVE_BRIDGES } from "./BridgeHub.ts";
import { isDeliveryBehindOrchestration } from "./ResponseBridge.ts";

export type RestoreCandidateReason =
  | "running"
  | "session-active"
  | "session-wake-required"
  | "pending-approval"
  | "pending-user-input"
  | "open-stream-ids"
  | "delivery-behind"
  | "idle-linked";

export type ShellRestoreDecision =
  | { readonly kind: "missing" }
  | { readonly kind: "idle" }
  | { readonly kind: "restore"; readonly reasons: ReadonlyArray<RestoreCandidateReason> };

/**
 * Pure shell-based restore decision (no Discord I/O).
 * `hasOpenStreamIds` covers offline-completed turns that still need Discord finalize.
 * `deliveryBehind` covers dual-cursor lag (orchestration advanced, Discord never applied).
 */
export function shellRestoreDecision(
  shell: OrchestrationThreadShell | null | undefined,
  options?: {
    readonly hasOpenStreamIds?: boolean;
    readonly deliveryBehind?: boolean;
  },
): ShellRestoreDecision {
  if (shell === null || shell === undefined) {
    // Thread gone from shell — cannot resume or finalize cleanly.
    return { kind: "missing" };
  }

  const reasons: RestoreCandidateReason[] = [];
  if (shell.latestTurn?.state === "running") reasons.push("running");
  if (shell.session?.status === "running" || shell.session?.status === "starting") {
    reasons.push("session-active");
  }
  // Only real mid-turn interrupts (not zombie interrupted + completed turn).
  if (
    sessionNeedsWakeUp({
      sessionStatus: shell.session?.status ?? null,
      activeTurnId: shell.session?.activeTurnId ?? null,
      latestTurnState: shell.latestTurn?.state ?? null,
      latestTurnCompletedAt: shell.latestTurn?.completedAt ?? null,
    })
  ) {
    reasons.push("session-wake-required");
  }
  if (shell.hasPendingApprovals) reasons.push("pending-approval");
  if (shell.hasPendingUserInput) reasons.push("pending-user-input");
  if (options?.hasOpenStreamIds === true) reasons.push("open-stream-ids");
  if (options?.deliveryBehind === true) reasons.push("delivery-behind");

  if (reasons.length === 0) return { kind: "idle" };
  return { kind: "restore", reasons };
}

/** Sort active links by freshest activity, cap at max. */
export function rankAndCapRestoreCandidates(
  candidates: ReadonlyArray<{
    readonly link: ThreadLink;
    readonly urgent: boolean;
  }>,
  max: number = MAX_ACTIVE_BRIDGES,
): {
  readonly selected: ReadonlyArray<{
    readonly link: ThreadLink;
    readonly urgent: boolean;
  }>;
  readonly dropped: number;
} {
  const active = candidates.filter((candidate) => candidate.link.status === "active");
  const sorted = [...active].sort((a, b) => {
    if (a.urgent !== b.urgent) {
      return a.urgent ? -1 : 1;
    }
    return b.link.lastActivityAt.localeCompare(a.link.lastActivityAt);
  });
  const selected = sorted.slice(0, Math.max(0, max));
  return { selected, dropped: Math.max(0, sorted.length - selected.length) };
}

export type RehydrateStats = {
  readonly considered: number;
  readonly selected: number;
  readonly restored: number;
  readonly failed: number;
  readonly tombstoned: number;
  readonly idleLinked: number;
  readonly cappedOut: number;
};

/**
 * Select restore candidates from durable links + live T3 shell + Discord channel existence.
 */
export const selectRestoreCandidates = Effect.gen(function* () {
  const links = yield* ThreadLinkStore;
  const t3 = yield* T3Session;
  const rest = yield* DiscordREST;

  const all = yield* links.list();
  const activeLinks = all.filter((link) => link.status === "active");

  const candidates: Array<{ readonly link: ThreadLink; readonly urgent: boolean }> = [];
  let tombstoned = 0;
  let idleLinked = 0;

  for (const link of activeLinks) {
    const shell = yield* t3.getThreadShell(link.t3ThreadId as ThreadId);
    const hasOpenStreamIds = (link.streamDiscordMessageIds?.length ?? 0) > 0;
    const deliveryBehind = isDeliveryBehindOrchestration({
      lastDeliveredSequence: link.lastDeliveredSequence,
      lastThreadSnapshotSequence: link.lastThreadSnapshotSequence,
    });
    const decision = shellRestoreDecision(shell, { hasOpenStreamIds, deliveryBehind });

    if (decision.kind === "missing") {
      yield* links.tombstone(link.discordThreadId);
      tombstoned += 1;
      yield* Effect.logWarning("Rehydrate tombstoned link (T3 thread missing)", {
        discordThreadId: link.discordThreadId,
        t3ThreadId: link.t3ThreadId,
      });
      continue;
    }

    // Discord channel must still exist.
    const channelOk = yield* rest.getChannel(link.discordThreadId).pipe(
      Effect.as(true as const),
      Effect.catch((error) => {
        const message = String(error);
        // dfx / Discord 404 → gone
        const missing =
          message.includes("10003") ||
          message.includes("Unknown Channel") ||
          message.includes("404");
        return Effect.succeed(missing ? (false as const) : (true as const));
      }),
    );
    if (!channelOk) {
      yield* links.tombstone(link.discordThreadId);
      tombstoned += 1;
      yield* Effect.logWarning("Rehydrate tombstoned link (Discord channel missing)", {
        discordThreadId: link.discordThreadId,
        t3ThreadId: link.t3ThreadId,
      });
      continue;
    }

    if (decision.kind === "idle") {
      idleLinked += 1;
      candidates.push({ link, urgent: false });
      continue;
    }

    candidates.push({ link, urgent: true });
  }

  const { selected, dropped } = rankAndCapRestoreCandidates(candidates, MAX_ACTIVE_BRIDGES);
  if (dropped > 0) {
    yield* Effect.logWarning("Rehydrate capped candidates by urgency and lastActivityAt", {
      candidates: candidates.length,
      selected: selected.length,
      cappedOut: dropped,
      cap: MAX_ACTIVE_BRIDGES,
    });
  }

  return {
    selected: selected.map((candidate) => candidate.link),
    stats: {
      considered: activeLinks.length,
      selected: selected.length,
      restored: 0,
      failed: 0,
      tombstoned,
      idleLinked,
      cappedOut: dropped,
    } satisfies RehydrateStats,
  };
});

/**
 * Re-establish bridges for active links after boot or T3 reconnect.
 * Running / pending / lagging links outrank idle links under the cap.
 * Catch-up finalize runs inside each bridge's first snapshot when the turn finished offline.
 */
export const rehydrateBridges = (source: "boot" | "reconnect") =>
  Effect.gen(function* () {
    const hub = yield* BridgeHub;

    yield* Effect.logInfo("Discord bridge rehydrate starting", { source });

    if (source === "reconnect") {
      // subscribeThread fibers die with the old session; clear hub registry explicitly.
      yield* hub.dropAll();
    }

    const { selected, stats } = yield* selectRestoreCandidates;
    let restored = 0;
    let failed = 0;

    yield* Effect.forEach(
      selected,
      (link) =>
        Effect.gen(function* () {
          yield* hub.ensure({
            discordChannelId: link.discordThreadId,
            t3ThreadId: link.t3ThreadId,
            mode: "rehydrate",
            lastActivityAt: link.lastActivityAt,
            preferred: true,
          });
          restored += 1;
          yield* Effect.logInfo("Rehydrate bridge ensured", {
            discordThreadId: link.discordThreadId,
            t3ThreadId: link.t3ThreadId,
            openStreamIds: link.streamDiscordMessageIds?.length ?? 0,
          });
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              failed += 1;
              const pretty = formatAlertCause(cause);
              yield* Effect.logError("Rehydrate bridge ensure failed", {
                discordThreadId: link.discordThreadId,
                t3ThreadId: link.t3ThreadId,
                cause: pretty,
              });
              yield* postFatalAlert(
                `rehydrate:${link.discordThreadId}`,
                "Bridge rehydrate failed",
                `source=\`${source}\` channel=\`${link.discordThreadId}\` thread=\`${link.t3ThreadId}\`\n${pretty}`,
              );
            }).pipe(Effect.asVoid),
          ),
        ),
      { concurrency: 4 },
    );

    const finalStats: RehydrateStats = {
      ...stats,
      restored,
      failed,
    };
    yield* Effect.logInfo("Discord bridge rehydrate finished", {
      source,
      ...finalStats,
    });
    return finalStats;
  });
