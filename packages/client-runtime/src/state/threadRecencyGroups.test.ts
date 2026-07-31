import { describe, expect, it } from "vite-plus/test";

import {
  getThreadRecencyBucketId,
  groupSortedThreadsByRecency,
  groupThreadsByRecency,
  shouldShowRecencySectionHeaders,
  startOfLocalDay,
  THREAD_RECENCY_BUCKET_LABELS,
} from "./threadRecencyGroups.ts";

/** Local calendar fixture; Date APIs are intentional for bucket tests. */
function localDate(
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

function dateFromMs(ms: number): Date {
  // @effect-diagnostics-next-line globalDate:off
  return new Date(ms);
}

describe("getThreadRecencyBucketId", () => {
  // Fixed local afternoon so last-hour and earlier-today both fit in the day.
  const now = localDate(2026, 2, 15, 14, 30, 0); // 2026-03-15 14:30 local

  it("splits today into last hour vs earlier today", () => {
    const startToday = startOfLocalDay(now).getTime();
    const nowMs = now.getTime();
    expect(getThreadRecencyBucketId(nowMs - 5 * 60_000, now)).toBe("last_hour");
    expect(getThreadRecencyBucketId(nowMs - 59 * 60_000, now)).toBe("last_hour");
    expect(getThreadRecencyBucketId(nowMs - 61 * 60_000, now)).toBe("earlier_today");
    expect(getThreadRecencyBucketId(startToday + 60_000, now)).toBe("earlier_today");
  });

  it("classifies yesterday, previous 7, previous 30, and older", () => {
    const startToday = startOfLocalDay(now).getTime();
    expect(getThreadRecencyBucketId(startToday - 60_000, now)).toBe("yesterday");
    expect(getThreadRecencyBucketId(startToday - 3 * 24 * 60 * 60 * 1000, now)).toBe(
      "previous_7_days",
    );
    expect(getThreadRecencyBucketId(startToday - 14 * 24 * 60 * 60 * 1000, now)).toBe(
      "previous_30_days",
    );
    expect(getThreadRecencyBucketId(startToday - 45 * 24 * 60 * 60 * 1000, now)).toBe("older");
  });

  it("treats non-finite timestamps as older", () => {
    expect(getThreadRecencyBucketId(Number.NaN, now)).toBe("older");
  });
});

describe("groupThreadsByRecency", () => {
  const now = localDate(2026, 2, 15, 14, 30, 0);
  const startToday = startOfLocalDay(now).getTime();
  const nowMs = now.getTime();

  it("returns only non-empty buckets in order with labels", () => {
    const threads = [
      { id: "t1", at: nowMs - 10 * 60_000 },
      { id: "t2", at: startToday + 60_000 },
      { id: "t3", at: startToday - 40 * 24 * 60 * 60 * 1000 },
    ];
    const groups = groupThreadsByRecency(threads, (t) => t.at, now);
    expect(groups.map((g) => g.id)).toEqual(["last_hour", "earlier_today", "older"]);
    expect(groups[0]?.label).toBe(THREAD_RECENCY_BUCKET_LABELS.last_hour);
    expect(groups[0]?.threads.map((t) => t.id)).toEqual(["t1"]);
    expect(groups[1]?.threads.map((t) => t.id)).toEqual(["t2"]);
    expect(groups[2]?.threads.map((t) => t.id)).toEqual(["t3"]);
  });

  it("preserves input order within a bucket", () => {
    const threads = [
      { id: "newer", at: nowMs - 1_000 },
      { id: "older-hour", at: nowMs - 10 * 60_000 },
    ];
    const groups = groupThreadsByRecency(threads, (t) => t.at, now);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.id).toBe("last_hour");
    expect(groups[0]?.threads.map((t) => t.id)).toEqual(["newer", "older-hour"]);
  });

  it("omits empty buckets", () => {
    const groups = groupThreadsByRecency(
      [{ id: "only", at: nowMs - 2 * 60_000 }],
      (t) => t.at,
      now,
    );
    expect(groups.map((g) => g.id)).toEqual(["last_hour"]);
  });
});

describe("shouldShowRecencySectionHeaders", () => {
  it("is false for a single non-empty bucket", () => {
    expect(
      shouldShowRecencySectionHeaders([
        { id: "last_hour", label: "Last Hour", threads: [{ id: "a" }] },
      ]),
    ).toBe(false);
  });

  it("is true when two or more buckets have threads", () => {
    expect(
      shouldShowRecencySectionHeaders([
        { id: "last_hour", label: "Last Hour", threads: [{ id: "a" }] },
        { id: "yesterday", label: "Yesterday", threads: [{ id: "b" }] },
      ]),
    ).toBe(true);
  });

  it("is false for an empty groups array", () => {
    expect(shouldShowRecencySectionHeaders([])).toBe(false);
  });
});

describe("groupSortedThreadsByRecency", () => {
  it("groups using activity timestamps from ThreadSortInput", () => {
    const now = localDate(2026, 2, 15, 14, 30, 0);
    const startToday = startOfLocalDay(now);
    const lastHourIso = dateFromMs(now.getTime() - 5 * 60_000).toISOString();
    const olderIso = dateFromMs(startToday.getTime() - 40 * 24 * 60 * 60 * 1000).toISOString();

    const groups = groupSortedThreadsByRecency(
      [
        {
          id: "a",
          createdAt: lastHourIso,
          updatedAt: lastHourIso,
          latestUserMessageAt: lastHourIso,
        },
        {
          id: "b",
          createdAt: olderIso,
          updatedAt: olderIso,
          latestUserMessageAt: olderIso,
        },
      ],
      now,
    );

    expect(groups.map((g) => g.id)).toEqual(["last_hour", "older"]);
    expect(groups[0]?.threads[0]?.id).toBe("a");
    expect(groups[1]?.threads[0]?.id).toBe("b");
  });
});
