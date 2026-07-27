import { describe, expect, it } from "vite-plus/test";

import {
  getThreadRecencyBucketId,
  groupSortedThreadsByRecency,
  groupThreadsByRecency,
  startOfLocalDay,
  THREAD_RECENCY_BUCKET_LABELS,
} from "./threadRecencyGroups.ts";

describe("getThreadRecencyBucketId", () => {
  // Fixed local morning so calendar math is stable across CI timezones.
  const now = new Date(2026, 2, 15, 14, 30, 0); // 2026-03-15 local

  it("classifies today, yesterday, previous 7, previous 30, and older", () => {
    const startToday = startOfLocalDay(now).getTime();
    expect(getThreadRecencyBucketId(startToday + 60_000, now)).toBe("today");
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
  const now = new Date(2026, 2, 15, 12, 0, 0);
  const startToday = startOfLocalDay(now).getTime();

  it("returns only non-empty buckets in order with labels", () => {
    const threads = [
      { id: "t1", at: startToday + 1_000 },
      { id: "t2", at: startToday - 1_000 },
      { id: "t3", at: startToday - 40 * 24 * 60 * 60 * 1000 },
    ];
    const groups = groupThreadsByRecency(threads, (t) => t.at, now);
    expect(groups.map((g) => g.id)).toEqual(["today", "yesterday", "older"]);
    expect(groups[0]?.label).toBe(THREAD_RECENCY_BUCKET_LABELS.today);
    expect(groups[0]?.threads.map((t) => t.id)).toEqual(["t1"]);
    expect(groups[1]?.threads.map((t) => t.id)).toEqual(["t2"]);
    expect(groups[2]?.threads.map((t) => t.id)).toEqual(["t3"]);
  });

  it("preserves input order within a bucket", () => {
    const threads = [
      { id: "newer", at: startToday + 5_000 },
      { id: "older-today", at: startToday + 1_000 },
    ];
    const groups = groupThreadsByRecency(threads, (t) => t.at, now);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.threads.map((t) => t.id)).toEqual(["newer", "older-today"]);
  });
});

describe("groupSortedThreadsByRecency", () => {
  it("groups using activity timestamps from ThreadSortInput", () => {
    const now = new Date(2026, 2, 15, 12, 0, 0);
    const startToday = startOfLocalDay(now);
    const todayIso = new Date(startToday.getTime() + 3_600_000).toISOString();
    const olderIso = new Date(startToday.getTime() - 40 * 24 * 60 * 60 * 1000).toISOString();

    const groups = groupSortedThreadsByRecency(
      [
        {
          id: "a",
          createdAt: todayIso,
          updatedAt: todayIso,
          latestUserMessageAt: todayIso,
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

    expect(groups.map((g) => g.id)).toEqual(["today", "older"]);
    expect(groups[0]?.threads[0]?.id).toBe("a");
    expect(groups[1]?.threads[0]?.id).toBe("b");
  });
});
