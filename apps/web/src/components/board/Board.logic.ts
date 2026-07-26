import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentId,
  ProjectId,
  ProviderInteractionMode,
  ScopedProjectRef,
  VcsStatusResult,
} from "@t3tools/contracts";
import { toSortableTimestamp } from "../../lib/threadSort";
import { isCompletionUnseen, type ThreadStatusPill } from "../Sidebar.logic";
import { resolveThreadPr } from "../ThreadStatusIndicators";

export type BoardColumnId = "working" | "review" | "published" | "settled";

export const BOARD_COLUMN_IDS: readonly BoardColumnId[] = [
  "working",
  "review",
  "published",
  "settled",
];

export const BOARD_COLUMN_LABELS: Record<BoardColumnId, string> = {
  working: "Working",
  review: "Review",
  published: "Published",
  settled: "Settled",
};

export const BOARD_TRASH_DROPPABLE_ID = "board-trash";
export const BOARD_ARCHIVE_DROPPABLE_ID = "board-archive";
export const BOARD_UNSETTLE_DROPPABLE_ID = "board-unsettle";
export const BOARD_SETTLED_COLUMN_DROPPABLE_ID = "board-column-settled";

export type BoardDropIntent = "archive" | "trash" | "settle" | "unsettle";

/** Drag-overlay feedback per drop intent, shared by the card and group overlays. */
export const BOARD_DROP_INTENT_OVERLAY_CLASSES: Record<BoardDropIntent, string> = {
  archive: "scale-90 border-amber-500 opacity-60",
  trash: "scale-90 border-destructive opacity-60",
  settle: "scale-90 border-primary opacity-60",
  unsettle: "scale-90 border-emerald-500 opacity-60",
};

/**
 * Intent implied by the droppable currently under the pointer, or null when
 * the drag is over neither zone. Drives feedback on the dragged card itself —
 * the card usually covers the drop zone, hiding the zone's own highlight.
 */
export function resolveBoardDropIntent(
  droppableId: string | number | null | undefined,
): BoardDropIntent | null {
  if (droppableId === BOARD_ARCHIVE_DROPPABLE_ID) return "archive";
  if (droppableId === BOARD_TRASH_DROPPABLE_ID) return "trash";
  if (droppableId === BOARD_UNSETTLE_DROPPABLE_ID) return "unsettle";
  if (droppableId === BOARD_SETTLED_COLUMN_DROPPABLE_ID) return "settle";
  return null;
}

const BOARD_WORKTREE_GROUP_DRAG_PREFIX = "board-worktree-group\u0000";

/** Draggable id for a whole worktree group; drops act on every member thread. */
export function boardWorktreeGroupDragId(worktreeKey: string): string {
  return `${BOARD_WORKTREE_GROUP_DRAG_PREFIX}${worktreeKey}`;
}

/** Worktree key encoded in a group draggable id, or null for thread drags. */
export function parseBoardWorktreeGroupDragId(
  dragId: string | number | null | undefined,
): string | null {
  return typeof dragId === "string" && dragId.startsWith(BOARD_WORKTREE_GROUP_DRAG_PREFIX)
    ? dragId.slice(BOARD_WORKTREE_GROUP_DRAG_PREFIX.length)
    : null;
}

export interface BoardColumnInput {
  threadStatusLabel: ThreadStatusPill["label"] | null;
  interactionMode: ProviderInteractionMode;
  isSettled: boolean;
  latestTurnCompletedAt: string | null;
  readySessionUpdatedAt: string | null;
  lastVisitedAt: string | null;
  threadBranch: string | null;
  hasDedicatedWorktree: boolean;
  hasWorkingThreadForWorktree: boolean;
  gitStatus: VcsStatusResult | null;
}

/**
 * Whether the thread completed after the user's last visit. Falls back to the
 * ready-session timestamp for providers whose shell cannot retain a
 * latest-turn summary; both sources follow the sidebar's `isCompletionUnseen`
 * rules.
 */
export function hasUnseenBoardCompletion(
  input: Pick<
    BoardColumnInput,
    "latestTurnCompletedAt" | "readySessionUpdatedAt" | "lastVisitedAt"
  >,
): boolean {
  return isCompletionUnseen(
    input.latestTurnCompletedAt ?? input.readySessionUpdatedAt,
    input.lastVisitedAt,
  );
}

/**
 * Cache key for the board's aggregated VCS status map. Matches the dedupe
 * granularity of the underlying subscription family: one entry per unique
 * (environmentId, cwd) pair.
 */
export function boardGitKey(environmentId: EnvironmentId, cwd: string): string {
  return `${environmentId}\u0000${cwd}`;
}

