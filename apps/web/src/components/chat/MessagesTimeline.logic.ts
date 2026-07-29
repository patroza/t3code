import * as Equal from "effect/Equal";
import {
  compareSteerTimelineSortable,
  findMidTurnSteerUserIds,
  splitAssistantTextAtSteers,
  type SteerTimelineBoundaryStore,
} from "@t3tools/shared/steerTimeline";
import {
  formatDuration,
  workEntryIndicatesToolNeutralStatus,
  workLogEntryIsToolLike,
  type TimelineEntry,
  type WorkLogEntry,
  type WorkLogUserInput,
} from "../../session-logic";
import { type ChatMessage, type ProposedPlan, type TurnDiffSummary } from "../../types";
import { type MessageId, type OrchestrationLatestTurn, type TurnId } from "@t3tools/contracts";

export const MAX_VISIBLE_WORK_LOG_ENTRIES = 1;
export const TIMELINE_MINIMAP_ITEM_SPACING = 8;
export const TIMELINE_MINIMAP_MIN_ITEMS = 2;
export const TIMELINE_MINIMAP_MAX_HEIGHT_CSS = "calc(100vh - 18rem)";
export const TIMELINE_CONTENT_MAX_WIDTH = 768;
export const TIMELINE_MINIMAP_PERSISTENT_GUTTER = 48;

export interface TimelineEndState {
  readonly isAtEnd?: boolean;
  readonly isNearEnd?: boolean;
}

export interface OlderHistoryAutoLoadDecision {
  readonly armed: boolean;
  readonly observedProgressVersion: number;
  readonly shouldLoad: boolean;
}

/**
 * Treat reaching the start as an edge, not a continuously-true condition.
 * A failed request leaves the viewport at the start, so level-triggered loading
 * would immediately retry on every render. Leaving the start OR observing a
 * successfully advanced page cursor rearms one future automatic request. The
 * visible header control remains available for explicit retries while the edge
 * is disarmed.
 */
export function resolveOlderHistoryAutoLoad(input: {
  readonly armed: boolean;
  readonly hasMore: boolean;
  readonly isAtStart: boolean;
  readonly loading: boolean;
  readonly observedProgressVersion: number;
  readonly progressVersion: number;
}): OlderHistoryAutoLoadDecision {
  const progressed = input.progressVersion !== input.observedProgressVersion;
  const armed = input.armed || progressed;
  if (!input.isAtStart) {
    return {
      armed: true,
      observedProgressVersion: input.progressVersion,
      shouldLoad: false,
    };
  }
  if (!armed || !input.hasMore || input.loading) {
    return {
      armed,
      observedProgressVersion: input.progressVersion,
      shouldLoad: false,
    };
  }
  return {
    armed: false,
    observedProgressVersion: input.progressVersion,
    shouldLoad: true,
  };
}

export function resolveTimelineIsAtEnd(state: TimelineEndState | undefined): boolean | undefined {
  return state?.isNearEnd ?? state?.isAtEnd;
}

export function resolveTimelineMinimapHeightStyle(itemCount: number): string {
  const naturalHeight = Math.max(1, (itemCount - 1) * TIMELINE_MINIMAP_ITEM_SPACING);
  return `min(${naturalHeight}px, ${TIMELINE_MINIMAP_MAX_HEIGHT_CSS})`;
}

export function resolveTimelineMinimapTopPercent(index: number, itemCount: number): number {
  if (itemCount <= 1) {
    return 0;
  }
  return (Math.max(0, Math.min(index, itemCount - 1)) / (itemCount - 1)) * 100;
}

export function resolveTimelineMinimapIndexFromPointer(input: {
  readonly itemCount: number;
  readonly railTop: number;
  readonly railHeight: number;
  readonly pointerY: number;
}): number | null {
  if (input.itemCount <= 0 || input.railHeight <= 0) {
    return null;
  }
  if (input.itemCount === 1) {
    return 0;
  }

  const progress = Math.max(0, Math.min(1, (input.pointerY - input.railTop) / input.railHeight));
  return Math.max(0, Math.min(input.itemCount - 1, Math.round(progress * (input.itemCount - 1))));
}

export function resolveTimelineMinimapHasPersistentGutter(viewportWidth: number): boolean {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) {
    return false;
  }

  const contentWidth = Math.min(viewportWidth, TIMELINE_CONTENT_MAX_WIDTH);
  const sideGutter = Math.max(0, (viewportWidth - contentWidth) / 2);
  return sideGutter >= TIMELINE_MINIMAP_PERSISTENT_GUTTER;
}

