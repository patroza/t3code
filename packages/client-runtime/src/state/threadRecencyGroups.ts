import { getThreadSortTimestamp, type ThreadSortInput } from "./threadSort.ts";

/**
 * Calendar / activity buckets for cross-project thread lists grouped by recency.
 * "Today" is split so busy days stay scannable (Last hour vs Earlier today).
 */
export type ThreadRecencyBucketId =
  | "last_hour"
  | "earlier_today"
  | "yesterday"
  | "previous_7_days"
  | "previous_30_days"
  | "older";

export const THREAD_RECENCY_BUCKET_ORDER = [
  "last_hour",
  "earlier_today",
  "yesterday",
  "previous_7_days",
  "previous_30_days",
  "older",
] as const satisfies readonly ThreadRecencyBucketId[];

export const THREAD_RECENCY_BUCKET_LABELS: Record<ThreadRecencyBucketId, string> = {
  last_hour: "Last Hour",
  earlier_today: "Earlier Today",
  yesterday: "Yesterday",
  previous_7_days: "Previous 7 Days",
  previous_30_days: "Previous 30 Days",
  older: "Older",
};

const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

function makeLocalDate(
  year: number,
  monthIndex: number,
  day: number,
  hours = 0,
  minutes = 0,
  seconds = 0,
): Date {
  // @effect-diagnostics-next-line globalDate:off
  return new Date(year, monthIndex, day, hours, minutes, seconds);
}

function makeDateFromEpochMs(ms: number): Date {
  // @effect-diagnostics-next-line globalDate:off
  return new Date(ms);
}

function makeNow(): Date {
  // @effect-diagnostics-next-line globalDate:off
  return new Date();
}

export function startOfLocalDay(date: Date): Date {
  return makeLocalDate(date.getFullYear(), date.getMonth(), date.getDate());
}

/**
 * Classify an activity timestamp into a recency bucket using local calendar
 * days plus a rolling last-hour window for dense "today" lists.
 * `timestampMs` should be a finite epoch millis (activity / updated time).
 */
export function getThreadRecencyBucketId(
  timestampMs: number,
  now: Date = makeNow(),
): ThreadRecencyBucketId {
  if (!Number.isFinite(timestampMs)) {
    return "older";
  }

  const nowMs = now.getTime();
  const startToday = startOfLocalDay(now).getTime();

  if (timestampMs >= startToday) {
    if (timestampMs >= nowMs - MS_PER_HOUR) {
      return "last_hour";
    }
    return "earlier_today";
  }

  const startYesterday = startToday - MS_PER_DAY;
  if (timestampMs >= startYesterday) {
    return "yesterday";
  }

  const startPrevious7 = startToday - 7 * MS_PER_DAY;
  if (timestampMs >= startPrevious7) {
    return "previous_7_days";
  }

  const startPrevious30 = startToday - 30 * MS_PER_DAY;
  if (timestampMs >= startPrevious30) {
    return "previous_30_days";
  }

  return "older";
}

export interface ThreadRecencyGroup<T> {
  readonly id: ThreadRecencyBucketId;
  readonly label: string;
  readonly threads: readonly T[];
}

/**
 * Whether recency section headers should render. Empty buckets are already
 * omitted from `groups`; a single remaining bucket is still noise (e.g. every
 * thread is "Last Hour"), so callers should render a flat list in that case.
 */
export function shouldShowRecencySectionHeaders(
  groups: ReadonlyArray<ThreadRecencyGroup<unknown>>,
): boolean {
  return groups.length > 1;
}

/**
 * Partition already-sorted threads into non-empty recency groups.
 * Preserves input order within each bucket (callers should sort first).
 * Empty buckets are never returned.
 */
export function groupThreadsByRecency<T>(
  threads: readonly T[],
  getTimestampMs: (thread: T) => number,
  now: Date = makeNow(),
): ReadonlyArray<ThreadRecencyGroup<T>> {
  const buckets = new Map<ThreadRecencyBucketId, T[]>();
  for (const id of THREAD_RECENCY_BUCKET_ORDER) {
    buckets.set(id, []);
  }

  for (const thread of threads) {
    const id = getThreadRecencyBucketId(getTimestampMs(thread), now);
    buckets.get(id)?.push(thread);
  }

  const groups: ThreadRecencyGroup<T>[] = [];
  for (const id of THREAD_RECENCY_BUCKET_ORDER) {
    const bucketThreads = buckets.get(id) ?? [];
    if (bucketThreads.length === 0) continue;
    groups.push({
      id,
      label: THREAD_RECENCY_BUCKET_LABELS[id],
      threads: bucketThreads,
    });
  }
  return groups;
}

/**
 * Convenience for shells / summaries that share ThreadSortInput timestamps.
 * Uses the same activity timestamp as `sortThreads(..., "updated_at")`.
 */
export function groupSortedThreadsByRecency<T extends { readonly id: string } & ThreadSortInput>(
  threads: readonly T[],
  now: Date = makeNow(),
): ReadonlyArray<ThreadRecencyGroup<T>> {
  return groupThreadsByRecency(
    threads,
    (thread) => getThreadSortTimestamp(thread, "updated_at"),
    now,
  );
}
