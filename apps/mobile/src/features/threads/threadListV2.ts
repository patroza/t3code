import {
  effectiveSnoozed,
  hasQueuedTurnStart,
  QUEUED_TURN_START_GRACE_MS,
  resolveSnoozePresets,
  snoozeWakeLabel,
} from "@t3tools/client-runtime/state/thread-settled";
import type { SnoozePreset } from "@t3tools/client-runtime/state/thread-settled";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { threadSearchMatchKey } from "@t3tools/client-runtime/state/thread-search";
import {
  groupSortedThreadsByRecency,
  shouldShowRecencySectionHeaders,
} from "@t3tools/client-runtime/state/thread-recency-groups";
import {
  activeThreadAnchorTimestampMs,
  resolveSettledThreadTimestamp,
  sortPinnedThreadsByOrderKey,
} from "@t3tools/client-runtime/state/thread-sort";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { threadMatchesAttributeQuery } from "@t3tools/shared/threadAttributeSearch";

import type { PendingNewTask } from "../../state/use-pending-new-tasks";

export { snoozeWakeLabel };

/**
 * Thread List v2 model, ported from the web sidebar v2
 * (apps/web/src/components/Sidebar.logic.ts + SidebarV2.tsx).
 *
 * Four visual states, three colors: color is reserved for "act now"
 * (approval), "in motion" (working), and "broken" (failed). Ready is the
 * unlabeled resting state.
 */
export type ThreadListV2Status = "approval" | "input" | "working" | "failed" | "ready";
export type ThreadListV2SwipeAction = "archive" | "settle" | "unsettle" | "snooze" | "unsnooze";

export function resolveThreadListV2SnoozeMenuSelection(input: {
  readonly event: string;
  readonly displayedPresets: ReadonlyArray<SnoozePreset>;
  readonly now: Date;
}):
  | { readonly _tag: "selected"; readonly preset: SnoozePreset }
  | { readonly _tag: "expired" }
  | { readonly _tag: "not-snooze" } {
  if (!input.event.startsWith("snooze:")) return { _tag: "not-snooze" };

  const currentPreset = resolveSnoozePresets(input.now).find(
    (candidate) => input.event === `snooze:${candidate.id}`,
  );
  if (currentPreset) return { _tag: "selected", preset: currentPreset };

  const displayedPreset = input.displayedPresets.find(
    (candidate) => input.event === `snooze:${candidate.id}`,
  );
  if (displayedPreset && Date.parse(displayedPreset.snoozedUntil) > input.now.getTime()) {
    return { _tag: "selected", preset: displayedPreset };
  }
  return { _tag: "expired" };
}

export function resolveThreadListV2SwipeActions(input: {
  readonly variant: "card" | "slim";
  readonly settlementSupported: boolean;
  readonly snoozeSupported: boolean;
  readonly snoozable: boolean;
  /** Row is on the snoozed shelf. */
  readonly snoozed?: boolean;
}): {
  readonly primary: Exclude<ThreadListV2SwipeAction, "snooze">;
  readonly secondary: "snooze" | null;
} {
  if (input.snoozed === true) {
    return { primary: "unsnooze", secondary: null };
  }
  const primary = input.settlementSupported
    ? input.variant === "slim"
      ? "unsettle"
      : "settle"
    : "archive";
  return {
    primary,
    secondary: input.snoozeSupported && input.snoozable ? "snooze" : null,
  };
}

/**
 * The point at which a queued-turn snooze guard expires on its own. Rows arm
 * a one-shot timer for this boundary so Snooze appears without waiting for an
 * unrelated render. User-blocked threads return null because only fresh
 * server data can make them snoozable.
 */
export function resolveThreadListV2SnoozeGateExpiryMs(
  thread: Pick<
    EnvironmentThreadShell,
    "hasPendingApprovals" | "hasPendingUserInput" | "latestUserMessageAt" | "latestTurn" | "session"
  >,
  options: { readonly now: string },
): number | null {
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return null;
  if (!hasQueuedTurnStart(thread, options)) return null;
  const messageAtMs = Date.parse(thread.latestUserMessageAt ?? "");
  if (Number.isNaN(messageAtMs)) return null;
  return messageAtMs + QUEUED_TURN_START_GRACE_MS;
}

// Settled-tail paging: recent history is the common lookup; the deep tail
// stays behind an explicit Show more. Shared by the compact Home list and
// the iPad sidebar so both page identically.
export const THREAD_LIST_V2_SETTLED_INITIAL_COUNT = 10;
export const THREAD_LIST_V2_SETTLED_PAGE_COUNT = 25;

