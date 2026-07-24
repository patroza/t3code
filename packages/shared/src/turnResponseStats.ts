import type { ModelSelection } from "@t3tools/contracts";

import {
  getModelSelectionBooleanOptionValue,
  getModelSelectionStringOptionValue,
} from "./model.ts";
import { formatDuration, formatElapsed } from "./orchestrationTiming.ts";

/** Minimal activity shape — plain turnId so callers need not brand strings. */
export type TurnStatsActivity = {
  readonly kind: string;
  readonly turnId?: string | null;
  readonly payload: unknown;
};

export type TurnTokenUsageFields = {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly reasoningOutputTokens: number | null;
  readonly durationMs: number | null;
};

export type TurnResponseStats = {
  readonly model: string | null;
  readonly effort: string | null;
  readonly fastMode: boolean;
  readonly durationLabel: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nonNegativeInt(value: unknown): number | null {
  const n = asFiniteNumber(value);
  if (n === null || n < 0) return null;
  return Math.round(n);
}

/**
 * Compact token counts for footers (matches web context-window style).
 */
export function formatCompactTokenCount(value: number | null | undefined): string | null {
  if (value === null || value === undefined || !Number.isFinite(value) || value < 0) {
    return null;
  }
  if (value < 1_000) return `${Math.round(value)}`;
  if (value < 10_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/u, "")}k`;
  if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/u, "")}m`;
}

function modelSlug(modelSelection: ModelSelection | null | undefined): string | null {
  if (modelSelection === null || modelSelection === undefined) return null;
  const model = typeof modelSelection.model === "string" ? modelSelection.model.trim() : "";
  return model.length > 0 ? model : null;
}

function effortLabel(modelSelection: ModelSelection | null | undefined): string | null {
  const reasoning = getModelSelectionStringOptionValue(modelSelection, "reasoningEffort");
  if (reasoning !== undefined && reasoning.trim() !== "") return reasoning.trim();
  const effort = getModelSelectionStringOptionValue(modelSelection, "effort");
  if (effort !== undefined && effort.trim() !== "") return effort.trim();
  return null;
}

function isFastMode(modelSelection: ModelSelection | null | undefined): boolean {
  return getModelSelectionBooleanOptionValue(modelSelection, "fastMode") === true;
}

/**
 * Prefer turn-scoped last* token fields; fall back to cumulative input/output on the snapshot.
 * Output includes reasoning tokens when reported separately.
 */
export function deriveTurnTokenUsageFromActivities(
  activities: ReadonlyArray<TurnStatsActivity>,
  turnId: string | null | undefined = null,
): TurnTokenUsageFields | null {
  let fallback: TurnTokenUsageFields | null = null;

  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (!activity || activity.kind !== "context-window.updated") continue;

    const payload = asRecord(activity.payload);
    if (payload === null) continue;

    const inputTokens =
      nonNegativeInt(payload.lastInputTokens) ?? nonNegativeInt(payload.inputTokens);
    const baseOutput =
      nonNegativeInt(payload.lastOutputTokens) ?? nonNegativeInt(payload.outputTokens);
    const reasoning =
      nonNegativeInt(payload.lastReasoningOutputTokens) ??
      nonNegativeInt(payload.reasoningOutputTokens);
    const outputTokens =
      baseOutput === null && reasoning === null ? null : (baseOutput ?? 0) + (reasoning ?? 0);
    const durationMs = nonNegativeInt(payload.durationMs);

    if (inputTokens === null && outputTokens === null && durationMs === null) {
      continue;
    }

    const snapshot: TurnTokenUsageFields = {
      inputTokens,
      outputTokens,
      reasoningOutputTokens: reasoning,
      durationMs,
    };

    if (turnId !== null && turnId !== undefined && activity.turnId === turnId) {
      return snapshot;
    }
    if (fallback === null) {
      fallback = snapshot;
    }
  }

  return fallback;
}

function durationFromLatestTurn(
  latestTurn:
    | {
        readonly turnId: string;
        readonly startedAt: string | null;
        readonly completedAt: string | null;
        readonly requestedAt?: string | null;
      }
    | null
    | undefined,
  turnId: string | null | undefined,
): string | null {
  if (latestTurn === null || latestTurn === undefined) return null;
  if (turnId !== null && turnId !== undefined && latestTurn.turnId !== turnId) return null;
  const end = latestTurn.completedAt;
  if (end === null) return null;
  const start = latestTurn.startedAt ?? latestTurn.requestedAt ?? null;
  if (start === null) return null;
  return formatElapsed(start, end);
}