export const TIMELINE_MINIMAP_HIT_STRIP_LEFT = 12;
export const TIMELINE_MINIMAP_HIT_STRIP_MAX_WIDTH = 40;
export const TIMELINE_MINIMAP_EXPANDED_HIT_STRIP_WIDTH = "22rem";

/**
 * The minimap overlays the viewport's left edge while the content column is
 * centered, so the side gutter between them shrinks under browser zoom or a
 * narrow pane. A fixed-width hover strip would then sit on top of the message
 * text and swallow its pointer events. Cap the strip's width so it never
 * extends past the gutter into the content column; 0 disables the strip.
 */
export function resolveTimelineMinimapHitStripWidth(viewportWidth: number): number {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) {
    return 0;
  }

  const contentWidth = Math.min(viewportWidth, TIMELINE_CONTENT_MAX_WIDTH);
  const sideGutter = Math.max(0, (viewportWidth - contentWidth) / 2);
  return Math.max(
    0,
    Math.min(
      TIMELINE_MINIMAP_HIT_STRIP_MAX_WIDTH,
      Math.floor(sideGutter) - TIMELINE_MINIMAP_HIT_STRIP_LEFT,
    ),
  );
}

/**
 * Once the preview is open, keep the full preview and the space leading to it
 * interactive. The collapsed strip remains gutter-capped so it cannot block
 * selecting message text.
 */
export function resolveTimelineMinimapInteractiveWidth(
  collapsedWidth: number,
  expanded: boolean,
): number | string {
  return expanded ? TIMELINE_MINIMAP_EXPANDED_HIT_STRIP_WIDTH : collapsedWidth;
}

function computeElapsedMs(startIso: string, endIso: string): number | null {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, end - start);
}

function maxIsoTimestamp(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  const aMs = Date.parse(a);
  const bMs = Date.parse(b);
  if (!Number.isFinite(aMs)) return b;
  if (!Number.isFinite(bMs)) return a;
  return bMs > aMs ? b : a;
}

export interface TimelineDurationMessage {
  id: string;
  role: "user" | "assistant" | "system";
  createdAt: string;
  updatedAt: string;
  streaming: boolean;
}

export type TimelineLatestTurn = Pick<
  OrchestrationLatestTurn,
  "turnId" | "state" | "startedAt" | "completedAt"
> & {
  /** When set, preferred terminal assistant for this turn (fold / copy meta). */
  readonly assistantMessageId?: MessageId | null;
};

export type MessagesTimelineRow =
  | {
      kind: "work";
      id: string;
      createdAt: string;
      groupedEntries: WorkLogEntry[];
    }
  | {
      kind: "work-toggle";
      id: string;
      createdAt: string;
      groupId: string;
      hiddenCount: number;
      expanded: boolean;
      onlyToolEntries: boolean;
    }
  | {
      kind: "turn-fold";
      id: string;
      createdAt: string;
      turnId: TurnId;
      label: string;
      expanded: boolean;
    }
  | {
      kind: "message";
      id: string;
      createdAt: string;
      message: ChatMessage;
      durationStart: string;
      showAssistantMeta: boolean;
      showAssistantCopyButton: boolean;
      assistantCopyStreaming: boolean;
      assistantTurnDiffSummary?: TurnDiffSummary | undefined;
      revertTurnCount?: number | undefined;
    }
  | {
      kind: "proposed-plan";
      id: string;
      createdAt: string;
      proposedPlan: ProposedPlan;
    }
  | {
      kind: "user-input";
      id: string;
      createdAt: string;
      entry: WorkLogEntry;
      userInput: WorkLogUserInput;
    }
  | { kind: "working"; id: string; createdAt: string | null };

export interface StableMessagesTimelineRowsState {
  byId: Map<string, MessagesTimelineRow>;
  result: MessagesTimelineRow[];
}

export function computeMessageDurationStart(
  messages: ReadonlyArray<TimelineDurationMessage>,
): Map<string, string> {
  const result = new Map<string, string>();
  let lastBoundary: string | null = null;

  for (const message of messages) {
    if (message.role === "user") {
      lastBoundary = message.createdAt;
    }
    result.set(message.id, lastBoundary ?? message.createdAt);
    if (message.role === "assistant" && !message.streaming) {
      lastBoundary = message.updatedAt;
    }
  }

  return result;
}