/**
 * Git status a thread may be attributed at all, or null. Threads sharing the
 * project-root cwd must not inherit another branch's state, so without a
 * dedicated worktree the checked-out ref has to match the thread's branch.
 */
export function resolveAppliedBoardGitStatus(
  input: Pick<BoardColumnInput, "threadBranch" | "hasDedicatedWorktree" | "gitStatus">,
): VcsStatusResult | null {
  if (input.gitStatus === null || !input.gitStatus.isRepo) {
    return null;
  }
  if (input.hasDedicatedWorktree) {
    return input.gitStatus;
  }
  return input.threadBranch !== null && input.gitStatus.refName === input.threadBranch
    ? input.gitStatus
    : null;
}

/**
 * Lifecycle column for a thread. The server-backed settled flag is
 * authoritative — safe to check first because `effectiveSettled` is never
 * true for running or blocked threads, and it keeps a just-settled card from
 * bouncing back to review on an unseen completion pill. Attention states win
 * over the remaining lifecycle states: a thread blocked on the user
 * (question/permission prompt) or holding an unseen completion sits in
 * "review" regardless of git state. An actionable ready plan is also always
 * reviewable. Git-driven columns still only move a card rightward as statuses
 * stream in: unknown/unattributable git state falls through instead of
 * guessing.
 */
export function deriveBoardColumn(input: BoardColumnInput): BoardColumnId {
  if (input.isSettled) {
    return "settled";
  }

  switch (input.threadStatusLabel) {
    case "Pending Approval":
    case "Awaiting Input":
    case "Plan Ready":
    case "Completed":
      return "review";
    case "Working":
    case "Connecting":
      return "working";
    case null:
      break;
    default: {
      const exhaustiveStatusLabel: never = input.threadStatusLabel;
      return exhaustiveStatusLabel;
    }
  }

  if (hasUnseenBoardCompletion(input)) {
    return "review";
  }

  // A plan-mode thread does not own worktree changes made by the separate
  // implementation thread that consumed its plan. Keep its column tied to
  // its own attention/completion state instead of the shared worktree.
  const gitStatus = input.interactionMode === "plan" ? null : resolveAppliedBoardGitStatus(input);
  if (gitStatus !== null) {
    const hasUnpublishedWork =
      (gitStatus.hasWorkingTreeChanges && !input.hasWorkingThreadForWorktree) ||
      gitStatus.aheadCount > 0 ||
      (!gitStatus.hasUpstream && (gitStatus.aheadOfDefaultCount ?? 0) > 0);
    if (hasUnpublishedWork) {
      return "review";
    }

    // A merged PR is not special-cased here: it settles the thread through
    // `effectiveSettled` upstream. When that is unavailable (pinned active,
    // server without the settlement capability) the branch classifies by its
    // git state alone, since it could not be moved out of Settled anyway.
    const pr = resolveThreadPr(input);
    const isCleanPushedFeatureBranch =
      gitStatus.aheadCount === 0 && gitStatus.hasUpstream && !gitStatus.isDefaultRef;
    if (pr?.state === "open" || isCleanPushedFeatureBranch) {
      return "published";
    }
  }

  return "review";
}

export interface BoardSortableThread {
  readonly id: string;
  readonly updatedAt: string;
}

