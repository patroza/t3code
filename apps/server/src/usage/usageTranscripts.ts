/**
 * Pure parsers for the provider CLIs' on-disk session transcripts.
 *
 * Every parser is a line-at-a-time reducer so callers can stream large files
 * without materialising them. None touches the filesystem.
 *
 * @module usageTranscripts
 */
import type { UsageProviderKind, UsageTokenTotals } from "@t3tools/contracts";

export interface UsageRecord {
  readonly provider: UsageProviderKind;
  readonly timestampMs: number;
  readonly model: string;
  readonly sessionId: string;
  readonly totals: UsageTokenTotals;
  readonly reportedCostUsd: number | null;
  /**
   * Key for cross-file de-duplication, or `null` when the record is inherently
   * unique and needs no dedup.
   */
  readonly dedupeKey: string | null;
}

const EMPTY_TOTALS: UsageTokenTotals = {
  uncachedInputTokens: 0,
  cachedInputTokens: 0,
  cacheCreationTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
};

function int(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function parseTimestampMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

export function addTotals(a: UsageTokenTotals, b: UsageTokenTotals): UsageTokenTotals {
  return {
    uncachedInputTokens: a.uncachedInputTokens + b.uncachedInputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
  };
}

export function totalTokens(totals: UsageTokenTotals): number {
  // reasoningTokens is a subset of outputTokens and must not be added again.
  return (
    totals.uncachedInputTokens +
    totals.cachedInputTokens +
    totals.cacheCreationTokens +
    totals.outputTokens
  );
}

/**
 * Cheap substring gate applied before `JSON.parse`.
 *
 * Transcripts are mostly tool output; only a minority of lines carry usage. On
 * a 30-day window this skips roughly half the lines outright and is worth about
 * an order of magnitude.
 */
export function mightCarryUsage(line: string, provider: UsageProviderKind): boolean {
  switch (provider) {
    case "claude":
      return line.includes('"usage"');
    case "codex":
      return line.includes('"token_count"');
    case "grok":
      return line.includes('"prompt_tokens"');
    case "kimi":
      return line.includes('"token_usage"');
  }
}

/* -------------------------------------------------------------------------- */
/* Claude Code                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Parses one line of a Claude Code transcript.
 *
 * T3 Code writes one record per assistant *content block*, and every one of
 * those records repeats the same complete `usage` object for the parent
 * message. Summing them overcounts by roughly 2.4x on a real workload, so the
 * caller must drop repeats by `dedupeKey` and keep the first.
 */
export function parseClaudeLine(line: string): UsageRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const record = parsed as Record<string, unknown>;
  if (record["type"] !== "assistant") return null;

  const message = record["message"];
  if (typeof message !== "object" || message === null) return null;
  const messageRecord = message as Record<string, unknown>;

  const usage = messageRecord["usage"];
  if (typeof usage !== "object" || usage === null) return null;
  const usageRecord = usage as Record<string, unknown>;

  const timestampMs = parseTimestampMs(record["timestamp"]);
  if (timestampMs === null) return null;

  const model = typeof messageRecord["model"] === "string" ? messageRecord["model"] : "";
  if (model.length === 0) return null;

  const messageId = typeof messageRecord["id"] === "string" ? messageRecord["id"] : null;
  const requestId = typeof record["requestId"] === "string" ? record["requestId"] : null;
  // Matches ccusage: prefer the message/request pair, fall back to whichever
  // half exists. Records with neither cannot be de-duplicated.
  const dedupeKey =
    messageId === null && requestId === null ? null : `${messageId ?? ""}:${requestId ?? ""}`;

  const cost = record["costUSD"];

  return {
    provider: "claude",
    timestampMs,
    model,
    sessionId: typeof record["sessionId"] === "string" ? record["sessionId"] : "",
    totals: {
      uncachedInputTokens: int(usageRecord["input_tokens"]),
      cachedInputTokens: int(usageRecord["cache_read_input_tokens"]),
      cacheCreationTokens: int(usageRecord["cache_creation_input_tokens"]),
      outputTokens: int(usageRecord["output_tokens"]),
      // Anthropic folds thinking tokens into output and does not break them out.
      reasoningTokens: 0,
    },
    reportedCostUsd: typeof cost === "number" && Number.isFinite(cost) ? cost : null,
    dedupeKey,
  };
}

/* -------------------------------------------------------------------------- */
/* Codex                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Rolling state for a single Codex rollout file.
 *
 * Codex `token_count` events carry no model, so the model is carried forward
 * from the most recent `turn_context`. Sessions that switch models mid-run
 * attribute correctly from the switch onward.
 */