export function normalizeCompactToolLabel(value: string): string {
  return value.replace(/\s+(?:complete|completed)\s*$/i, "").trim();
}

export function resolveAssistantMessageCopyState({
  text,
  showCopyButton,
  streaming,
}: {
  text: string | null;
  showCopyButton: boolean;
  streaming: boolean;
}) {
  const hasText = text !== null && text.trim().length > 0;
  return {
    text: hasText ? text : null,
    visible: showCopyButton && hasText && !streaming,
  };
}

function deriveTerminalAssistantMessageIds(
  timelineEntries: ReadonlyArray<TimelineEntry>,
  preferredTerminalMessageIdByTurn: ReadonlyMap<TurnId, MessageId> = new Map(),
) {
  const lastAssistantMessageIdByResponseKey = new Map<string, string>();
  let nullTurnResponseIndex = 0;

  for (const timelineEntry of timelineEntries) {
    if (timelineEntry.kind !== "message") {
      continue;
    }
    const { message } = timelineEntry;
    if (message.role === "user") {
      nullTurnResponseIndex += 1;
      continue;
    }
    if (message.role !== "assistant") {
      continue;
    }

    const responseKey = message.turnId
      ? `turn:${message.turnId}`
      : `unkeyed:${nullTurnResponseIndex}`;
    lastAssistantMessageIdByResponseKey.set(responseKey, message.id);
  }

  // Prefer the turn projection's assistant_message_id when present — it stays
  // correct even if the message row was stamped with the next turn at drain.
  for (const [turnId, messageId] of preferredTerminalMessageIdByTurn) {
    const exists = timelineEntries.some(
      (entry) => entry.kind === "message" && entry.message.id === messageId,
    );
    if (exists) {
      lastAssistantMessageIdByResponseKey.set(`turn:${turnId}`, messageId);
    }
  }

  return new Set(lastAssistantMessageIdByResponseKey.values());
}

interface TurnFold {
  turnId: TurnId;
  anchorEntryId: string;
  createdAt: string;
  hiddenEntryIds: ReadonlySet<string>;
  label: string;
}

/**
 * The session's running turn is authoritative when latestTurn briefly lags or
 * regresses behind it. Otherwise, the latest turn counts as unsettled while it
 * is still running (or has not recorded a completion). This is deliberately
 * keyed on turn lifecycle rather than transient working state: right after the
 * user sends a message, the previous turn is still the "active" one until the
 * server creates the new turn, and folding must not flicker through that window.
 */
function deriveUnsettledTurnId(
  latestTurn: TimelineLatestTurn | null,
  runningTurnId: TurnId | null,
): TurnId | null {
  if (runningTurnId !== null) {
    return runningTurnId;
  }
  if (!latestTurn) {
    return null;
  }
  const isSettled = latestTurn.completedAt !== null && latestTurn.state !== "running";
  return isSettled ? null : latestTurn.turnId;
}

/**
 * Settled turns fold their commentary and tool activity behind a
 * "Worked for ..." row anchored at the turn's first foldable entry; the
 * terminal assistant message stays visible below the fold.
 */