/** Sorts board threads newest-first by the timestamp selected for the column. */
export function sortBoardThreads<T extends BoardSortableThread>(
  threads: readonly T[],
  getSortTimestamp: (thread: T) => string | null,
): T[] {
  return [...threads].sort((left, right) => {
    const leftTimestamp =
      toSortableTimestamp(getSortTimestamp(left) ?? undefined) ?? Number.NEGATIVE_INFINITY;
    const rightTimestamp =
      toSortableTimestamp(getSortTimestamp(right) ?? undefined) ?? Number.NEGATIVE_INFINITY;
    if (leftTimestamp !== rightTimestamp) {
      return rightTimestamp > leftTimestamp ? 1 : -1;
    }
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
}

export type BoardColumnItem<T> =
  | { readonly kind: "thread"; readonly thread: T }
  | {
      readonly kind: "worktreeGroup";
      readonly worktreeKey: string;
      readonly threads: readonly T[];
    };

/**
 * Builds board items in lifecycle order. A shared group is emitted on its
 * first encounter, which is its earliest column and most recent member there.
 * Its members are already ordered by actual column, then that column's time.
 */
export function buildBoardColumns<T extends BoardSortableThread>(
  threads: readonly T[],
  getColumn: (thread: T) => BoardColumnId,
  getWorkingStartedAt: (thread: T) => string | null,
  getGroupKey: (thread: T) => string | null = () => null,
): Record<BoardColumnId, readonly BoardColumnItem<T>[]> {
  const threadsByColumn: Record<BoardColumnId, T[]> = {
    working: [],
    review: [],
    published: [],
    settled: [],
  };
  for (const thread of threads) {
    threadsByColumn[getColumn(thread)].push(thread);
  }
  for (const columnId of BOARD_COLUMN_IDS) {
    threadsByColumn[columnId] = sortBoardThreads(
      threadsByColumn[columnId],
      columnId === "working"
        ? (thread) => getWorkingStartedAt(thread) ?? thread.updatedAt
        : (thread) => thread.updatedAt,
    );
  }

  const groupMembersByKey = new Map<string, T[]>();
  for (const columnId of BOARD_COLUMN_IDS) {
    for (const thread of threadsByColumn[columnId]) {
      const groupKey = getGroupKey(thread);
      if (groupKey === null) {
        continue;
      }
      const members = groupMembersByKey.get(groupKey);
      if (members) {
        members.push(thread);
      } else {
        groupMembersByKey.set(groupKey, [thread]);
      }
    }
  }

  const columns: Record<BoardColumnId, BoardColumnItem<T>[]> = {
    working: [],
    review: [],
    published: [],
    settled: [],
  };
  const emittedGroupKeys = new Set<string>();
  for (const columnId of BOARD_COLUMN_IDS) {
    for (const thread of threadsByColumn[columnId]) {
      const groupKey = getGroupKey(thread);
      const groupMembers = groupKey === null ? undefined : groupMembersByKey.get(groupKey);
      if (groupKey === null || groupMembers === undefined || groupMembers.length < 2) {
        columns[columnId].push({ kind: "thread", thread });
        continue;
      }
      if (emittedGroupKeys.has(groupKey)) {
        continue;
      }
      emittedGroupKeys.add(groupKey);
      columns[columnId].push({
        kind: "worktreeGroup",
        worktreeKey: groupKey,
        threads: groupMembers,
      });
    }
  }
  return columns;
}

/** Total threads across column items; a worktree group counts each member. */
export function countBoardColumnThreads<T>(items: readonly BoardColumnItem<T>[]): number {
  return items.reduce(
    (count, item) => count + (item.kind === "thread" ? 1 : item.threads.length),
    0,
  );
}

/**
 * Settled-tail slice for the board column. The limit counts threads (a
 * worktree group counts as its member count) so paging matches the sidebar's
 * thread-based tail; a group straddling the limit is included whole since a
 * group card cannot render partially.
 */
export function sliceBoardSettledItems<T>(
  items: readonly BoardColumnItem<T>[],
  limit: number,
): { visibleItems: readonly BoardColumnItem<T>[]; hiddenThreadCount: number } {
  const total = countBoardColumnThreads(items);
  if (total <= limit) {
    return { visibleItems: items, hiddenThreadCount: 0 };
  }
  const visibleItems: BoardColumnItem<T>[] = [];
  let shown = 0;
  for (const item of items) {
    if (shown >= limit) break;
    visibleItems.push(item);
    shown += item.kind === "thread" ? 1 : item.threads.length;
  }
  return { visibleItems, hiddenThreadCount: total - shown };
}

export interface BoardWorktreeThread {
  readonly environmentId: EnvironmentId;
  readonly worktreePath: string | null;
}

/**
 * Identity of a thread's dedicated worktree for board grouping, or null when
 * the thread runs in the shared project checkout. Only dedicated worktrees
 * group: threads in the project root are unrelated lines of work even though
 * they share a checkout.
 */
export function boardWorktreeKey(thread: BoardWorktreeThread): string | null {
  const worktreePath = thread.worktreePath?.trim();
  if (!worktreePath) {
    return null;
  }
  return `${thread.environmentId}\u0000${worktreePath}`;
}

export interface BoardProjectFilterThread {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}

/**
 * Predicate matching threads against a selected sidebar project group.
 * Membership is by scoped project ref so locally+remotely-open copies of the
 * same repository stay one entry, matching the sidebar's grouping. An
 * unresolvable stored key (project removed, grouping changed) matches
 * everything, i.e. falls back to "All projects".
 */
export function buildBoardProjectFilterPredicate(input: {
  selectedProjectKey: string | null;
  snapshots: ReadonlyArray<{
    readonly projectKey: string;
    readonly memberProjectRefs: readonly ScopedProjectRef[];
  }>;
}): (thread: BoardProjectFilterThread) => boolean {
  const selectedSnapshot =
    input.selectedProjectKey === null
      ? null
      : (input.snapshots.find((snapshot) => snapshot.projectKey === input.selectedProjectKey) ??
        null);
  if (selectedSnapshot === null) {
    return () => true;
  }
  const memberKeys = new Set(selectedSnapshot.memberProjectRefs.map(scopedProjectKey));
  return (thread) =>
    memberKeys.has(scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId)));
}
