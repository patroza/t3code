/**
 * Mid-turn steer timeline interleave helpers.
 *
 * Providers often reuse one assistant message row for an entire turn while
 * steer user messages arrive with a later `createdAt`. Pure chronological
 * sort then parks the whole assistant bubble above the steer; coarse reorders
 * park every steer above all turn work. These helpers split assistant text at
 * client-observed boundaries so steers can sit between pre- and post-steer
 * content without Orchestration V2.
 */

export type SteerTimelineBoundaryStore = Map<string, number>;

const defaultBoundaryStore: SteerTimelineBoundaryStore = new Map();

export function steerTimelineBoundaryKey(
  assistantMessageId: string,
  steerMessageId: string,
): string {
  return `${assistantMessageId}::${steerMessageId}`;
}

/** Test helper — clears the process-wide default boundary store. */
export function clearSteerTimelineBoundaryStore(
  store: SteerTimelineBoundaryStore = defaultBoundaryStore,
): void {
  store.clear();
}

/**
 * Remember how much assistant text existed when a steer first became visible.
 * Later tokens only grow the post-steer segment; the boundary never advances.
 */
export function observeSteerTextBoundary(
  assistantMessageId: string,
  steerMessageId: string,
  currentTextLength: number,
  store: SteerTimelineBoundaryStore = defaultBoundaryStore,
): number {
  const key = steerTimelineBoundaryKey(assistantMessageId, steerMessageId);
  const existing = store.get(key);
  if (existing !== undefined) {
    return Math.min(existing, Math.max(0, currentTextLength));
  }
  const observed = Math.max(0, currentTextLength);
  store.set(key, observed);
  return observed;
}

export interface SteerAssistantSegment {
  readonly segmentId: string;
  readonly text: string;
  /** Sort timestamp for this segment. */
  readonly sortAt: string;
  /**
   * Tie-break after `sortAt`: lower ranks first.
   * 0 = pre-steer / normal work, 1 = steer user message, 2 = post-steer assistant.
   */
  readonly sortRank: number;
  readonly streaming: boolean;
}

/**
 * Split one assistant message across mid-turn steer timestamps.
 * Returns a single segment (the original message) when no steers apply.
 */
export function splitAssistantTextAtSteers(input: {
  readonly assistantMessageId: string;
  readonly assistantCreatedAt: string;
  readonly text: string;
  readonly streaming: boolean;
  readonly steers: ReadonlyArray<{ readonly id: string; readonly createdAt: string }>;
  readonly boundaryStore?: SteerTimelineBoundaryStore;
}): ReadonlyArray<SteerAssistantSegment> {
  const store = input.boundaryStore ?? defaultBoundaryStore;
  const steersAfterStart = input.steers
    .filter((steer) => steer.createdAt > input.assistantCreatedAt)
    .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));

  if (steersAfterStart.length === 0) {
    return [
      {
        segmentId: input.assistantMessageId,
        text: input.text,
        sortAt: input.assistantCreatedAt,
        sortRank: 0,
        streaming: input.streaming,
      },
    ];
  }

  const boundaries = steersAfterStart.map((steer) =>
    observeSteerTextBoundary(input.assistantMessageId, steer.id, input.text.length, store),
  );

  const cutPoints = [0, ...boundaries, input.text.length];
  const segments: SteerAssistantSegment[] = [];

  for (let index = 0; index < cutPoints.length - 1; index += 1) {
    const start = cutPoints[index]!;
    const end = cutPoints[index + 1]!;
    const text = input.text.slice(start, end);
    const isLast = index === cutPoints.length - 2;
    const isFirst = index === 0;
    const streaming = input.streaming && isLast;

    if (text.length === 0 && !streaming) {
      continue;
    }

    if (isFirst) {
      segments.push({
        segmentId: `${input.assistantMessageId}::pre`,
        text,
        sortAt: input.assistantCreatedAt,
        sortRank: 0,
        streaming: false,
      });
      continue;
    }

    const precedingSteer = steersAfterStart[index - 1]!;
    segments.push({
      segmentId: `${input.assistantMessageId}::after::${precedingSteer.id}`,
      text,
      sortAt: precedingSteer.createdAt,
      sortRank: 2,
      streaming,
    });
  }

  if (segments.length === 0) {
    return [
      {
        segmentId: input.assistantMessageId,
        text: input.text,
        sortAt: input.assistantCreatedAt,
        sortRank: 0,
        streaming: input.streaming,
      },
    ];
  }

  return segments;
}

export interface SteerTimelineSortable {
  readonly sortAt: string;
  readonly sortRank: number;
  readonly id: string;
}

export function compareSteerTimelineSortable(
  left: SteerTimelineSortable,
  right: SteerTimelineSortable,
): number {
  const byTime = left.sortAt.localeCompare(right.sortAt);
  if (byTime !== 0) {
    return byTime;
  }
  if (left.sortRank !== right.sortRank) {
    return left.sortRank - right.sortRank;
  }
  return left.id.localeCompare(right.id);
}

/**
 * Identify mid-turn user messages that should interleave with turn work.
 * `belongsToTurn` should be true for assistant/work/plan rows of the active turn
 * (not for user rows).
 */
export function findMidTurnSteerUserIds(input: {
  readonly items: ReadonlyArray<{
    readonly id: string;
    readonly createdAt: string;
    readonly isUser: boolean;
    readonly belongsToActiveTurn: boolean;
  }>;
}): ReadonlyArray<{ readonly id: string; readonly createdAt: string }> {
  const sorted = input.items.toSorted((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );

  let turnStartUserBoundary: string | null = null;
  for (const item of sorted) {
    if (item.belongsToActiveTurn) {
      break;
    }
    if (item.isUser) {
      turnStartUserBoundary = item.createdAt;
    }
  }

  if (turnStartUserBoundary === null) {
    return [];
  }

  return sorted.flatMap((item) => {
    if (!item.isUser || item.createdAt <= turnStartUserBoundary!) {
      return [];
    }
    return [{ id: item.id, createdAt: item.createdAt }];
  });
}
