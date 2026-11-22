import type { IntegrationActivity as OrchestrationThreadActivity } from "./lib/integrationThreadView.ts";
import { describe, expect, it } from "vite-plus/test";

import { deriveContextWindowUsage } from "./usagePresentation.ts";

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
});
