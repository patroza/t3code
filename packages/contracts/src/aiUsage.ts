/**
 * AI usage - Schemas for the local `ai-usage` daemon feed.
 *
 * A user-run daemon (`ai-usage serve`) exposes normalized coding-plan usage
 * across providers (codex, claude, cursor, zai, opencode, grok) on a small HTTP API.
 * The server polls its `/dms` endpoint on an interval and fans the latest
 * snapshot to subscribers so the web can mark providers that are near or over
 * their plan limits and help pick the best available AI for a new thread.
 *
 * The daemon is optional and machine-local: when it is unreachable the server
 * still emits a snapshot with `available: false` and no items, so the UI simply
 * shows no markers rather than erroring.
 *
 * Schemas are intentionally tolerant (nullable / optional fields) because the
 * feed shape can drift across daemon versions; unknown keys are ignored.
 *
 * @module AiUsage
 */
import { Schema } from "effect";

/**
 * Pace projection for a single usage window: are you burning faster than an
 * even-pace line, and if so when do you hit 100%? Numeric fields are nullable
 * because the daemon omits projections when no usage has accrued yet.
 */
export const AiUsagePace = Schema.Struct({
  expected_percent: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  delta_percent: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  projected_percent: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  eta_seconds: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  lasts_to_reset: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  stage: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type AiUsagePace = typeof AiUsagePace.Type;

/**
 * One rolling usage window for a provider (e.g. the 5-hour or weekly limit).
 * `percent` is the primary signal; `used`/`unit` carry raw values for
 * dollar/token/request based windows that have no percentage.
 */
export const AiUsageWindow = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  percent: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  used: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  unit: Schema.optionalKey(Schema.NullOr(Schema.String)),
  resets_at: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  pace: Schema.optionalKey(Schema.NullOr(AiUsagePace)),
});
export type AiUsageWindow = typeof AiUsageWindow.Type;

/**
 * Per-provider usage status. `provider` is the daemon's provider slug
 * (codex/claude/cursor/zai/opencode). `state`/`score`/`headline` are the
 * daemon's own glanceable summary; the web derives its own marker severity
 * from the window percentages and pace.
 */
export const AiUsageProviderStatus = Schema.Struct({
  provider: Schema.String,
  ok: Schema.Boolean,
  plan: Schema.optionalKey(Schema.NullOr(Schema.String)),
  headline: Schema.optionalKey(Schema.NullOr(Schema.String)),
  headline_label: Schema.optionalKey(Schema.NullOr(Schema.String)),
  state: Schema.optionalKey(Schema.NullOr(Schema.String)),
  score: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  stale: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  stale_since: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  error: Schema.optionalKey(Schema.NullOr(Schema.String)),
  windows: Schema.Array(AiUsageWindow),
});
export type AiUsageProviderStatus = typeof AiUsageProviderStatus.Type;

/**
 * A full snapshot of the daemon feed. `available` is `false` when the daemon
 * could not be reached; `items` is ordered best-to-use-now first (the daemon's
 * usability ranking).
 */
export const AiUsageSnapshot = Schema.Struct({
  generated_at: Schema.optionalKey(Schema.NullOr(Schema.String)),
  worst_percent: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  available: Schema.Boolean,
  items: Schema.Array(AiUsageProviderStatus),
});
export type AiUsageSnapshot = typeof AiUsageSnapshot.Type;

/** Snapshot served when the daemon is unreachable or the feed cannot be parsed. */
export const AI_USAGE_UNAVAILABLE: AiUsageSnapshot = {
  generated_at: null,
  worst_percent: null,
  available: false,
  items: [],
};