/**
 * The flat Thread List v2 is the default on every app variant; the Settings →
 * Legacy toggle opts a device back into the grouped legacy list. Preferences
 * persist as sparse patches, so `undefined` genuinely means "never chosen".
 *
 * `preferencesLoaded` guards the startup window: preferences load
 * asynchronously, and rendering one list before the stored choice arrives would
 * remount the whole thing a tick later. While loading, hold the default — that
 * is where every device without an explicit legacy opt-in lands anyway.
 */
export function resolveThreadListV2Enabled(input: {
  readonly legacyPreference: boolean | undefined;
  readonly preferencesLoaded: boolean;
}): boolean {
  if (!input.preferencesLoaded) {
    return true;
  }
  return input.legacyPreference !== true;
}

export function resolveThreadListV2Status(
  thread: Pick<EnvironmentThreadShell, "hasPendingApprovals" | "hasPendingUserInput" | "session">,
): ThreadListV2Status {
  if (thread.hasPendingApprovals) {
    return "approval";
  }
  if (thread.hasPendingUserInput) {
    return "input";
  }
  if (thread.session?.status === "running" || thread.session?.status === "starting") {
    return "working";
  }
  if (thread.session?.status === "error") {
    return "failed";
  }
  return "ready";
}

/** NaN-safe Date.parse for sort comparators: a malformed timestamp must not
    poison the whole ordering, so it sinks to the epoch instead. */
