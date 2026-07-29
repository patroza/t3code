import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  groupSortedThreadsByRecency,
  shouldShowRecencySectionHeaders,
} from "@t3tools/client-runtime/state/thread-recency-groups";

import type { PendingNewTask } from "../../state/use-pending-new-tasks";
import type { HomeThreadGroup } from "./homeThreadList";

/** Threads shown per project before the "Show more" affordance appears. */
export const HOME_INITIAL_VISIBLE_THREADS = 6;
/** Additional threads revealed per "Show more" tap. */
export const HOME_SHOW_MORE_STEP = 10;

export interface HomeGroupDisplayState {
  readonly collapsed: boolean;
  /** How many threads are currently revealed (clamped to the group size). */
  readonly visibleCount: number;
}

export const DEFAULT_GROUP_DISPLAY_STATE: HomeGroupDisplayState = {
  collapsed: false,
  visibleCount: HOME_INITIAL_VISIBLE_THREADS,
};

export interface HomeHeaderListItem {
  readonly type: "header";
  readonly key: string;
  readonly group: HomeThreadGroup;
  readonly collapsed: boolean;
  readonly isFirst: boolean;
}

/** Non-collapsible calendar section (Today / Yesterday / …). */
export interface HomeSectionHeaderListItem {
  readonly type: "section-header";
  readonly key: string;
  readonly title: string;
  readonly isFirst: boolean;
}

export interface HomeThreadListItem {
  readonly type: "thread";
  readonly key: string;
  readonly thread: EnvironmentThreadShell;
  readonly isLast: boolean;
  /** Optional project title for cross-project contexts (recency / flat). */
  readonly projectTitle?: string;
}

export interface HomePendingTaskListItem {
  readonly type: "pending-task";
  readonly key: string;
  readonly pendingTask: PendingNewTask;
  readonly isLast: boolean;
}

export interface HomeShowMoreListItem {
  readonly type: "show-more";
  readonly key: string;
  readonly groupKey: string;
  /** Threads still hidden. 0 means the group is fully expanded. */
  readonly hiddenCount: number;
  /** Whether more than the initial count is revealed, so "Show less" applies. */
  readonly canShowLess: boolean;
}

export type HomeListItem =
  | HomeHeaderListItem
  | HomeSectionHeaderListItem
  | HomePendingTaskListItem
  | HomeThreadListItem
  | HomeShowMoreListItem;

export interface HomeListLayout {
  readonly items: ReadonlyArray<HomeListItem>;
  readonly stickyHeaderIndices: ReadonlyArray<number>;
}

export type HomeGroupDisplayAction = "toggle-collapsed" | "show-more" | "show-less";

export function nextGroupDisplayState(
  current: HomeGroupDisplayState,
  action: HomeGroupDisplayAction,
): HomeGroupDisplayState {
  switch (action) {
    case "toggle-collapsed":
      return { ...current, collapsed: !current.collapsed };
    case "show-more":
      return { ...current, visibleCount: current.visibleCount + HOME_SHOW_MORE_STEP };
    case "show-less":
      return { ...current, visibleCount: HOME_INITIAL_VISIBLE_THREADS };
  }
}

/**
 * Structural equality for list items. Item objects are rebuilt on every
 * collapse/show-more toggle; without this the lists would consider every
 * mounted row changed and re-render all of them (each carrying a swipeable +
 * a vcs-status subscription). Group/thread references are stable across
 * toggles.
 */
export function homeListItemsAreEqual(previous: HomeListItem, item: HomeListItem): boolean {
  switch (item.type) {
    case "header":
      return (
        previous.type === "header" &&
        previous.group === item.group &&
        previous.collapsed === item.collapsed &&
        previous.isFirst === item.isFirst
      );
    case "section-header":
      return (
        previous.type === "section-header" &&
        previous.title === item.title &&
        previous.isFirst === item.isFirst
      );
    case "pending-task":
      return (
        previous.type === "pending-task" &&
        previous.pendingTask === item.pendingTask &&
        previous.isLast === item.isLast
      );
    case "thread":
      return (
        previous.type === "thread" &&
        previous.thread === item.thread &&
        previous.isLast === item.isLast &&
        previous.projectTitle === item.projectTitle
      );
    case "show-more":
      return (
        previous.type === "show-more" &&
        previous.groupKey === item.groupKey &&
        previous.hiddenCount === item.hiddenCount &&
        previous.canShowLess === item.canShowLess
      );
  }
}

