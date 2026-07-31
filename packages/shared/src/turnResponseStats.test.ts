import { describe, expect, it } from "vite-plus/test";
import type { ModelSelection } from "@t3tools/contracts";
import { ProviderInstanceId } from "@t3tools/contracts";

import {
  appendStatsToMessageChunks,
  appendTurnResponseStatsFooter,
  deriveTurnResponseStats,
  formatCompactTokenCount,
  formatTurnResponseStatsLine,
} from "./turnResponseStats.ts";

const modelSelection = (
  model: string,
  options: ReadonlyArray<{ id: string; value: string | boolean }> = [],
): ModelSelection =>
  ({
    instanceId: ProviderInstanceId.make("codex"),
    model,
    options: [...options],
  }) as ModelSelection;

describe("formatCompactTokenCount", () => {
  it("formats small and large counts", () => {
    expect(formatCompactTokenCount(42)).toBe("42");
    expect(formatCompactTokenCount(1_500)).toBe("1.5k");
    expect(formatCompactTokenCount(12_400)).toBe("12k");
    expect(formatCompactTokenCount(1_200_000)).toBe("1.2m");
    expect(formatCompactTokenCount(null)).toBe(null);
  });
});

describe("formatTurnResponseStatsLine", () => {
  it("returns null when nothing is known", () => {
    expect(formatTurnResponseStatsLine({})).toBe(null);
  });

  it("formats model, effort, fast mode, duration, and tokens", () => {
    const line = formatTurnResponseStatsLine({
      modelSelection: modelSelection("gpt-5.4", [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: true },
      ]),
      activities: [
        {
          kind: "context-window.updated",
          turnId: "turn-1",
          payload: {
            usedTokens: 20_000,
            lastInputTokens: 12_400,
            lastOutputTokens: 2_100,
            lastReasoningOutputTokens: 1_000,
            durationMs: 84_000,
          },
        },
      ],
      turnId: "turn-1",
    });

    expect(line).toBe("_`gpt-5.4` · effort high · fast · 1m 24s · ↑12k ↓3.1k_");
  });

  it("uses Claude effort option and latestTurn wall-clock when durationMs missing", () => {
    const line = formatTurnResponseStatsLine({
      modelSelection: modelSelection("claude-opus-4-6", [{ id: "effort", value: "max" }]),
      turnId: "turn-2",
      latestTurn: {
        turnId: "turn-2",
        requestedAt: "2026-07-22T00:00:00.000Z",
        startedAt: "2026-07-22T00:00:10.000Z",
        completedAt: "2026-07-22T00:01:10.000Z",
      },
    });

    expect(line).toBe("_`claude-opus-4-6` · effort max · 1m_");
  });

  it("prefers matching turn usage over older activities", () => {
    const stats = deriveTurnResponseStats({
      turnId: "turn-2",
      activities: [
        {
          kind: "context-window.updated",
          turnId: "turn-1",
          payload: {
            usedTokens: 1,
            lastInputTokens: 100,
            lastOutputTokens: 50,
          },
        },
        {
          kind: "context-window.updated",
          turnId: "turn-2",
          payload: {
            usedTokens: 2,
            lastInputTokens: 9_000,
            lastOutputTokens: 400,
          },
        },
      ],
    });

    expect(stats.inputTokens).toBe(9_000);
    expect(stats.outputTokens).toBe(400);
  });
});

describe("appendTurnResponseStatsFooter", () => {
  it("appends once with blank line separation", () => {
    const withStats = appendTurnResponseStatsFooter("Hello", "_`m` · 1s_");
    expect(withStats).toBe("Hello\n\n_`m` · 1s_");
    expect(appendTurnResponseStatsFooter(withStats, "_`m` · 1s_")).toBe(withStats);
  });
});

describe("appendStatsToMessageChunks", () => {
  it("appends to the last chunk when it fits", () => {
    expect(appendStatsToMessageChunks(["part a", "part b"], "_stats_", 2000)).toEqual([
      "part a",
      "part b\n\n_stats_",
    ]);
  });

  it("adds a new chunk when the last would overflow", () => {
    const almostFull = "x".repeat(1990);
    expect(appendStatsToMessageChunks([almostFull], "_stats line_", 2000)).toEqual([
      almostFull,
      "_stats line_",
    ]);
  });

  it("replaces an empty last chunk with the stats line", () => {
    expect(appendStatsToMessageChunks([""], "_stats_", 2000)).toEqual(["_stats_"]);
  });
});
