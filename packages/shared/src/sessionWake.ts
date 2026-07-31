/**
 * Shared wake-up / orphan-settle helpers.
 *
 * Problem: server restarts used to mark every session that *claimed* to be
 * `running`/`starting` as `interrupted` ("Wake Required"), including idle
 * zombies with no active turn. That resurrects old threads across all clients.
 *
 * Rules:
 * - Only settle as `interrupted` when real work was in flight.
 * - Only show Wake Required when the session is interrupted *and* the latest
 *   turn still looks unfinished (guards legacy false positives already stored).
 */

export type OrphanSettleSessionStatus = "interrupted" | "ready" | "stopped";

/**
 * True when a thread had real agent work in flight.
 * Used **before** orphan settle to choose `interrupted` vs `ready`.
 */
export function sessionHadInProgressWork(input: {
  readonly activeTurnId?: string | null | undefined;
  readonly latestTurnState?: string | null | undefined;
  readonly hasPendingApprovals?: boolean;
  readonly hasPendingUserInput?: boolean;
}): boolean {
  if (input.activeTurnId != null && String(input.activeTurnId).trim() !== "") {
    return true;
  }
  if (input.latestTurnState === "running") return true;
  if (input.hasPendingApprovals === true) return true;
  if (input.hasPendingUserInput === true) return true;
  return false;
}

/**
 * Status to write when settling an orphan/zombie session after restart or reaper.
 * Zombie `running` with no in-progress work becomes `ready` (no Wake Required).
 */
export function resolveOrphanSettleSessionStatus(input: {
  readonly hadInProgressWork: boolean;
  readonly preferredWhenInProgress?: Extract<OrphanSettleSessionStatus, "interrupted" | "stopped">;
}): OrphanSettleSessionStatus {
  if (input.hadInProgressWork) {
    return input.preferredWhenInProgress ?? "interrupted";
  }
  return "ready";
}

/**
 * True when clients should show Wake Required / Discord Continue notice.
 *
 * After a correct settle, `status === "interrupted"` alone is enough — but we
 * still require incomplete-turn evidence so legacy false positives (interrupted
 * with a completed/absent turn) stay quiet.
 */
export function sessionNeedsWakeUp(input: {
  readonly sessionStatus?: string | null | undefined;
  readonly activeTurnId?: string | null | undefined;
  readonly latestTurnState?: string | null | undefined;
  readonly latestTurnCompletedAt?: string | null | undefined;
}): boolean {
  if (input.sessionStatus !== "interrupted") return false;

  if (input.activeTurnId != null && String(input.activeTurnId).trim() !== "") {
    return true;
  }
  // Mid-turn crash: turn row often still says running after session settle.
  if (input.latestTurnState === "running") return true;
  // Explicit interrupted turn without a completion timestamp.
  if (
    input.latestTurnState === "interrupted" &&
    (input.latestTurnCompletedAt == null || input.latestTurnCompletedAt === "")
  ) {
    return true;
  }
  return false;
}
