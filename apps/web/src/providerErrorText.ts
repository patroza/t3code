/**
 * Provider error-message normalization.
 *
 * z.ai (GLM coding plan, routed through the opencode driver) returns rate-limit
 * errors like:
 *
 *   "Usage limit reached for 5 hour. Your limit will reset at 2026-07-07 19:49:44"
 *
 * The reset timestamp is a bare wall-clock string in China time (UTC+8) with no
 * timezone marker, so it reads ~6-7h in the future for a European viewer. We
 * rewrite it to the viewer's local time. This is deliberately a display-layer
 * heuristic: it only fires on z.ai's exact "limit will reset at <ts>" wording,
 * where the UTC+8 assumption holds.
 */

// z.ai emits reset times in China Standard Time (UTC+8, no DST).
const ZAI_RESET_OFFSET_MINUTES = 8 * 60;

// "Your limit will reset at 2026-07-07 19:49:44" — the clause is z.ai-specific,
// which is what justifies assuming the UTC+8 source zone.
const ZAI_RESET_PATTERN = /(limit will reset at )(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/gi;

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function localTimeZoneAbbreviation(date: Date): string | null {
  try {
    const parts = new Intl.DateTimeFormat(undefined, {
      timeZoneName: "short",
    }).formatToParts(date);
    return parts.find((part) => part.type === "timeZoneName")?.value ?? null;
  } catch {
    return null;
  }
}

function formatLocalWallClock(date: Date): string {
  const stamp =
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  const zone = localTimeZoneAbbreviation(date);
  return zone ? `${stamp} ${zone}` : stamp;
}

/**
 * Rewrite z.ai "limit will reset at <UTC+8 wall clock>" timestamps to the
 * viewer's local time. Non-matching text (and other providers' errors) is
 * returned unchanged.
 */
export function localizeZaiResetTime(text: string): string {
  if (!text) return text;
  return text.replace(
    ZAI_RESET_PATTERN,
    (match, prefix: string, y: string, mo: string, d: string, h: string, mi: string, s: string) => {
      const instantMs =
        Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)) -
        ZAI_RESET_OFFSET_MINUTES * 60_000;
      const date = new Date(instantMs);
      if (Number.isNaN(date.getTime())) return match;
      return `${prefix}${formatLocalWallClock(date)}`;
    },
  );
}
