import type { EnvironmentId, OrchestrationThreadShell } from "@t3tools/contracts";
import { sessionNeedsWakeUp } from "@t3tools/shared/sessionWake";

import { effectiveSettled, effectiveSnoozed } from "./threadSettled";
import { getThreadSortTimestamp } from "./threadSort";

/** Status labels aligned with web `resolveThreadStatusPill` / board derivation. */
export type NeedsAttentionStatusLabel =
  | "Working"
  | "Connecting"
  | "Completed"
  | "Pending Approval"
  | "Awaiting Input"
  | "Wake Required"
  | "Plan Ready"
  | "Error";

/** Why a thread appears in Needs attention (drives attention-first sort). */
export type NeedsAttentionKind = "blocked" | "working";

/**
 * Attention-first priority: blocked-on-you before in-motion work.
 * Within a bucket, newest activity first.
 */
const KIND_RANK: Record<NeedsAttentionKind, number> = {
  blocked: 0,
  working: 1,
};

export type NeedsAttentionThreadInput = Pick<
  OrchestrationThreadShell,
  | "id"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "hasActionableProposedPlan"
  | "interactionMode"
  | "latestTurn"
  | "session"
  | "createdAt"
  | "updatedAt"
  | "latestUserMessageAt"
  | "archivedAt"
  | "settledOverride"
  | "settledAt"
  | "snoozedUntil"
  | "snoozedAt"
  | "environmentId"
  | "projectId"
>;

/**
 * Resolves a board/sidebar-compatible status label for attention classification.
 * Mirrors web `resolveThreadStatusPill` priority (without last-visited Completed
 * when `lastVisitedAt` is omitted — callers can pass Completed via status override).
 */
export function resolveNeedsAttentionStatusLabel(
  thread: Pick<
    NeedsAttentionThreadInput,
    | "hasPendingApprovals"
    | "hasPendingUserInput"
    | "hasActionableProposedPlan"
    | "interactionMode"
    | "latestTurn"
    | "session"
  >,
): NeedsAttentionStatusLabel | null {
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
  if (thread.session?.status === "error" || thread.latestTurn?.state === "error") {
    return "Error";
  }
  return null;
}

/**
 * Classifies a live thread for Needs attention strips (web sidebar + mobile home).
 *
 * Tighter than the full board **Review** column: idle threads with no status
 * are excluded. Working + clear human-attention signals only.
 */
export function classifyNeedsAttention(
  thread: Pick<
    NeedsAttentionThreadInput,
    | "hasPendingApprovals"
    | "hasPendingUserInput"
    | "hasActionableProposedPlan"
    | "interactionMode"
    | "latestTurn"
    | "session"
  >,
  options?: {
    /** When true (e.g. web unseen completion), treat as blocked attention. */
    readonly hasUnseenCompletion?: boolean;
  },
): {
  readonly kind: NeedsAttentionKind;
  readonly statusLabel: NeedsAttentionStatusLabel | null;
} | null {
  if (options?.hasUnseenCompletion === true) {
    const statusLabel = resolveNeedsAttentionStatusLabel(thread);
    // Unseen completion only applies when nothing more urgent is showing.
    if (statusLabel === null || statusLabel === "Completed") {
      return { kind: "blocked", statusLabel: statusLabel ?? "Completed" };
    }
  }

  const statusLabel = resolveNeedsAttentionStatusLabel(thread);
  switch (statusLabel) {
    case "Pending Approval":
    case "Awaiting Input":
    case "Plan Ready":
    case "Wake Required":
    case "Completed":
    case "Error":
      return { kind: "blocked", statusLabel };
    case "Working":
    case "Connecting":
      return { kind: "working", statusLabel };
    case null:
      return null;
    default: {
      const exhaustive: never = statusLabel;
      return exhaustive;
    }
  }
}

export interface NeedsAttentionEntry<TThread extends NeedsAttentionThreadInput, TProject> {
  readonly thread: TThread;
  readonly project: TProject;
  readonly kind: NeedsAttentionKind;
  readonly statusLabel: NeedsAttentionStatusLabel | null;
}

/**
 * Builds Needs attention entries: board Working ∪ blocked Review signals,
 * attention-first sort. Shared by web classic sidebar and mobile home list.
 */
export function buildNeedsAttentionEntries<
  TThread extends NeedsAttentionThreadInput,
  TProject,
>(input: {
  readonly threads: ReadonlyArray<TThread>;
  readonly resolveProject: (thread: TThread) => TProject | null;
  /**
   * Optional project membership filter (e.g. environment/project scope).
   * Return false to exclude.
   */
  readonly includeThread?: (thread: TThread) => boolean;
  readonly settlementEnvironmentIds?: ReadonlySet<EnvironmentId>;
  readonly snoozeEnvironmentIds?: ReadonlySet<EnvironmentId>;
  readonly autoSettleAfterDays?: number | null;
  readonly now?: string;
  /** Per-thread unseen completion (web last-visited). */
  readonly hasUnseenCompletion?: (thread: TThread) => boolean;
}): ReadonlyArray<NeedsAttentionEntry<TThread, TProject>> {
  const now = input.now ?? new Date().toISOString();
  const autoSettleAfterDays = input.autoSettleAfterDays ?? 3;
  const entries: NeedsAttentionEntry<TThread, TProject>[] = [];

  for (const thread of input.threads) {
    if (thread.archivedAt !== null) continue;
    if (input.includeThread && !input.includeThread(thread)) continue;

    const supportsSnooze = input.snoozeEnvironmentIds?.has(thread.environmentId) ?? true;
    if (supportsSnooze && effectiveSnoozed(thread, { now })) {
      continue;
    }

    const supportsSettlement = input.settlementEnvironmentIds?.has(thread.environmentId) ?? true;
    if (
      supportsSettlement &&
      effectiveSettled(thread, {
        now,
        autoSettleAfterDays,
        changeRequestState: null,
      })
    ) {
      continue;
    }

    const classification = classifyNeedsAttention(thread, {
      hasUnseenCompletion: input.hasUnseenCompletion?.(thread) === true,
    });
    if (classification === null) continue;

    const project = input.resolveProject(thread);
    if (project === null) continue;

    entries.push({
      thread,
      project,
      kind: classification.kind,
      statusLabel: classification.statusLabel,
    });
  }

  return entries.sort((left, right) => {
    const kindDelta = KIND_RANK[left.kind] - KIND_RANK[right.kind];
    if (kindDelta !== 0) return kindDelta;
    const leftTs = getThreadSortTimestamp(left.thread, "updated_at");
    const rightTs = getThreadSortTimestamp(right.thread, "updated_at");
    if (leftTs !== rightTs) return rightTs > leftTs ? 1 : -1;
    return left.thread.id < right.thread.id ? -1 : left.thread.id > right.thread.id ? 1 : 0;
  });
}