export interface CodexScanState {
  model: string;
  sessionId: string;
  lastUsageSignature: string | null;
}

export function initialCodexScanState(): CodexScanState {
  return { model: "", sessionId: "", lastUsageSignature: null };
}

/**
 * Feeds one line of a Codex rollout into `state`, returning a record when the
 * line was a usage event.
 *
 * Deltas come from `last_token_usage`. Summing those across a session
 * reconciles with the session's final `total_token_usage`, provided
 * consecutive duplicate events are dropped, which this does.
 */
export function parseCodexLine(line: string, state: CodexScanState): UsageRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const record = parsed as Record<string, unknown>;
  const payload = record["payload"];
  if (typeof payload !== "object" || payload === null) return null;
  const payloadRecord = payload as Record<string, unknown>;
  const payloadType = payloadRecord["type"];

  if (record["type"] === "session_meta") {
    const id = payloadRecord["id"] ?? payloadRecord["session_id"];
    if (typeof id === "string") state.sessionId = id;
    return null;
  }

  if (record["type"] === "turn_context") {
    if (typeof payloadRecord["model"] === "string") state.model = payloadRecord["model"];
    return null;
  }

  if (payloadType !== "token_count") return null;

  const info = payloadRecord["info"];
  if (typeof info !== "object" || info === null) return null;
  const last = (info as Record<string, unknown>)["last_token_usage"];
  if (typeof last !== "object" || last === null) return null;
  const lastRecord = last as Record<string, unknown>;

  // Only an event that is otherwise eligible may consume the duplicate
  // signature. A token_count arriving before its turn_context (no model yet)
  // must not poison it, or the re-emitted copy after the model is known would
  // be skipped as a duplicate and those tokens never counted.
  const timestampMs = parseTimestampMs(record["timestamp"]);
  if (timestampMs === null) return null;
  if (state.model.length === 0) return null;

  // Codex re-emits an unchanged token_count on some stream boundaries. Summing
  // those would double count, so identical consecutive payloads are skipped.
  const signature = JSON.stringify(lastRecord);
  if (signature === state.lastUsageSignature) return null;
  state.lastUsageSignature = signature;

  const inputTokens = int(lastRecord["input_tokens"]);
  const cachedInputTokens = int(lastRecord["cached_input_tokens"]);
  const cacheCreationTokens = int(lastRecord["cache_write_input_tokens"]);
  const outputTokens = int(lastRecord["output_tokens"]);

  const totals: UsageTokenTotals = {
    // Codex reports `input_tokens` inclusive of the cached portion.
    uncachedInputTokens: Math.max(0, inputTokens - cachedInputTokens - cacheCreationTokens),
    cachedInputTokens,
    cacheCreationTokens,
    outputTokens,
    // Reported inside output_tokens, surfaced separately for the token mix.
    reasoningTokens: Math.min(outputTokens, int(lastRecord["reasoning_output_tokens"])),
  };

  if (totalTokens(totals) === 0) return null;

  return {
    provider: "codex",
    timestampMs,
    model: state.model,
    sessionId: state.sessionId,
    totals,
    // Codex does not report cost in the rollout.
    reportedCostUsd: null,
    // Rollout files are unique per session, so events need no global dedup.
    dedupeKey: null,
  };
}

/* -------------------------------------------------------------------------- */
/* Grok                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Rolling state for Grok's unified log.
 *
 * Unlike the other providers, Grok records usage in one process-wide log
 * (`<grok home>/logs/unified.jsonl`) rather than per-session files, so lines
 * from concurrent sessions interleave. `shell.turn.inference_done` carries no
 * model, so the model is carried forward per session id — a single scalar
 * would attribute one session's turns to whichever session switched model
 * last.
 */
export interface GrokScanState {
  readonly modelBySession: Map<string, string>;
}

export function initialGrokScanState(): GrokScanState {
  return { modelBySession: new Map<string, string>() };
}

/**
 * Feeds one line of Grok's unified log into `state`, returning a record when
 * the line was an inference-completion event.
 *
 * Grok emits one `shell.turn.inference_done` per model round trip, each
 * carrying that request's own counts, so these sum without de-duplication.
 */