function parseTimestampMs(isoDate: string): number {
  const parsed = Date.parse(isoDate);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** First VALID timestamp wins: a present-yet-malformed string falls through
    to the next candidate rather than sinking the row to the epoch. */
function firstValidTimestampMs(...candidates: ReadonlyArray<string | null | undefined>): number {
  for (const candidate of candidates) {
    if (candidate == null) continue;
    const parsed = Date.parse(candidate);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return 0;
}

/**
 * v2 sort: static order, newest anchor on top. Activity NEVER reorders the
 * list — a row holds its position between lifecycle transitions. The anchor
 * is creation time until an un-settle re-anchors it (see
 * activeThreadAnchorTimestampMs), so an un-settled thread surfaces at the
 * top instead of sinking back to its creation-order slot. Mirrors web's
 * sortThreadsForSidebar.
 */
export function sortThreadsForListV2<
  T extends {
    readonly id: string;
    readonly createdAt: string;
    readonly unsettledAt?: string | null | undefined;
  },
>(threads: readonly T[]): T[] {
  // .sort() on a copy, not .toSorted(): Hermes doesn't ship the ES2023
  // change-by-copy array methods.
  return [...threads].sort(
    (left, right) =>
      activeThreadAnchorTimestampMs(right) - activeThreadAnchorTimestampMs(left) ||
      left.id.localeCompare(right.id),
  );
}

export interface ThreadListV2Item {
  readonly thread: EnvironmentThreadShell;
  readonly variant: "card" | "slim";
  /** Snoozed-shelf row: shows the wake countdown and offers Wake. */
  readonly snoozed: boolean;
  /** Pinned-block row: renders the pin glyph and offers Unpin. */
  readonly pinned: boolean;
  readonly isLast: boolean;
}

export interface ThreadListV2Layout {
  readonly items: ThreadListV2Item[];
  /** Settled threads beyond the render limit (behind "Show more"). */
  readonly hiddenSettledCount: number;
  /** Snoozed threads matching the current filters. */
  readonly snoozedCount: number;
  /** Index in `items` where the Snoozed shelf header belongs. The header is
      still rendered when the shelf is collapsed and no snoozed rows exist. */
  readonly snoozedShelfHeaderIndex: number | null;
  /** Total settled threads in scope, including rows hidden by collapse/paging. */
  readonly settledCount: number;
  /** Index in `items` where the Settled shelf header belongs. */
  readonly settledShelfHeaderIndex: number | null;
  /** Soonest wake time among snoozed threads, or null. Callers arm
      a timeout at this boundary so the list re-partitions the moment a
      snooze expires instead of on the next minute tick. */
  readonly nextSnoozeWakeAt: string | null;
}

export interface ThreadListV2ThreadListItem {
  readonly type: "v2-thread";
  readonly key: string;
  readonly item: ThreadListV2Item;
  /** Precomputed so recycled-list equality can see a minute-tick change. */
  readonly snoozeWakeLabelText: string | undefined;
}

export interface ThreadListV2PendingListItem {
  readonly type: "v2-pending";
  readonly key: string;
  readonly pendingTask: PendingNewTask;
  /** First queued row after the active block draws the PENDING divider. */
  readonly showPendingDivider: boolean;
}

export interface ThreadListV2SnoozedShelfListItem {
  readonly type: "v2-snoozed-shelf";
  readonly key: "v2-snoozed-shelf";
  readonly count: number;
  readonly expanded: boolean;
}

export interface ThreadListV2SettledShelfListItem {
  readonly type: "v2-settled-shelf";
  readonly key: "v2-settled-shelf";
  readonly count: number;
  readonly expanded: boolean;
}

export interface ThreadListV2RecencyHeaderListItem {
  readonly type: "v2-recency-header";
  readonly key: string;
  readonly label: string;
  readonly section: "active" | "settled";
}

export type ThreadListV2ListItem =
  | ThreadListV2ThreadListItem
  | ThreadListV2PendingListItem
  | ThreadListV2SnoozedShelfListItem
  | ThreadListV2SettledShelfListItem
  | ThreadListV2RecencyHeaderListItem;

/**
 * Builds the shared mobile order: active → pending → snoozed shelf → settled.
 * Pending tasks are waiting rather than asking, and parked work remains
 * reachable without competing with either the inbox or settled history.
 */
export function buildThreadListV2ListItems(input: {
  readonly items: ReadonlyArray<ThreadListV2Item>;
  readonly pendingTasks: ReadonlyArray<PendingNewTask>;
  readonly snoozedCount?: number;
  readonly snoozedShelfExpanded?: boolean;
  readonly snoozedShelfHeaderIndex?: number | null;
  readonly settledCount?: number;
  readonly settledShelfExpanded?: boolean;
  readonly settledShelfHeaderIndex?: number | null;
  readonly snoozeLabelNow?: string;
  /** Adds activity buckets inside active and settled sections. Pinned cards
      remain above the active buckets. */
  readonly groupByRecency?: boolean;
}): ThreadListV2ListItem[] {
  const threadItems: ThreadListV2ThreadListItem[] = input.items.map(
    (item): ThreadListV2ThreadListItem => ({
      type: "v2-thread",
      key: `v2-thread:${item.thread.environmentId}:${item.thread.id}`,
      item,
      snoozeWakeLabelText:
        item.snoozed && item.thread.snoozedUntil != null && input.snoozeLabelNow !== undefined
          ? snoozeWakeLabel(item.thread.snoozedUntil, { now: input.snoozeLabelNow })
          : undefined,
    }),
  );
  const pendingItems = input.pendingTasks.map((pendingTask, index): ThreadListV2ListItem => ({
    type: "v2-pending",
    key: `v2-pending:${pendingTask.message.messageId}`,
    pendingTask,
    showPendingDivider: index === 0,
  }));
  const snoozedCount = input.snoozedCount ?? 0;
  const snoozedShelfHeaderIndex = input.snoozedShelfHeaderIndex ?? null;
  const settledCount = input.settledCount ?? 0;
  const settledShelfHeaderIndex = input.settledShelfHeaderIndex ?? null;
  const activeEnd = snoozedShelfHeaderIndex ?? settledShelfHeaderIndex ?? threadItems.length;
  const snoozedEnd = settledShelfHeaderIndex ?? threadItems.length;
  const addRecencyHeaders = (
    items: ReadonlyArray<ThreadListV2ThreadListItem>,
    section: "active" | "settled",
  ): ThreadListV2ListItem[] => {
    if (input.groupByRecency !== true) return [...items];
    const groups = groupSortedThreadsByRecency(
      items.map((item) => item.item.thread),
      input.snoozeLabelNow === undefined ? undefined : new Date(input.snoozeLabelNow),
    );
    if (!shouldShowRecencySectionHeaders(groups)) return [...items];
    const itemByKey = new Map(
      items.map((item) => [`${item.item.thread.environmentId}:${item.item.thread.id}`, item]),
    );
    return groups.flatMap((group) => [
      {
        type: "v2-recency-header" as const,
        key: `v2-recency-header:${section}:${group.id}`,
        label: group.label,
        section,
      },
      ...group.threads.flatMap((thread) => {
        const item = itemByKey.get(`${thread.environmentId}:${thread.id}`);
        return item === undefined ? [] : [item];
      }),
    ]);
  };
  const activeItems = threadItems.slice(0, activeEnd);
  const pinnedEnd = activeItems.findIndex((item) => !item.item.pinned);
  const pinnedItems = pinnedEnd < 0 ? activeItems : activeItems.slice(0, pinnedEnd);
  const unpinnedActiveItems = pinnedEnd < 0 ? [] : activeItems.slice(pinnedEnd);
  const result: ThreadListV2ListItem[] = [
    ...pinnedItems,
    ...addRecencyHeaders(unpinnedActiveItems, "active"),
    ...pendingItems,
  ];
  if (snoozedShelfHeaderIndex !== null && snoozedCount > 0) {
    result.push({
      type: "v2-snoozed-shelf",
      key: "v2-snoozed-shelf",
      count: snoozedCount,
      expanded: input.snoozedShelfExpanded === true,
    });
    result.push(...threadItems.slice(snoozedShelfHeaderIndex, snoozedEnd));
  }
  if (settledShelfHeaderIndex !== null && settledCount > 0) {
    result.push({
      type: "v2-settled-shelf",
      key: "v2-settled-shelf",
      count: settledCount,
      expanded: input.settledShelfExpanded !== false,
    });
    result.push(...addRecencyHeaders(threadItems.slice(settledShelfHeaderIndex), "settled"));
  }
  return result;
}

/**
 * Partitions visible threads into the active card block (creation order) and
 * the settled recency tail, matching the web Sidebar V2 list (and classic
 * Recent hide-settled shelf: history is shelved, never dropped). Callers must
 * not pass settledLimit: 0 to emulate "hide settled" — use paging only.
 * The server stamps settledOverride for the tail.
 */
export function buildThreadListV2Items(input: {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  /**
   * Multi-select environment filter. Empty = all environments.
   * Prefer this over the legacy single-id field.
   */
  readonly selectedEnvironmentIds?: readonly EnvironmentId[];
  /** @deprecated Use selectedEnvironmentIds. Kept for call-site migration. */
  readonly environmentId?: EnvironmentId | null;
  readonly projectRefs?: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
  }> | null;
  /** Default/false preserves upstream creation order. Recency changes only
      active and pinned card order; lifecycle sections and variants stay put. */
  readonly orderByRecency?: boolean;
  readonly searchQuery: string;
  readonly matchedThreadKeys?: ReadonlySet<string>;
  /** Environments whose server supports thread.settle/unsettle. Threads on
      other environments never classify as settled — the user could neither
      un-settle nor pin them. Absent = no gating (tests). */
  readonly settlementEnvironmentIds?: ReadonlySet<EnvironmentId>;
  /** Environments whose server supports thread.snooze/unsnooze. Same
      contract as settlementEnvironmentIds. */
  readonly snoozeEnvironmentIds?: ReadonlySet<EnvironmentId>;
  /** Max settled rows to render; the rest are counted, not built. */
  readonly settledLimit?: number;
  /** Second-precise clock used for time-based classification. */
  readonly now: string;
  /** Expands the snoozed shelf into rows. Collapsed is the default. */
  readonly snoozedShelfExpanded?: boolean;
  /** Expands the settled shelf into rows. Expanded is the default. */
  readonly settledShelfExpanded?: boolean;
  /** The selected thread remains visible on an otherwise collapsed shelf so
      a split-view detail can never lose its navigation row. */
  readonly selectedThreadKey?: string | null;
}): ThreadListV2Layout {
  const now = input.now;
  const query = input.searchQuery.trim().toLocaleLowerCase();
  const selectedEnvironmentIds =
    input.selectedEnvironmentIds ??
    (input.environmentId != null && input.environmentId !== undefined ? [input.environmentId] : []);
  const projectKeys = input.projectRefs
    ? new Set(input.projectRefs.map((ref) => `${ref.environmentId}:${ref.projectId}`))
    : null;
  const orderActiveThreads = (threads: ReadonlyArray<EnvironmentThreadShell>) => {
    const upstreamOrder = sortThreadsForListV2(threads);
    if (input.orderByRecency !== true) return upstreamOrder;
    return upstreamOrder.sort(
      (left, right) =>
        firstValidTimestampMs(right.latestUserMessageAt, right.updatedAt, right.createdAt) -
          firstValidTimestampMs(left.latestUserMessageAt, left.updatedAt, left.createdAt) ||
        left.id.localeCompare(right.id),
    );
  };

  const pinned: EnvironmentThreadShell[] = [];
  const active: EnvironmentThreadShell[] = [];
  const settled: EnvironmentThreadShell[] = [];
  const snoozed: EnvironmentThreadShell[] = [];
  let nextSnoozeWakeAt: string | null = null;
  for (const thread of input.threads) {
    // Callers pass live shells. The server stamps settledOverride for the tail.
    if (
      selectedEnvironmentIds.length > 0 &&
      !selectedEnvironmentIds.includes(thread.environmentId)
    ) {
      continue;
    }
    if (projectKeys !== null && !projectKeys.has(`${thread.environmentId}:${thread.projectId}`)) {
      continue;
    }
    if (
      query.length > 0 &&
      !threadMatchesAttributeQuery(
        {
          title: thread.title,
          branch: thread.branch,
          originSource: thread.originSource ?? null,
          participantSummaries: thread.participantSummaries ?? [],
        },
        query,
      ) &&
      input.matchedThreadKeys?.has(
        threadSearchMatchKey({
          environmentId: thread.environmentId,
          threadId: thread.id,
        }),
      ) !== true
    ) {
      continue;
    }
    const supportsSettlement = input.settlementEnvironmentIds?.has(thread.environmentId) ?? true;
    const supportsSnooze = input.snoozeEnvironmentIds?.has(thread.environmentId) ?? true;
    // Snooze outranks settlement and pinning until the thread wakes.
    if (supportsSnooze && effectiveSnoozed(thread, { now })) {
      snoozed.push(thread);
      if (
        thread.snoozedUntil != null &&
        (nextSnoozeWakeAt === null ||
          parseTimestampMs(thread.snoozedUntil) < parseTimestampMs(nextSnoozeWakeAt))
      ) {
        nextSnoozeWakeAt = thread.snoozedUntil;
      }
      continue;
    }
    if (supportsSettlement && thread.settledOverride === "settled") {
      settled.push(thread);
    } else if (thread.pinnedAt != null) {
      pinned.push(thread);
    } else {
      active.push(thread);
    }
  }

  const orderedActive = orderActiveThreads(active);
  const orderedSnoozed = [...snoozed].sort(
    (left, right) =>
      parseTimestampMs(left.snoozedUntil ?? "") - parseTimestampMs(right.snoozedUntil ?? ""),
  );
  const selectedThreadKey = input.selectedThreadKey ?? null;
  const visibleSnoozed =
    input.snoozedShelfExpanded === true
      ? orderedSnoozed
      : orderedSnoozed.filter(
          (thread) => `${thread.environmentId}:${thread.id}` === selectedThreadKey,
        );
  const orderedSettled = [...settled].sort(
    (left, right) =>
      parseTimestampMs(resolveSettledThreadTimestamp(right) ?? "") -
      parseTimestampMs(resolveSettledThreadTimestamp(left) ?? ""),
  );
  const settledLimit = input.settledLimit ?? Number.POSITIVE_INFINITY;
  const pagedSettled =
    orderedSettled.length > settledLimit ? orderedSettled.slice(0, settledLimit) : orderedSettled;
  const selectedSettled = orderedSettled
    .slice(pagedSettled.length)
    .find((thread) => `${thread.environmentId}:${thread.id}` === selectedThreadKey);
  if (selectedSettled !== undefined) pagedSettled.push(selectedSettled);
  const visibleSettled =
    input.settledShelfExpanded !== false
      ? pagedSettled
      : pagedSettled.filter(
          (thread) => `${thread.environmentId}:${thread.id}` === selectedThreadKey,
        );

  const items: ThreadListV2Item[] = [];
  // Pins carry an explicit user order (#5581); only the unpinned rows follow
  // the fork's grouping preference.
  for (const thread of sortPinnedThreadsByOrderKey(pinned)) {
    items.push({
      thread,
      variant: "card",
      snoozed: false,
      pinned: true,
      isLast: false,
    });
  }
  for (const thread of orderedActive) {
    items.push({
      thread,
      variant: "card",
      snoozed: false,
      pinned: false,
      isLast: false,
    });
  }
  const snoozedShelfHeaderIndex = orderedSnoozed.length > 0 ? items.length : null;
  for (const thread of visibleSnoozed) {
    items.push({
      thread,
      variant: "slim",
      snoozed: true,
      pinned: false,
      isLast: false,
    });
  }
  const settledShelfHeaderIndex = orderedSettled.length > 0 ? items.length : null;
  for (const thread of visibleSettled) {
    items.push({
      thread,
      variant: "slim",
      snoozed: false,
      pinned: false,
      isLast: false,
    });
  }
  const last = items.at(-1);
  if (last) {
    items[items.length - 1] = { ...last, isLast: true };
  }
  return {
    items,
    hiddenSettledCount: orderedSettled.length - pagedSettled.length,
    snoozedCount: orderedSnoozed.length,
    snoozedShelfHeaderIndex,
    settledCount: orderedSettled.length,
    settledShelfHeaderIndex,
    nextSnoozeWakeAt,
  };
}
