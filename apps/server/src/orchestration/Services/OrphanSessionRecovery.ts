/**
 * Durable recovery for provider sessions that claim to be live but are not.
 *
 * After process death / server restarts the projection can stay `running` with
 * an `activeTurnId` while no provider process exists. Reapers that skip active
 * turns and resync that refuses `running` runtimes then deadlock the thread.
 */
import type { OrchestrationSession, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export type OrphanSessionRecoveryReason =
  | "server_restart"
  | "reaper_orphan_active_turn"
  | "reaper_inactivity"
  | "resync_zombie_running"
  | "manual";

export interface OrphanSessionRecoveryShape {
  /**
   * Whether a provider adapter currently holds a live process for this thread.
   */
  readonly hasLiveProcess: (threadId: ThreadId) => Effect.Effect<boolean>;

  /**
   * Force-settle orchestration session + provider runtime for one thread.
   * Always clears `activeTurnId` and marks the session interrupted/stopped so
   * turns project as terminal and resync can run.
   */
  readonly settleThread: (input: {
    readonly threadId: ThreadId;
    readonly reason: OrphanSessionRecoveryReason;
    readonly status?: Extract<OrchestrationSession["status"], "interrupted" | "stopped">;
  }) => Effect.Effect<void>;

  /**
   * Settle the thread only when it looks orphaned (claims running / has an
   * active turn / runtime running) and no live provider process exists.
   *
   * @returns true when a settle was performed
   */
  readonly settleIfOrphan: (
    threadId: ThreadId,
    reason?: OrphanSessionRecoveryReason,
  ) => Effect.Effect<boolean>;

  /**
   * Startup audit: settle every shell session still starting/running and every
   * persisted runtime still marked running (no process can have survived a
   * process restart).
   */
  readonly settleAllAfterServerRestart: () => Effect.Effect<{
    readonly settledSessions: number;
    readonly settledRuntimes: number;
  }>;
}

export class OrphanSessionRecovery extends Context.Service<
  OrphanSessionRecovery,
  OrphanSessionRecoveryShape
>()("t3/orchestration/Services/OrphanSessionRecovery") {}