export function parseGrokLine(line: string, state: GrokScanState): UsageRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const record = parsed as Record<string, unknown>;
  const sessionId = record["sid"];
  if (typeof sessionId !== "string" || sessionId.length === 0) return null;
  const context = record["ctx"];
  if (typeof context !== "object" || context === null) return null;
  const contextRecord = context as Record<string, unknown>;

  // `model changed` is emitted at session start as well as on a switch, so
  // every session's first usage event already has a model to carry.
  if (record["msg"] === "model changed") {
    const model = contextRecord["model"];
    if (typeof model === "string" && model.length > 0) state.modelBySession.set(sessionId, model);
    return null;
  }

  if (record["msg"] !== "shell.turn.inference_done") return null;

  const timestampMs = parseTimestampMs(record["ts"]);
  if (timestampMs === null) return null;
  const model = state.modelBySession.get(sessionId);
  if (model === undefined) return null;

  const promptTokens = int(contextRecord["prompt_tokens"]);
  const cachedInputTokens = int(contextRecord["cached_prompt_tokens"]);
  const outputTokens = int(contextRecord["completion_tokens"]);

  const totals: UsageTokenTotals = {
    // Grok reports `prompt_tokens` inclusive of the cached portion.
    uncachedInputTokens: Math.max(0, promptTokens - cachedInputTokens),
    cachedInputTokens,
    // Grok does not report cache writes separately.
    cacheCreationTokens: 0,
    outputTokens,
    // Reported inside completion_tokens, surfaced separately for the mix.
    reasoningTokens: Math.min(outputTokens, int(contextRecord["reasoning_tokens"])),
  };

  if (totalTokens(totals) === 0) return null;

  return {
    provider: "grok",
    timestampMs,
    model,
    sessionId,
    totals,
    // Grok does not report cost in the log.
    reportedCostUsd: null,
    // One event per round trip in a single append-only log; no cross-file
    // repeats to collapse.
    dedupeKey: null,
  };
}

/* -------------------------------------------------------------------------- */
/* Kimi                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The model recorded for Kimi turns.
 *
 * Kimi's wire log names no model on any record, and the CLI's configured model
 * at scan time says nothing about what served a turn weeks ago. Rather than
 * attribute — and therefore price — turns against a guess, they are recorded
 * under a sentinel that `usagePricing` treats as unpriceable, so Kimi shows
 * real token counts and an honest "unpriced" share instead of a fabricated
 * cost.
 */
export const KIMI_UNKNOWN_MODEL = "kimi";

/** Rolling state for a single Kimi `wire.jsonl`. */
export interface KimiScanState {
  sessionId: string;
}

export function initialKimiScanState(sessionId: string): KimiScanState {
  return { sessionId };
}

/**
 * Feeds one line of a Kimi wire log into `state`, returning a record when the
 * line was a status update carrying token usage.
 *
 * Each `StatusUpdate` reports the counts for one served response — the input
 * side re-states the whole context because that is what the request billed —
 * so these sum across turns. `message_id` de-duplicates the repeats Kimi emits
 * when a status is refreshed without a new round trip.
 */
export function parseKimiLine(line: string, state: KimiScanState): UsageRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const record = parsed as Record<string, unknown>;
  const message = record["message"];
  if (typeof message !== "object" || message === null) return null;
  const messageRecord = message as Record<string, unknown>;
  if (messageRecord["type"] !== "StatusUpdate") return null;

  const payload = messageRecord["payload"];
  if (typeof payload !== "object" || payload === null) return null;
  const payloadRecord = payload as Record<string, unknown>;
  const usage = payloadRecord["token_usage"];
  if (typeof usage !== "object" || usage === null) return null;
  const usageRecord = usage as Record<string, unknown>;

  // Kimi timestamps are epoch seconds with a fractional part.
  const timestamp = record["timestamp"];
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp) || timestamp <= 0) return null;
  const timestampMs = Math.trunc(timestamp * 1000);

  const outputTokens = int(usageRecord["output"]);
  const totals: UsageTokenTotals = {
    // `input_other` already excludes the cached and cache-creation portions.
    uncachedInputTokens: int(usageRecord["input_other"]),
    cachedInputTokens: int(usageRecord["input_cache_read"]),
    cacheCreationTokens: int(usageRecord["input_cache_creation"]),
    outputTokens,
    // Kimi does not break reasoning out of the output count.
    reasoningTokens: 0,
  };

  if (totalTokens(totals) === 0) return null;

  const messageId = payloadRecord["message_id"];

  return {
    provider: "kimi",
    timestampMs,
    model: KIMI_UNKNOWN_MODEL,
    sessionId: state.sessionId,
    totals,
    // Kimi does not report cost in the wire log.
    reportedCostUsd: null,
    dedupeKey: typeof messageId === "string" && messageId.length > 0 ? messageId : null,
  };
}

export { EMPTY_TOTALS };
