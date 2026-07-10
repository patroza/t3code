import type { AiUsageSnapshot, OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
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
});
