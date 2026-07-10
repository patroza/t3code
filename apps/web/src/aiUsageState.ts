import type {
  AiUsageProviderStatus,
  AiUsageSnapshot,
  AiUsageWindow,
  ProviderDriverKind,
} from "@t3tools/contracts";

/**
 * Shared, pure logic for surfacing the local `ai-usage` daemon feed on
 * provider icons and in the model picker. Time is passed in so everything here
 * is unit-testable; the React hook lives in `hooks/useAiUsageSnapshot` to keep
 * this module free of the atom runtime.
 */

export type UsageFill = "none" | "warn" | "critical";

/**
 * A provider marker carries two independent signals:
 *   - `fill`: how used-up the provider is *right now* — driven by the most
 *     immediate window (the 5-hour cap) plus a hard "any window at 100%" block.
 *     This is the dot's colour.
 *   - `outlookAtRisk`: a softer, longer-horizon concern — a weekly/monthly
 *     window filling up or the daemon's pace projection saying you'll overshoot
 *     before it resets. This is a ring around the dot so a slow weekly burn
 *     never masquerades as "can't use it now".
 */
export interface UsageMarker {
  readonly fill: UsageFill;
  readonly outlookAtRisk: boolean;
}

/** The immediate window is "close to running out" at or above this percentage. */
export const USAGE_WARN_PERCENT = 80;
/** A longer-horizon window counts toward the outlook ring at or above this. */
export const USAGE_OUTLOOK_PERCENT = 75;

/**
 * Windows ordered shortest-horizon first. The immediate window is the one that
 * decides "can I use this right now", so a fresh 5-hour bucket wins over a
 * nearly-full weekly one.
 */
const IMMEDIATE_WINDOW_PRIORITY = ["5h", "weekly_opus", "weekly", "monthly"];

function immediateUsageWindow(item: AiUsageProviderStatus): AiUsageWindow | undefined {
  for (const id of IMMEDIATE_WINDOW_PRIORITY) {
    const match = item.windows.find(
      (window) => window.id === id && typeof window.percent === "number",
    );
    if (match) return match;
  }
  return item.windows.find((window) => typeof window.percent === "number");
}

/**
 * The daemon provider slugs a driver can route to. Most drivers map 1:1, but
 * the `opencode` driver hosts multiple coding plans (opencode-go and z.ai), so
 * it lists both. Order is "default first" — the head is used when no model slug
 * disambiguates. Drivers with no usage feed return `[]`.
 */
const USAGE_PROVIDERS_BY_DRIVER: Record<string, readonly string[]> = {
  claudeAgent: ["claude"],
  codex: ["codex"],
  cursor: ["cursor"],
  grok: ["grok"],
  opencode: ["opencode", "zai"],
};

const USAGE_PROVIDER_LABELS: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  grok: "Grok",
  opencode: "OpenCode",
  zai: "z.ai",
};

/** Human label for a daemon provider slug. */
export function usageProviderLabel(provider: string): string {
  return USAGE_PROVIDER_LABELS[provider] ?? provider;
}

/** All daemon provider slugs a driver can route to (default first). */
export function usageProvidersForDriver(
  driverKind: ProviderDriverKind | null | undefined,
): readonly string[] {
  return USAGE_PROVIDERS_BY_DRIVER[driverKind as string] ?? [];
}

/**
 * Map an app driver kind + model to the single active daemon provider slug.
 * z.ai runs under the `opencode` driver, so a `zai-coding-plan/*` model
 * overrides opencode-go. Returns `null` for drivers with no usage feed.
 */
export function mapDriverToUsageProvider(
  driverKind: ProviderDriverKind | null | undefined,
  modelSlug: string | null | undefined,
): string | null {
  const providers = usageProvidersForDriver(driverKind);
  if (providers.length === 0) return null;
  if (
    (driverKind as string) === "opencode" &&
    typeof modelSlug === "string" &&
    modelSlug.startsWith("zai-coding-plan/")
  ) {
    return "zai";
  }
  return providers[0] ?? null;
}

/** The highest percentage across a provider's windows, or `null` if none. */
export function worstUsagePercent(item: AiUsageProviderStatus): number | null {
  let worst: number | null = null;
  for (const window of item.windows) {
    if (typeof window.percent === "number" && (worst === null || window.percent > worst)) {
      worst = window.percent;
    }
  }
  return worst;
}

/** True when a window's pace projects running out before it resets. */
function windowPaceAtRisk(window: AiUsageWindow): boolean {
  return window.pace?.lasts_to_reset === false && (window.pace?.delta_percent ?? 0) > 0;
}

/**
 * The two-channel marker for a provider. `fill` reflects current usage on the
 * immediate window (red at any hard 100% cap, orange at the warn threshold);
 * `outlookAtRisk` reflects a longer-horizon window filling up or a pace
 * overshoot, and is surfaced as a ring rather than escalating the fill.
 */
export function usageMarkerForItem(item: AiUsageProviderStatus): UsageMarker {
  if (!item.ok) return { fill: "none", outlookAtRisk: false };
  const anyMaxed = item.windows.some(
    (window) => typeof window.percent === "number" && window.percent >= 100,
  );
  const immediate = immediateUsageWindow(item);
  const immediatePercent = typeof immediate?.percent === "number" ? immediate.percent : null;
  const fill: UsageFill = anyMaxed
    ? "critical"
    : immediatePercent !== null && immediatePercent >= USAGE_WARN_PERCENT
      ? "warn"
      : "none";
  const outlookAtRisk = item.windows.some(
    (window) =>
      windowPaceAtRisk(window) ||
      (window !== immediate &&
        typeof window.percent === "number" &&
        window.percent >= USAGE_OUTLOOK_PERCENT &&
        window.percent < 100),
  );
  return { fill, outlookAtRisk };
}