export function buildHomeListLayout(input: {
  readonly groups: ReadonlyArray<HomeThreadGroup>;
  readonly displayStates: ReadonlyMap<string, HomeGroupDisplayState>;
  /**
   * When searching, pagination is suspended so every match stays visible.
   */
  readonly showAllThreads?: boolean;
}): HomeListLayout {
  const items: HomeListItem[] = [];
  const stickyHeaderIndices: number[] = [];

  for (const [groupIndex, group] of input.groups.entries()) {
    const display = input.displayStates.get(group.key) ?? DEFAULT_GROUP_DISPLAY_STATE;
    const collapsed = display.collapsed && input.showAllThreads !== true;

    stickyHeaderIndices.push(items.length);
    items.push({
      type: "header",
      key: `header:${group.key}`,
      group,
      collapsed,
      isFirst: groupIndex === 0,
    });

    if (collapsed) {
      continue;
    }

    const totalCount = group.threads.length;
    // Default to the group's recent-activity window (last few days, or a small
    // fallback for stale projects), capped at the initial page size. Until the
    // user taps "Show more", older threads stay hidden to save vertical space;
    // "Show less" resets visibleCount to the initial constant, which lands back
    // here at the recency baseline.
    const baselineCount = Math.min(
      group.recentThreads.length,
      HOME_INITIAL_VISIBLE_THREADS,
      totalCount,
    );
    const visibleCount = input.showAllThreads
      ? totalCount
      : Math.min(
          display.visibleCount > HOME_INITIAL_VISIBLE_THREADS
            ? display.visibleCount
            : baselineCount,
          totalCount,
        );
    const visibleThreads = group.threads.slice(0, visibleCount);
    const hiddenCount = totalCount - visibleCount;
    const hasShowMoreRow = !input.showAllThreads && totalCount > baselineCount;

    // Pending (unsent) tasks lead the group and are never paginated away.
    for (const [pendingIndex, pendingTask] of group.pendingTasks.entries()) {
      items.push({
        type: "pending-task",
        key: `pending-task:${pendingTask.message.messageId}`,
        pendingTask,
        isLast:
          pendingIndex === group.pendingTasks.length - 1 &&
          visibleThreads.length === 0 &&
          !hasShowMoreRow,
      });
    }

    for (const [threadIndex, thread] of visibleThreads.entries()) {
      items.push({
        type: "thread",
        key: `thread:${thread.environmentId}:${thread.id}`,
        thread,
        isLast: threadIndex === visibleThreads.length - 1 && !hasShowMoreRow,
      });
    }

    if (hasShowMoreRow) {
      items.push({
        type: "show-more",
        key: `show-more:${group.key}`,
        groupKey: group.key,
        hiddenCount,
        // Compare against the group's own baseline, not the global page size:
        // stale projects start below HOME_INITIAL_VISIBLE_THREADS, and "Show
        // less" must be offered as soon as anything beyond the baseline shows.
        canShowLess: visibleCount > baselineCount,
      });
    }
  }

  return { items, stickyHeaderIndices };
}

/**
 * Flat / recency Threads layouts: pending tasks first, then threads by activity.
 * Each thread row can carry a project title for multi-project context.
 * Callers apply hide-settled / project filters before building entries.
 *
 * When `groupByRecency` is true and more than one non-empty bucket has threads,
 * inserts Last Hour / Earlier Today / Yesterday / … section headers. A single
 * bucket renders flat (headers would only repeat the obvious).
 */
export function buildHomeRecentListLayout(input: {
  readonly pendingTasks: ReadonlyArray<PendingNewTask>;
  readonly entries: ReadonlyArray<{
    readonly thread: EnvironmentThreadShell;
    readonly projectTitle: string;
  }>;
  readonly groupByRecency?: boolean;
  readonly now?: Date;
}): HomeListLayout {
  const items: HomeListItem[] = [];
  const stickyHeaderIndices: number[] = [];

  const appendFlatThreads = () => {
    const total = input.pendingTasks.length + input.entries.length;
    for (const [index, entry] of input.entries.entries()) {
      const absoluteIndex = input.pendingTasks.length + index;
      items.push({
        type: "thread",
        key: `thread:${entry.thread.environmentId}:${entry.thread.id}`,
        thread: entry.thread,
        projectTitle: entry.projectTitle,
        isLast: absoluteIndex === total - 1,
      });
    }
  };

  for (const [index, pendingTask] of input.pendingTasks.entries()) {
    items.push({
      type: "pending-task",
      key: `pending-task:${pendingTask.message.messageId}`,
      pendingTask,
      isLast:
        index === input.pendingTasks.length - 1 &&
        input.entries.length === 0 &&
        input.groupByRecency !== true,
    });
  }

  if (input.groupByRecency !== true) {
    appendFlatThreads();
    return { items, stickyHeaderIndices: [] };
  }

  const projectTitleByThreadKey = new Map(
    input.entries.map((entry) => [
      `${entry.thread.environmentId}:${entry.thread.id}`,
      entry.projectTitle,
    ]),
  );
  const recencyGroups = groupSortedThreadsByRecency(
    input.entries.map((entry) => entry.thread),
    input.now,
  );

  // One non-empty bucket (or none): no section headers.
  if (!shouldShowRecencySectionHeaders(recencyGroups)) {
    // Pending isLast was computed assuming multi-bucket; fix for flat path.
    if (input.pendingTasks.length > 0) {
      const lastPendingIndex = input.pendingTasks.length - 1;
      const lastPending = items[lastPendingIndex];
      if (lastPending?.type === "pending-task") {
        items[lastPendingIndex] = {
          ...lastPending,
          isLast: input.entries.length === 0,
        };
      }
    }
    appendFlatThreads();
    return { items, stickyHeaderIndices: [] };
  }

  for (const [groupIndex, group] of recencyGroups.entries()) {
    stickyHeaderIndices.push(items.length);
    items.push({
      type: "section-header",
      key: `section:${group.id}`,
      title: group.label,
      isFirst: groupIndex === 0 && input.pendingTasks.length === 0,
    });

    for (const [threadIndex, thread] of group.threads.entries()) {
      items.push({
        type: "thread",
        key: `thread:${thread.environmentId}:${thread.id}`,
        thread,
        projectTitle: projectTitleByThreadKey.get(`${thread.environmentId}:${thread.id}`),
        isLast: groupIndex === recencyGroups.length - 1 && threadIndex === group.threads.length - 1,
      });
    }
  }

  return { items, stickyHeaderIndices };
}