function deriveTurnFolds(input: {
  timelineEntries: ReadonlyArray<TimelineEntry>;
  terminalAssistantMessageIds: ReadonlySet<string>;
  latestTurn: TimelineLatestTurn | null;
  unsettledTurnId: TurnId | null;
}): ReadonlyMap<string, TurnFold> {
  interface TurnGroup {
    entries: Array<TimelineEntry>;
    terminalEntry: Extract<TimelineEntry, { kind: "message" }> | null;
    hasStreamingMessage: boolean;
    /**
     * The user message that kicked the turn off. Entry timestamps alone
     * undercount the duration (the first entry appears only once the
     * provider starts producing output), and a turn cut short by a steer may
     * hold a single instantaneous commentary message.
     */
    startBoundary: string | null;
  }
  const groupsByTurnId = new Map<TurnId, TurnGroup>();

  let pendingUserBoundary: string | null = null;
  for (const entry of input.timelineEntries) {
    if (entry.kind === "message" && entry.message.role === "user") {
      pendingUserBoundary = entry.message.createdAt;
      continue;
    }
    const turnId =
      entry.kind === "message" && entry.message.role === "assistant"
        ? (entry.message.turnId ?? null)
        : entry.kind === "work"
          ? (entry.entry.turnId ?? null)
          : null;
    if (!turnId) {
      continue;
    }
    let group = groupsByTurnId.get(turnId);
    if (!group) {
      group = {
        entries: [],
        terminalEntry: null,
        hasStreamingMessage: false,
        // Each user boundary starts at most one turn; a second turn after the
        // same user message (e.g. a steer-superseded continuation) falls back
        // to its own first entry.
        startBoundary: pendingUserBoundary,
      };
      pendingUserBoundary = null;
      groupsByTurnId.set(turnId, group);
    }
    group.entries.push(entry);
    if (entry.kind === "message") {
      if (entry.message.streaming) {
        group.hasStreamingMessage = true;
      }
    }
  }

  // Queue-drain / turn flip can stamp the previous turn's final assistant
  // message with the *next* turn id at the same timestamp as the next user
  // message. Re-home those orphans so the fold keeps the real final visible.
  const userCreatedAts = input.timelineEntries
    .filter(
      (entry): entry is Extract<TimelineEntry, { kind: "message" }> =>
        entry.kind === "message" && entry.message.role === "user",
    )
    .map((entry) => entry.createdAt);
  const orderedTurns = [...groupsByTurnId.entries()].sort((left, right) => {
    const leftAt = left[1].entries[0]?.createdAt ?? left[1].startBoundary ?? "";
    const rightAt = right[1].entries[0]?.createdAt ?? right[1].startBoundary ?? "";
    return leftAt.localeCompare(rightAt);
  });
  for (let index = 1; index < orderedTurns.length; index += 1) {
    const previous = orderedTurns[index - 1];
    const current = orderedTurns[index];
    if (!previous || !current) continue;
    const [, previousGroup] = previous;
    const [, currentGroup] = current;
    const previousLastAt =
      previousGroup.entries.at(-1)?.createdAt ?? previousGroup.startBoundary ?? null;
    if (previousLastAt === null) continue;
    const nextUserAt = userCreatedAts.find((createdAt) => createdAt >= previousLastAt) ?? null;
    if (nextUserAt === null) continue;
    const firstAssistantIndex = currentGroup.entries.findIndex(
      (entry) => entry.kind === "message" && entry.message.role === "assistant",
    );
    if (firstAssistantIndex < 0) continue;
    const firstAssistant = currentGroup.entries[firstAssistantIndex];
    if (!firstAssistant || firstAssistant.kind !== "message") continue;
    // True first tokens of the next turn always land *after* that user message.
    if (firstAssistant.createdAt > nextUserAt) continue;
    currentGroup.entries.splice(firstAssistantIndex, 1);
    previousGroup.entries.push(firstAssistant);
  }

  // Resolve terminal after re-homing: the last assistant in the group is the
  // real final (status lines are earlier). latestTurn.assistantMessageId can
  // still point at the first commentary message, so it must not override the
  // chronological final.
  for (const group of groupsByTurnId.values()) {
    group.terminalEntry = null;
    let lastAssistant: Extract<TimelineEntry, { kind: "message" }> | null = null;
    for (const entry of group.entries) {
      if (entry.kind === "message" && entry.message.role === "assistant") {
        lastAssistant = entry;
      }
    }
    group.terminalEntry = lastAssistant;
  }

  const foldsByAnchorEntryId = new Map<string, TurnFold>();
  for (const [turnId, group] of groupsByTurnId) {
    if (turnId === input.unsettledTurnId) {
      continue;
    }
    if (group.hasStreamingMessage) {
      continue;
    }
    const hiddenEntryIds = new Set<string>();
    for (const entry of group.entries) {
      if (entry.id === group.terminalEntry?.id) {
        continue;
      }
      // A clarifying question and its answer record a decision the user made;
      // keep them readable once the turn settles instead of folding them away.
      if (entry.kind === "work" && entry.entry.userInput !== undefined) {
        continue;
      }
      hiddenEntryIds.add(entry.id);
    }
    if (hiddenEntryIds.size === 0) {
      continue;
    }

    const firstEntry = group.entries[0];
    const lastEntry = group.entries.at(-1);
    if (!firstEntry || !lastEntry) {
      continue;
    }

    const isLatestInterruptedTurn =
      input.latestTurn?.turnId === turnId && input.latestTurn.state === "interrupted";
    // A turn cut short by a steer leaves trailing work entries behind its
    // terminal message — take whichever ended last.
    const lastEntryEnd =
      lastEntry.kind === "message" ? lastEntry.message.updatedAt : lastEntry.createdAt;
    const elapsedMs =
      input.latestTurn?.turnId === turnId &&
      input.latestTurn.startedAt &&
      input.latestTurn.completedAt
        ? computeElapsedMs(input.latestTurn.startedAt, input.latestTurn.completedAt)
        : computeElapsedMs(
            group.startBoundary ?? firstEntry.createdAt,
            maxIsoTimestamp(group.terminalEntry?.message.updatedAt ?? null, lastEntryEnd) ??
              lastEntryEnd,
          );
    const duration = elapsedMs !== null ? formatDuration(elapsedMs) : null;
    const label = isLatestInterruptedTurn
      ? duration
        ? `You stopped after ${duration}`
        : "You stopped this response"
      : duration
        ? `Worked for ${duration}`
        : "Worked";

    foldsByAnchorEntryId.set(firstEntry.id, {
      turnId,
      anchorEntryId: firstEntry.id,
      createdAt: firstEntry.createdAt,
      hiddenEntryIds,
      label,
    });
  }
  return foldsByAnchorEntryId;
}

