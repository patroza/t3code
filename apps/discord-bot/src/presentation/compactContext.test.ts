import { describe, expect, it } from "vite-plus/test";

import {
  extractLatestContextWindowStats,
  formatCompactionStatsReply,
  hasNewContextCompaction,
} from "./compactContext.ts";

describe("extractLatestContextWindowStats", () => {
  it("returns the newest resolvable context-window activity", () => {
    const stats = extractLatestContextWindowStats([
      {
        id: "a1",
        kind: "context-window.updated",
        payload: { usedTokens: 1000, maxTokens: 200_000 },
      },
      { id: "a2", kind: "context-compaction", payload: { state: "compacted" } },
      {
        id: "a3",
        kind: "context-window.updated",
        payload: { usedTokens: 12_400, maxTokens: 200_000 },
      },
    ]);
    expect(stats).toEqual({
      usedTokens: 12_400,
      maxTokens: 200_000,
      activityId: "a3",
    });
  });

  it("skips malformed rows", () => {
    expect(
      extractLatestContextWindowStats([
        { kind: "context-window.updated", payload: { usedTokens: -1 } },
        { kind: "context-window.updated", payload: { usedTokens: "nope" } },
      ]),
    ).toBeNull();
  });
});

describe("hasNewContextCompaction", () => {
  it("detects compact after a marker activity", () => {
    const activities = [
      { id: "w1", kind: "context-window.updated", payload: { usedTokens: 10 } },
      { id: "c1", kind: "context-compaction", payload: {} },
    ];
    expect(hasNewContextCompaction(activities, "w1")).toBe(true);
    expect(hasNewContextCompaction(activities, "c1")).toBe(false);
  });
});

describe("formatCompactionStatsReply", () => {
  it("formats a successful before → after with savings", () => {
    expect(
      formatCompactionStatsReply({
        before: { usedTokens: 45_200, maxTokens: 200_000, activityId: "b" },
        after: { usedTokens: 12_100, maxTokens: 200_000, activityId: "a" },
        compacted: true,
      }),
    ).toBe("Context compacted: **45k/200k** → **12k/200k** tokens (saved 33k, 73%).");
  });

  it("reports errors", () => {
    expect(
      formatCompactionStatsReply({
        before: null,
        after: null,
        compacted: false,
        error: "Provider grok does not support manual context compact.",
      }),
    ).toContain("Context compact failed:");
  });

  it("reports pending when not compacted yet", () => {
    expect(
      formatCompactionStatsReply({
        before: { usedTokens: 1500, maxTokens: null, activityId: null },
        after: { usedTokens: 1500, maxTokens: null, activityId: null },
        compacted: false,
      }),
    ).toContain("Current window:");
  });
});
