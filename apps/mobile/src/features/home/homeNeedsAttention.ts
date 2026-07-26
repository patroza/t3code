import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { effectiveSettled, effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import { getThreadSortTimestamp } from "@t3tools/client-runtime/state/thread-sort";
import type { EnvironmentId } from "@t3tools/contracts";

import { scopedProjectKey } from "../../lib/scopedEntities";
import type { BoardThreadStatusLabel } from "../board/boardLogic";
import { resolveBoardThreadStatusLabel } from "../board/boardStatus";

/** Initial Needs attention size; matches the old Recent preview count. */
export const HOME_NEEDS_ATTENTION_PREVIEW_COUNT = 6;

/**
 * Synthetic group key for Needs attention show-more / expand state. Not a
 * real project group — kept out of collapsed-project persistence.
 */
export const HOME_NEEDS_ATTENTION_GROUP_KEY = "__needs-attention__";

/** Why a thread appears in Needs attention (drives sort + subtitle hint). */
export type HomeNeedsAttentionKind = "blocked" | "working";

export interface HomeNeedsAttentionEntry {
  readonly thread: EnvironmentThreadShell;
  readonly project: EnvironmentProject;
  readonly kind: HomeNeedsAttentionKind;
  /** Board-compatible status label when present; null for shell-only signals. */
  readonly statusLabel: BoardThreadStatusLabel | "Error" | null;
}

/**
 * Attention-first priority: blocked-on-you before in-motion work.
 * Within a bucket, newest activity first (same timestamp as thread sort).
 */
const KIND_RANK: Record<HomeNeedsAttentionKind, number> = {
  blocked: 0,
  working: 1,
};

/**
 * Classifies a live thread for the home Needs attention strip.
 *
 * Intentionally tighter than the full board **Review** column: idle threads
 * with no status and no error are excluded (board Review still holds them
 * for triage). Working + clear human-attention signals only.
 */
export function classifyNeedsAttention(
  thread: Pick<
    EnvironmentThreadShell,
    | "hasPendingApprovals"
    | "hasPendingUserInput"
    | "hasActionableProposedPlan"
    | "interactionMode"
    | "latestTurn"
    | "session"
  >,
): {
  readonly kind: HomeNeedsAttentionKind;
  readonly statusLabel: BoardThreadStatusLabel | "Error" | null;
} | null {
  const statusLabel = resolveBoardThreadStatusLabel(thread);
  switch (statusLabel) {
    case "Pending Approval":
    case "Awaiting Input":
    case "Plan Ready":
    case "Wake Required":
    case "Completed":
      return { kind: "blocked", statusLabel };
    case "Working":
    case "Connecting":
      return { kind: "working", statusLabel };
    case null:
      break;
    default: {
      const exhaustive: never = statusLabel;
      return exhaustive;
    }
  }

  // Board status mapping omits error; surface it as blocked attention.
  if (thread.session?.status === "error" || thread.latestTurn?.state === "error") {
    return { kind: "blocked", statusLabel: "Error" };
  }
  return null;
}

/**
 * Cross-project Needs attention entries for the classic home / sidebar list:
 * board **Working** ∪ tightened **Review** (blocked-on-you), attention-first.
 */
export function buildHomeNeedsAttentionEntries(input: {
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly environmentId: EnvironmentId | null;
  /**
   * When set, only threads whose project is in this set are included
   * (project filter on home / sidebar).
   */
  readonly projectRefKeys?: ReadonlySet<string> | null;
  readonly searchQuery: string;
  /** Environments that support settle — others never classify as settled. */
  readonly settlementEnvironmentIds?: ReadonlySet<EnvironmentId>;
  /** Environments that support snooze — others never hide as snoozed. */
  readonly snoozeEnvironmentIds?: ReadonlySet<EnvironmentId>;
  /** Injectable clock for settle/snooze classification. */
  readonly now?: string;
}): ReadonlyArray<HomeNeedsAttentionEntry> {
  const now = input.now ?? new Date().toISOString();
  const projectByKey = new Map<string, EnvironmentProject>();
  for (const project of input.projects) {
    if (input.environmentId !== null && project.environmentId !== input.environmentId) {
      continue;
    }
    projectByKey.set(scopedProjectKey(project.environmentId, project.id), project);
  }

  const query = input.searchQuery.trim().toLocaleLowerCase();
  const entries: HomeNeedsAttentionEntry[] = [];

  for (const thread of input.threads) {
    if (thread.archivedAt !== null) continue;
    if (input.environmentId !== null && thread.environmentId !== input.environmentId) {
      continue;
    }
    const projectKey = scopedProjectKey(thread.environmentId, thread.projectId);
    if (input.projectRefKeys != null && !input.projectRefKeys.has(projectKey)) {
      continue;
    }
    const project = projectByKey.get(projectKey);
    if (!project) continue;
    if (query.length > 0 && !thread.title.toLocaleLowerCase().includes(query)) {
      continue;
    }

    const supportsSnooze = input.snoozeEnvironmentIds?.has(thread.environmentId) ?? true;
    if (supportsSnooze && effectiveSnoozed(thread, { now })) {
      continue;
    }

    const supportsSettlement = input.settlementEnvironmentIds?.has(thread.environmentId) ?? true;
    if (
      supportsSettlement &&
      effectiveSettled(thread, {
        now,
        autoSettleAfterDays: 3,
        changeRequestState: null,
      })
    ) {
      continue;
    }

    const classification = classifyNeedsAttention(thread);
    if (classification === null) continue;

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