function timelineEntryBelongsToTurn(entry: TimelineEntry, turnId: TurnId): boolean {
  if (entry.kind === "work") {
    return entry.entry.turnId === turnId;
  }
  if (entry.kind === "message" && entry.message.role !== "user") {
    return entry.message.turnId === turnId;
  }
  if (entry.kind === "proposed-plan") {
    return entry.proposedPlan.turnId === turnId;
  }
  return false;
}

function collectTimelineTurnIds(timelineEntries: ReadonlyArray<TimelineEntry>): TurnId[] {
  const turnIds: TurnId[] = [];
  const seen = new Set<string>();
  for (const entry of timelineEntries) {
    const turnId =
      entry.kind === "work"
        ? entry.entry.turnId
        : entry.kind === "proposed-plan"
          ? entry.proposedPlan.turnId
          : entry.kind === "message"
            ? entry.message.turnId
            : null;
    if (turnId == null || seen.has(String(turnId))) {
      continue;
    }
    seen.add(String(turnId));
    turnIds.push(turnId);
  }
  return turnIds;
}

/**
 * Cursor/Codex steer while a turn is running reuses the active turn id and
 * keeps appending assistant deltas to an early message row. Chronological sort
 * alone parks that whole bubble above later steer user messages; the previous
 * "move steers above the turn" workaround parked them before *all* turn work.
 *
 * Instead, interleave by `createdAt` and split assistant text at client-observed
 * boundaries so steers sit between pre- and post-steer content (and between
 * tools that started before/after the steer).
 */
export function interleaveTimelineEntriesForSteeredTurn(
  timelineEntries: ReadonlyArray<TimelineEntry>,
  input: {
    /** When set, only this turn is expanded. When omitted, every turn with steers is. */
    readonly unsettledTurnId?: TurnId | null;
    readonly boundaryStore?: SteerTimelineBoundaryStore;
  } = {},
): TimelineEntry[] {
  const turnIds =
    input.unsettledTurnId !== undefined && input.unsettledTurnId !== null
      ? [input.unsettledTurnId]
      : collectTimelineTurnIds(timelineEntries);

  const steersByTurnId = new Map<
    string,
    ReadonlyArray<{ readonly id: string; readonly createdAt: string }>
  >();
  const steerIdSet = new Set<string>();

  for (const turnId of turnIds) {
    const steers = findMidTurnSteerUserIds({
      items: timelineEntries.map((entry) => ({
        id: entry.id,
        createdAt: entry.createdAt,
        isUser: entry.kind === "message" && entry.message.role === "user",
        belongsToActiveTurn: timelineEntryBelongsToTurn(entry, turnId),
      })),
    });
    if (steers.length === 0) {
      continue;
    }
    steersByTurnId.set(String(turnId), steers);
    for (const steer of steers) {
      steerIdSet.add(steer.id);
    }
  }

  if (steersByTurnId.size === 0) {
    return [...timelineEntries].toSorted((left, right) =>
      left.createdAt.localeCompare(right.createdAt),
    );
  }

  const expanded: Array<TimelineEntry & { sortRank: number }> = [];

  for (const entry of timelineEntries) {
    if (
      entry.kind === "message" &&
      entry.message.role === "assistant" &&
      entry.message.turnId !== null
    ) {
      const steers = steersByTurnId.get(String(entry.message.turnId));
      if (steers !== undefined && steers.length > 0) {
        const segments = splitAssistantTextAtSteers({
          assistantMessageId: entry.message.id,
          assistantCreatedAt: entry.message.createdAt,
          text: entry.message.text,
          streaming: entry.message.streaming,
          steers,
          ...(input.boundaryStore !== undefined ? { boundaryStore: input.boundaryStore } : {}),
        });

        for (const segment of segments) {
          expanded.push({
            id: segment.segmentId,
            kind: "message",
            createdAt: segment.sortAt,
            sortRank: segment.sortRank,
            message: {
              ...entry.message,
              text: segment.text,
              streaming: segment.streaming,
              // Segment sort key — keeps fold/duration helpers aligned with display order.
              createdAt: segment.sortAt,
              updatedAt: segment.streaming ? entry.message.updatedAt : segment.sortAt,
            },
          });
        }
        continue;
      }
    }

    expanded.push({
      ...entry,
      sortRank: steerIdSet.has(entry.id) ? 1 : 0,
    });
  }

  return expanded.toSorted((left, right) =>
    compareSteerTimelineSortable(
      { id: left.id, sortAt: left.createdAt, sortRank: left.sortRank },
      { id: right.id, sortAt: right.createdAt, sortRank: right.sortRank },
    ),
  );
}

