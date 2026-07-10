import type {
  AiUsageProviderStatus,
  AiUsageSnapshot,
  AiUsageWindow,
  OrchestrationThreadActivity,
} from "@t3tools/contracts";

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

export function usageProviderForModel(driver: string, model: string): string | null {
  if (driver === "codex") return "codex";
  if (driver === "claudeAgent") return "claude";
  if (driver === "cursor") return "cursor";
  if (driver === "grok") return "grok";
  if (driver === "opencode") return model.startsWith("zai-coding-plan/") ? "zai" : "opencode";
  return null;
}

export function usageForModel(
  snapshot: AiUsageSnapshot | null,
  driver: string,
  model: string,
): AiUsageProviderStatus | null {
  if (snapshot?.available !== true) return null;
  const provider = usageProviderForModel(driver, model);
  return snapshot.items.find((item) => item.provider === provider) ?? null;
}

export function formatUsageWindow(window: AiUsageWindow): string {
  if (typeof window.percent === "number") return `${window.label} ${Math.round(window.percent)}%`;
  if (typeof window.used === "number") {
    return `${window.label} ${window.unit === "$" ? `$${window.used.toFixed(2)}` : window.used}`;
  }
  return window.label;
}

export function compactUsageSummary(item: AiUsageProviderStatus | null): string {
  if (item === null) return "";
  return item.windows
    .filter((window) => typeof window.percent === "number" || typeof window.used === "number")
    .slice(0, 3)
    .map(formatUsageWindow)
    .join(" · ");
}
