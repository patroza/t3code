// @effect-diagnostics globalDate:off
import { describe, expect, it } from "vite-plus/test";

import { teamsWeekBucket, weeklyThreadKey } from "./weeklyThreads.ts";

describe("teamsWeekBucket", () => {
  it("names the Monday that starts the week", () => {
    expect(teamsWeekBucket(new Date("2026-11-23T12:00:00Z"))).toBe("week-2026-11-23");
    expect(teamsWeekBucket(new Date("2026-11-26T12:00:00Z"))).toBe("week-2026-11-23");
    expect(teamsWeekBucket(new Date("2026-11-29T12:00:00Z"))).toBe("week-2026-11-23");
  });

  it("rolls over at Monday midnight in Amsterdam, not UTC", () => {
    // 23:30 UTC on Sunday is already 00:30 on Monday in Amsterdam (CET, UTC+1).
    expect(teamsWeekBucket(new Date("2026-11-29T23:30:00Z"))).toBe("week-2026-11-30");
    expect(teamsWeekBucket(new Date("2026-11-29T22:59:00Z"))).toBe("week-2026-11-23");
  });

  it("crosses month and year boundaries", () => {
    expect(teamsWeekBucket(new Date("2027-01-01T09:00:00Z"))).toBe("week-2026-12-28");
  });

  it("appends the bucket to a group chat key", () => {
    expect(weeklyThreadKey("native/t/group/19:chat", new Date("2026-11-24T09:00:00Z"))).toBe(
      "native/t/group/19:chat/week-2026-11-23",
    );
  });
});