/** @deprecated Use {@link interleaveTimelineEntriesForSteeredTurn}. */
export const reorderTimelineEntriesForSteeredTurn = (
  timelineEntries: ReadonlyArray<TimelineEntry>,
  input: {
    readonly unsettledTurnId?: TurnId | null;
    readonly isWorking?: boolean;
    readonly boundaryStore?: SteerTimelineBoundaryStore;
  },
): TimelineEntry[] =>
  interleaveTimelineEntriesForSteeredTurn(timelineEntries, {
    ...(input.unsettledTurnId !== undefined ? { unsettledTurnId: input.unsettledTurnId } : {}),
    ...(input.boundaryStore !== undefined ? { boundaryStore: input.boundaryStore } : {}),
  });

/**
 * Collapse assistant bubbles that re-surface the same body after tool activity
 * within a turn. Grok multi-step ACP has been observed to re-emit the prior
 * status line as a new message id after tools (A → tools → A → B); keep the
 * first status and drop the twin so the timeline reads A → tools → B.
 */
export function collapseConsecutiveDuplicateAssistantEntries(
  entries: ReadonlyArray<TimelineEntry>,
): TimelineEntry[] {
  const result: TimelineEntry[] = [];
  for (const entry of entries) {
    if (entry.kind !== "message" || entry.message.role !== "assistant") {
      result.push(entry);
      continue;
    }
    // Walk back across pure work rows so A → tools → A is detected.
    let lookback = result.length - 1;
    while (lookback >= 0 && result[lookback]?.kind === "work") {
      lookback -= 1;
    }
    const priorAssistant = lookback >= 0 ? result[lookback] : undefined;
    if (
      priorAssistant?.kind === "message" &&
      priorAssistant.message.role === "assistant" &&
      priorAssistant.message.turnId !== null &&
      priorAssistant.message.turnId === entry.message.turnId &&
      priorAssistant.message.text.replace(/\s+/g, " ").trim() ===
        entry.message.text.replace(/\s+/g, " ").trim() &&
      entry.message.text.trim().length > 0
    ) {
      // Drop this later twin; keep the earlier status and intervening tools.
      continue;
    }
    result.push(entry);
  }
  return result;
}

