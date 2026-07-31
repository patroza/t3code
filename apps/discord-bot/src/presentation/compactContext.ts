/**
 * Context-window / compaction stats for `/omegent compact`.
 *
 * Pure helpers: extract latest context-window activity, format a public Discord
 * reply with before → after token counts.
 */
import { formatCompactTokenCount } from "@t3tools/shared/turnResponseStats";

export type ContextWindowStats = {
  readonly usedTokens: number;
  readonly maxTokens: number | null;
  readonly activityId: string | null;
};

export type CompactActivityLike = {
  readonly id?: string | null;
  readonly kind: string;
  readonly payload: unknown;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonNegativeInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.round(value);
}

/** Latest resolvable context-window.updated activity (walks newest → oldest). */
export function extractLatestContextWindowStats(
  activities: ReadonlyArray<CompactActivityLike>,
): ContextWindowStats | null {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (!activity || activity.kind !== "context-window.updated") continue;
    const payload = asRecord(activity.payload);
    if (payload === null) continue;
    const usedTokens = nonNegativeInt(payload.usedTokens);
    if (usedTokens === null) continue;
    const maxTokens = nonNegativeInt(payload.maxTokens);
    return {
      usedTokens,
      maxTokens,
      activityId: typeof activity.id === "string" ? activity.id : null,
    };
  }
  return null;
}

/** True when a newer context-compaction activity appeared after `sinceActivityId`. */
export function hasNewContextCompaction(
  activities: ReadonlyArray<CompactActivityLike>,
  sinceActivityId: string | null,
): boolean {
  let seenSince = sinceActivityId === null;
  for (const activity of activities) {
    if (!seenSince) {
      if (activity.id === sinceActivityId) seenSince = true;
      continue;
    }
    if (activity.kind === "context-compaction") return true;
  }
  // If we never found the marker (windowed out), any compact activity counts.
  if (!seenSince) {
    return activities.some((activity) => activity.kind === "context-compaction");
  }
  return false;
}

function formatTokens(value: number, maxTokens: number | null): string {
  const used = formatCompactTokenCount(value) ?? `${value}`;
  if (maxTokens === null) return used;
  const max = formatCompactTokenCount(maxTokens) ?? `${maxTokens}`;
  return `${used}/${max}`;
}

/**
 * Public Discord reply for a completed (or partial) compact attempt.
 */
export function formatCompactionStatsReply(input: {
  readonly before: ContextWindowStats | null;
  readonly after: ContextWindowStats | null;
  readonly compacted: boolean;
  readonly error?: string | null;
}): string {
  if (input.error !== undefined && input.error !== null && input.error.length > 0) {
    return `Context compact failed: ${input.error}`;
  }

  if (!input.compacted && input.before === null && input.after === null) {
    return "Context compact requested, but no context-window stats are available for this thread yet.";
  }

  if (!input.compacted) {
    const current = input.after ?? input.before;
    const currentLabel =
      current === null ? "unknown" : formatTokens(current.usedTokens, current.maxTokens);
    return `Context compact requested. Current window: **${currentLabel}** tokens (provider may still be compacting, or does not support manual compact).`;
  }

  const before = input.before;
  const after = input.after ?? input.before;
  if (before === null || after === null) {
    return "Context compacted.";
  }

  const beforeLabel = formatTokens(before.usedTokens, before.maxTokens);
  const afterLabel = formatTokens(after.usedTokens, after.maxTokens);
  const saved = before.usedTokens - after.usedTokens;
  if (saved > 0) {
    const savedLabel = formatCompactTokenCount(saved) ?? `${saved}`;
    const pct = Math.round((saved / Math.max(before.usedTokens, 1)) * 100);
    return `Context compacted: **${beforeLabel}** → **${afterLabel}** tokens (saved ${savedLabel}, ${pct}%).`;
  }
  if (saved < 0) {
    return `Context compacted: **${beforeLabel}** → **${afterLabel}** tokens.`;
  }
  return `Context compacted: **${afterLabel}** tokens.`;
}

/** How long the Discord command waits for compaction / token drop before reporting. */
export const COMPACT_WAIT_TIMEOUT_MS = 90_000;
export const COMPACT_POLL_INTERVAL_MS = 1_500;
