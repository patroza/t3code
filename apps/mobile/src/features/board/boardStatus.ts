import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { sessionNeedsWakeUp } from "@t3tools/shared/sessionWake";

import type { BoardThreadStatusLabel } from "./boardLogic";

/**
 * Maps a live thread shell to the board status labels used by
 * {@link deriveBoardColumn}. Labels match web `resolveThreadStatusPill` so
 * column placement stays consistent across clients.
 */
export function resolveBoardThreadStatusLabel(
  thread: Pick<
    EnvironmentThreadShell,
    | "hasPendingApprovals"
    | "hasPendingUserInput"
    | "hasActionableProposedPlan"
    | "interactionMode"
    | "latestTurn"
    | "session"
  >,
): BoardThreadStatusLabel | null {
  if (thread.hasPendingApprovals) {
    return "Pending Approval";
  }
  if (thread.hasPendingUserInput) {
    return "Awaiting Input";
  }
  if (
    thread.interactionMode === "plan" &&
    thread.hasActionableProposedPlan &&
    !thread.hasPendingUserInput
  ) {
    return "Plan Ready";
  }
  if (thread.session?.status === "running") {
    return "Working";
  }
  if (thread.session?.status === "starting") {
    return "Connecting";
  }
  if (
    sessionNeedsWakeUp({
      sessionStatus: thread.session?.status ?? null,
      activeTurnId: thread.session?.activeTurnId ?? null,
      latestTurnState: thread.latestTurn?.state ?? null,
      latestTurnCompletedAt: thread.latestTurn?.completedAt ?? null,
    })
  ) {
    return "Wake Required";
  }
  // Mobile has no last-visited tracking yet, so the web "Completed" (unseen)
  // pill is not emitted here. Unseen-completion still flows through
  // deriveBoardColumn via lastVisitedAt when that lands later.
  return null;
}

/** Working-column sort timestamp for a running turn, matching web board. */
export function resolveBoardWorkingStartedAt(
  thread: Pick<EnvironmentThreadShell, "latestTurn" | "session">,
): string | null {
  const turn = thread.latestTurn;
  if (turn && turn.completedAt === null) {
    return firstValidTimestamp(turn.startedAt, turn.requestedAt, thread.session?.updatedAt);
  }
  return firstValidTimestamp(thread.session?.updatedAt);
}

function firstValidTimestamp(...candidates: Array<string | null | undefined>): string | null {
  for (const candidate of candidates) {
    if (candidate == null) continue;
    if (!Number.isNaN(Date.parse(candidate))) return candidate;
  }
  return null;
}
