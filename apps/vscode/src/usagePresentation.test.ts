import type { AiUsageSnapshot, OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  compareModelUsage,
  compactUsageSummary,
  deriveContextWindowUsage,
  usageForModel,
} from "./usagePresentation.ts";

describe("usage presentation", () => {
  it("derives the latest context window percentage", () => {
    const activities = [
      {
        kind: "context-window.updated",
        payload: { usedTokens: 50_000, maxTokens: 200_000, totalProcessedTokens: 80_000 },
      },
    ] as OrchestrationThreadActivity[];
    expect(deriveContextWindowUsage(activities)).toMatchObject({
      usedTokens: 50_000,
      maxTokens: 200_000,
      usedPercentage: 25,
      totalProcessedTokens: 80_000,
    });
  });

  it("maps models to their provider limits", () => {
    const snapshot = {
      available: true,
      items: [
        {
          provider: "codex",
          ok: true,
          windows: [
            { id: "5h", label: "5h", percent: 20 },
            { id: "weekly", label: "Weekly", percent: 65 },
          ],
        },
      ],
    } as AiUsageSnapshot;
    const usage = usageForModel(snapshot, "codex", "gpt-5");
    expect(compactUsageSummary(usage)).toBe("5h 20% · Weekly 65%");
  });

  it("detects when models under one driver use different plans", () => {
    const snapshot = {
      available: true,
      items: [
        { provider: "opencode", ok: true, windows: [{ id: "weekly", label: "Go", percent: 20 }] },
        { provider: "zai", ok: true, windows: [{ id: "weekly", label: "z.ai", percent: 70 }] },
      ],
    } as AiUsageSnapshot;
    expect(
      compareModelUsage(snapshot, [
        { driver: "opencode", model: "opencode-go/kimi-k2.5" },
        { driver: "opencode", model: "zai-coding-plan/glm-5" },
      ]),
    ).toEqual({
      summaries: ["Go 20%", "z.ai 70%"],
      commonSummary: null,
      varies: true,
    });
  });

  it("collapses matching model limits into one provider summary", () => {
    const snapshot = {
      available: true,
      items: [{ provider: "codex", ok: true, windows: [{ id: "5h", label: "5h", percent: 30 }] }],
    } as AiUsageSnapshot;
    expect(
      compareModelUsage(snapshot, [
        { driver: "codex", model: "gpt-5.6" },
        { driver: "codex", model: "gpt-5.5" },
      ]),
    ).toEqual({
      summaries: ["5h 30%", "5h 30%"],
      commonSummary: "5h 30%",
      varies: false,
    });
  });
});
