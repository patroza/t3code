import type { IntegrationActivity as OrchestrationThreadActivity } from "./lib/integrationThreadView.ts";

export interface ContextWindowUsage {
  readonly usedTokens: number;
  readonly maxTokens: number | null;
  readonly usedPercentage: number | null;
  readonly totalProcessedTokens: number | null;
  readonly compactsAutomatically: boolean;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function deriveContextWindowUsage(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ContextWindowUsage | null {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (activity?.kind !== "context-window.updated") continue;
    const payload =
      typeof activity.payload === "object" && activity.payload !== null
        ? (activity.payload as Record<string, unknown>)
        : null;
    const usedTokens = finiteNumber(payload?.usedTokens);
    if (usedTokens === null || usedTokens < 0) continue;
    const maxTokensValue = finiteNumber(payload?.maxTokens);
    const maxTokens = maxTokensValue !== null && maxTokensValue > 0 ? maxTokensValue : null;
    return {
      usedTokens,
      maxTokens,
      usedPercentage: maxTokens === null ? null : Math.min(100, (usedTokens / maxTokens) * 100),
      totalProcessedTokens: finiteNumber(payload?.totalProcessedTokens),
      compactsAutomatically: payload?.compactsAutomatically === true,
    };
  }
  return null;
}