export function deriveMessagesTimelineRows(input: {
  timelineEntries: ReadonlyArray<TimelineEntry>;
  latestTurn?: TimelineLatestTurn | null;
  runningTurnId?: TurnId | null;
  expandedTurnIds?: ReadonlySet<TurnId>;
  expandedWorkGroupIds?: ReadonlySet<string>;
  isWorking: boolean;
  activeTurnStartedAt: string | null;
  turnDiffSummaryByAssistantMessageId: ReadonlyMap<MessageId, TurnDiffSummary>;
  revertTurnCountByUserMessageId: ReadonlyMap<MessageId, number>;
}): MessagesTimelineRow[] {
  const nextRows: MessagesTimelineRow[] = [];
  // Always expand steers for every turn that has them (live + settled). The
  // boundary store freezes pre-steer text on first observation so post-steer
  // tokens keep rendering after the steer once the turn settles.
  const displayTimelineEntries = collapseConsecutiveDuplicateAssistantEntries(
    interleaveTimelineEntriesForSteeredTurn(input.timelineEntries),
  );
  const durationStartByMessageId = computeMessageDurationStart(
    displayTimelineEntries.flatMap((entry) => (entry.kind === "message" ? [entry.message] : [])),
  );
  const preferredTerminalMessageIdByTurn = new Map<TurnId, MessageId>();
  if (input.latestTurn?.assistantMessageId != null) {
    preferredTerminalMessageIdByTurn.set(
      input.latestTurn.turnId,
      input.latestTurn.assistantMessageId,
    );
  }
  const terminalAssistantMessageIds = deriveTerminalAssistantMessageIds(
    displayTimelineEntries,
    preferredTerminalMessageIdByTurn,
  );
  const unsettledTurnId = deriveUnsettledTurnId(
    input.latestTurn ?? null,
    input.runningTurnId ?? null,
  );
  const foldsByAnchorEntryId = deriveTurnFolds({
    timelineEntries: displayTimelineEntries,
    terminalAssistantMessageIds,
    latestTurn: input.latestTurn ?? null,
    unsettledTurnId,
  });
  const collapsedEntryIds = new Set<string>();
  for (const fold of foldsByAnchorEntryId.values()) {
    if (!input.expandedTurnIds?.has(fold.turnId)) {
      for (const entryId of fold.hiddenEntryIds) {
        collapsedEntryIds.add(entryId);
      }
    }
  }

  for (let index = 0; index < displayTimelineEntries.length; index += 1) {
    const timelineEntry = displayTimelineEntries[index];
    if (!timelineEntry) {
      continue;
    }

    const turnFold = foldsByAnchorEntryId.get(timelineEntry.id);
    if (turnFold) {
      nextRows.push({
        kind: "turn-fold",
        id: `turn-fold:${turnFold.turnId}`,
        createdAt: turnFold.createdAt,
        turnId: turnFold.turnId,
        label: turnFold.label,
        expanded: input.expandedTurnIds?.has(turnFold.turnId) ?? false,
      });
    }

    if (collapsedEntryIds.has(timelineEntry.id)) {
      continue;
    }

    if (timelineEntry.kind === "work") {
      // Clarifying-question exchanges are conversation, not tool noise: they get
      // their own row so neither work-group collapsing nor a turn fold hides them.
      const userInput = timelineEntry.entry.userInput;
      if (userInput) {
        nextRows.push({
          kind: "user-input",
          id: timelineEntry.id,
          createdAt: timelineEntry.createdAt,
          entry: timelineEntry.entry,
          userInput,
        });
        continue;
      }

      const groupedEntries = [timelineEntry.entry];
      let cursor = index + 1;
      while (cursor < displayTimelineEntries.length) {
        const nextEntry = displayTimelineEntries[cursor];
        if (
          !nextEntry ||
          nextEntry.kind !== "work" ||
          nextEntry.entry.userInput !== undefined ||
          collapsedEntryIds.has(nextEntry.id) ||
          foldsByAnchorEntryId.has(nextEntry.id)
        ) {
          break;
        }
        groupedEntries.push(nextEntry.entry);
        cursor += 1;
      }
      const visibleGroupedEntries = groupedEntries.filter(
        (entry) => !workEntryIndicatesToolNeutralStatus(entry),
      );
      if (visibleGroupedEntries.length > 0) {
        if (visibleGroupedEntries.length <= MAX_VISIBLE_WORK_LOG_ENTRIES) {
          nextRows.push({
            kind: "work",
            id: timelineEntry.id,
            createdAt: timelineEntry.createdAt,
            groupedEntries: visibleGroupedEntries,
          });
        } else {
          const groupId = `work-group:${timelineEntry.id}`;
          const expanded = input.expandedWorkGroupIds?.has(groupId) ?? false;
          const hiddenEntries = visibleGroupedEntries.slice(0, -MAX_VISIBLE_WORK_LOG_ENTRIES);
          const visibleEntries = visibleGroupedEntries.slice(-MAX_VISIBLE_WORK_LOG_ENTRIES);
          const renderedEntries = expanded ? [...hiddenEntries, ...visibleEntries] : visibleEntries;

          for (const workEntry of renderedEntries) {
            nextRows.push({
              kind: "work",
              id: workEntry.id,
              createdAt: workEntry.createdAt,
              groupedEntries: [workEntry],
            });
          }

          nextRows.push({
            kind: "work-toggle",
            id: `work-toggle:${timelineEntry.id}`,
            createdAt: timelineEntry.createdAt,
            groupId,
            hiddenCount: hiddenEntries.length,
            expanded,
            onlyToolEntries: visibleGroupedEntries.every((entry) => workLogEntryIsToolLike(entry)),
          });
        }
      }
      index = cursor - 1;
      continue;
    }

    if (timelineEntry.kind === "proposed-plan") {
      nextRows.push({
        kind: "proposed-plan",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        proposedPlan: timelineEntry.proposedPlan,
      });
      continue;
    }

    const assistantTurnStillInProgress =
      timelineEntry.message.role === "assistant" &&
      unsettledTurnId !== null &&
      timelineEntry.message.turnId === unsettledTurnId;

    const durationStart =
      durationStartByMessageId.get(timelineEntry.message.id) ?? timelineEntry.message.createdAt;

    // While the turn is still running, the latest assistant message is only
    // provisionally terminal — withhold the metadata row until the turn
    // settles so commentary doesn't flash timestamps mid-work.
    const showAssistantMeta =
      timelineEntry.message.role === "assistant" &&
      terminalAssistantMessageIds.has(timelineEntry.message.id) &&
      !assistantTurnStillInProgress;

    nextRows.push({
      kind: "message",
      id: timelineEntry.id,
      createdAt: timelineEntry.createdAt,
      message: timelineEntry.message,
      durationStart,
      showAssistantMeta,
      showAssistantCopyButton: showAssistantMeta,
      assistantCopyStreaming: timelineEntry.message.streaming || assistantTurnStillInProgress,
      assistantTurnDiffSummary:
        timelineEntry.message.role === "assistant"
          ? input.turnDiffSummaryByAssistantMessageId.get(timelineEntry.message.id)
          : undefined,
      revertTurnCount:
        timelineEntry.message.role === "user"
          ? input.revertTurnCountByUserMessageId.get(timelineEntry.message.id)
          : undefined,
    });
  }

  if (input.isWorking) {
    nextRows.push({
      kind: "working",
      id: "working-indicator-row",
      createdAt: input.activeTurnStartedAt,
    });
  }

  return nextRows;
}