/** Whether a marker has anything worth rendering. */
export function hasUsageMarker(marker: UsageMarker): boolean {
  return marker.fill !== "none" || marker.outlookAtRisk;
}

/** Find the daemon status for a provider slug in a snapshot. */
export function findUsageItem(
  snapshot: AiUsageSnapshot | null | undefined,
  provider: string | null,
): AiUsageProviderStatus | null {
  if (snapshot == null || !snapshot.available || provider === null) return null;
  return snapshot.items.find((item) => item.provider === provider) ?? null;
}

export interface DriverUsage {
  readonly provider: string;
  readonly item: AiUsageProviderStatus;
  readonly marker: UsageMarker;
}

/** Resolve the usage status for a thread/instance's driver + model. */
export function resolveDriverUsage(
  snapshot: AiUsageSnapshot | null | undefined,
  driverKind: ProviderDriverKind | null | undefined,
  modelSlug: string | null | undefined,
): DriverUsage | null {
  const provider = mapDriverToUsageProvider(driverKind, modelSlug);
  const item = findUsageItem(snapshot, provider);
  if (provider === null || item === null) return null;
  return { provider, item, marker: usageMarkerForItem(item) };
}

/**
 * Resolve usage for *every* daemon provider a driver hosts (e.g. opencode-go
 * and z.ai for the `opencode` driver), skipping any absent from the snapshot.
 * Used by the model picker to show each sub-provider's stats separately.
 */
export function resolveDriverUsages(
  snapshot: AiUsageSnapshot | null | undefined,
  driverKind: ProviderDriverKind | null | undefined,
): ReadonlyArray<DriverUsage> {
  const usages: DriverUsage[] = [];
  for (const provider of usageProvidersForDriver(driverKind)) {
    const item = findUsageItem(snapshot, provider);
    if (item !== null) usages.push({ provider, item, marker: usageMarkerForItem(item) });
  }
  return usages;
}

/**
 * Rank a driver by the daemon's usability order (items are pre-sorted
 * best-to-use-now first). Lower is better; unmapped/unknown providers sort
 * last so a stable sort leaves their relative order untouched.
 */
export function usageRank(
  snapshot: AiUsageSnapshot | null | undefined,
  driverKind: ProviderDriverKind | null | undefined,
  modelSlug: string | null | undefined,
): number {
  const provider = mapDriverToUsageProvider(driverKind, modelSlug);
  if (snapshot == null || !snapshot.available || provider === null) {
    return Number.POSITIVE_INFINITY;
  }
  const index = snapshot.items.findIndex((item) => item.provider === provider);
  return index < 0 ? Number.POSITIVE_INFINITY : index;
}

/**
 * Tailwind background class for the dot itself. When only the outlook is at
 * risk the dot is a neutral muted colour so the (amber) ring carries the
 * signal; otherwise it takes the fill colour.
 */
export function usageDotFillClass(marker: UsageMarker): string | undefined {
  if (marker.fill === "critical") return "bg-destructive";
  if (marker.fill === "warn") return "bg-warning";
  if (marker.outlookAtRisk) return "bg-muted-foreground/70";
  return undefined;
}

/** CSS colour for the outlook ring around the dot, or `undefined`. */
export function usageDotRingColor(marker: UsageMarker): string | undefined {
  return marker.outlookAtRisk ? "var(--warning)" : undefined;
}

function formatDurationSeconds(seconds: number): string {
  let remaining = Math.max(0, Math.round(seconds));
  const days = Math.floor(remaining / 86400);
  remaining -= days * 86400;
  const hours = Math.floor(remaining / 3600);
  remaining -= hours * 3600;
  const minutes = Math.floor(remaining / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/** Human "resets in …" label from an epoch-seconds timestamp. */
export function formatResetsIn(
  resetsAt: number | null | undefined,
  nowMs: number = Date.now(),
): string | null {
  if (typeof resetsAt !== "number") return null;
  const seconds = Math.round(resetsAt - nowMs / 1000);
  if (seconds <= 0) return "resetting";
  return formatDurationSeconds(seconds);
}

/** The primary value label for a window (percentage, dollars, or raw usage). */
export function formatWindowValue(window: AiUsageWindow): string {
  if (typeof window.percent === "number") return `${window.percent}%`;
  if (typeof window.used === "number") {
    return window.unit === "$"
      ? `$${window.used.toFixed(2)}`
      : `${window.used}${window.unit ? ` ${window.unit}` : ""}`;
  }
  return "—";
}

/** A short pace warning for a window, or `null` when it's on/behind pace. */
export function formatPaceNote(window: AiUsageWindow): string | null {
  const pace = window.pace;
  if (pace == null) return null;
  const delta = pace.delta_percent;
  const deltaLabel = typeof delta === "number" ? `${delta > 0 ? "+" : ""}${delta}% vs pace` : null;
  if (pace.lasts_to_reset === false && typeof pace.eta_seconds === "number") {
    const eta = formatDurationSeconds(pace.eta_seconds);
    return deltaLabel ? `runs out in ${eta} · ${deltaLabel}` : `runs out in ${eta}`;
  }
  if (typeof delta === "number" && delta >= 10) {
    return typeof pace.projected_percent === "number"
      ? `${deltaLabel} · projected ${pace.projected_percent}%`
      : deltaLabel;
  }
  return null;
}