export function deriveTurnResponseStats(input: {
  readonly modelSelection?: ModelSelection | null;
  readonly activities?: ReadonlyArray<TurnStatsActivity>;
  readonly turnId?: string | null;
  readonly latestTurn?: {
    readonly turnId: string;
    readonly startedAt: string | null;
    readonly completedAt: string | null;
    readonly requestedAt?: string | null;
  } | null;
}): TurnResponseStats {
  const usage = deriveTurnTokenUsageFromActivities(input.activities ?? [], input.turnId ?? null);
  const durationLabel =
    usage?.durationMs !== null && usage?.durationMs !== undefined
      ? formatDuration(usage.durationMs)
      : durationFromLatestTurn(input.latestTurn, input.turnId ?? null);

  return {
    model: modelSlug(input.modelSelection),
    effort: effortLabel(input.modelSelection),
    fastMode: isFastMode(input.modelSelection),
    durationLabel,
    inputTokens: usage?.inputTokens ?? null,
    outputTokens: usage?.outputTokens ?? null,
  };
}

/**
 * Small italic footer for Discord / GitHub markdown, e.g.
 * `_`grok-4.5` · effort high · fast · 1m 24s · ↑12.4k ↓3.1k_`
 *
 * Returns null when nothing useful is known.
 */
export function formatTurnResponseStatsLine(input: {
  readonly modelSelection?: ModelSelection | null;
  readonly activities?: ReadonlyArray<TurnStatsActivity>;
  readonly turnId?: string | null;
  readonly latestTurn?: {
    readonly turnId: string;
    readonly startedAt: string | null;
    readonly completedAt: string | null;
    readonly requestedAt?: string | null;
  } | null;
}): string | null {
  const stats = deriveTurnResponseStats(input);
  const parts: string[] = [];

  if (stats.model !== null) {
    parts.push(`\`${stats.model}\``);
  }
  if (stats.effort !== null) {
    parts.push(`effort ${stats.effort}`);
  }
  if (stats.fastMode) {
    parts.push("fast");
  }
  if (stats.durationLabel !== null) {
    parts.push(stats.durationLabel);
  }

  const inLabel = formatCompactTokenCount(stats.inputTokens);
  const outLabel = formatCompactTokenCount(stats.outputTokens);
  if (inLabel !== null || outLabel !== null) {
    const tokenParts: string[] = [];
    if (inLabel !== null) tokenParts.push(`↑${inLabel}`);
    if (outLabel !== null) tokenParts.push(`↓${outLabel}`);
    parts.push(tokenParts.join(" "));
  }

  if (parts.length === 0) return null;
  // Single italic span so Discord/GitHub render a subtle stats line.
  return `_${parts.join(" · ")}_`;
}

/** Append a stats footer once (no-op when line is empty or already present). */
export function appendTurnResponseStatsFooter(
  body: string,
  statsLine: string | null | undefined,
): string {
  const base = body.trimEnd();
  const line = statsLine?.trim() ?? "";
  if (line === "") return base;
  if (base === "") return line;
  if (base.endsWith(line)) return base;
  return `${base}\n\n${line}`;
}

/**
 * Attach stats to the last Discord content chunk, or as its own chunk if it would overflow.
 */
export function appendStatsToMessageChunks(
  chunks: ReadonlyArray<string>,
  statsLine: string | null | undefined,
  limit: number,
): string[] {
  const line = statsLine?.trim() ?? "";
  if (line === "" || chunks.length === 0) return [...chunks];

  const out = [...chunks];
  const lastIndex = out.length - 1;
  const last = out[lastIndex] ?? "";

  // Empty placeholder chunk → replace with stats alone.
  if (last.trim() === "") {
    if (line.length <= limit) {
      out[lastIndex] = line;
      return out;
    }
    return out;
  }

  const combined = `${last}\n\n${line}`;
  if (combined.length <= limit) {
    out[lastIndex] = combined;
    return out;
  }

  if (line.length <= limit) {
    out.push(line);
  }
  return out;
}