export function computeStableMessagesTimelineRows(
  rows: MessagesTimelineRow[],
  previous: StableMessagesTimelineRowsState,
): StableMessagesTimelineRowsState {
  const next = new Map<string, MessagesTimelineRow>();
  let anyChanged = rows.length !== previous.byId.size;

  const result = rows.map((row, index) => {
    const prevRow = previous.byId.get(row.id);
    const nextRow = prevRow && isRowUnchanged(prevRow, row) ? prevRow : row;
    next.set(row.id, nextRow);
    if (!anyChanged && previous.result[index] !== nextRow) {
      anyChanged = true;
    }
    return nextRow;
  });

  return anyChanged ? { byId: next, result } : previous;
}

/** Shallow field comparison per row variant — avoids deep equality cost. */
function isRowUnchanged(a: MessagesTimelineRow, b: MessagesTimelineRow): boolean {
  if (a.kind !== b.kind || a.id !== b.id) return false;

  switch (a.kind) {
    case "working":
      return a.createdAt === (b as typeof a).createdAt;

    case "turn-fold": {
      const bf = b as typeof a;
      return a.createdAt === bf.createdAt && a.label === bf.label && a.expanded === bf.expanded;
    }

    case "proposed-plan":
      return a.proposedPlan === (b as typeof a).proposedPlan;

    case "work":
      return Equal.equals(a.groupedEntries, (b as typeof a).groupedEntries);

    case "user-input":
      return Equal.equals(a.userInput, (b as typeof a).userInput);

    case "work-toggle": {
      const bw = b as typeof a;
      return (
        a.createdAt === bw.createdAt &&
        a.groupId === bw.groupId &&
        a.hiddenCount === bw.hiddenCount &&
        a.expanded === bw.expanded &&
        a.onlyToolEntries === bw.onlyToolEntries
      );
    }

    case "message": {
      const bm = b as typeof a;
      return (
        a.message === bm.message &&
        a.durationStart === bm.durationStart &&
        a.showAssistantMeta === bm.showAssistantMeta &&
        a.showAssistantCopyButton === bm.showAssistantCopyButton &&
        a.assistantCopyStreaming === bm.assistantCopyStreaming &&
        a.assistantTurnDiffSummary === bm.assistantTurnDiffSummary &&
        a.revertTurnCount === bm.revertTurnCount
      );
    }
  }
}
