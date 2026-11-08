/**
 * Parse a bare T3 thread id or a T3 web URL that embeds one (`?thread=` / `&thread=`).
 */
export function extractT3ThreadId(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  const fromQuery = /(?:\?|&)thread=([^&\s#]+)/iu.exec(trimmed);
  if (fromQuery?.[1] !== undefined) {
    try {
      const decoded = decodeURIComponent(fromQuery[1]).trim();
      return decoded.length > 0 ? decoded : null;
    } catch {
      const value = fromQuery[1].trim();
      return value.length > 0 ? value : null;
    }
  }

  // Bare id: single token, not a URL/path.
  if (/^https?:\/\//iu.test(trimmed) || trimmed.includes("/") || /\s/u.test(trimmed)) {
    return null;
  }
  return trimmed;
}

export type LinkThreadCommand = {
  readonly kind: "link-thread";
  readonly t3ThreadId: string;
};

/**
 * `@bot link <id|url>` / `pick-up` / `pickup` — open or join an existing T3 thread.
 * Exact command form only (no extra prompt text).
 */
export function parseLinkThreadCommand(raw: string): LinkThreadCommand | null {
  const trimmed = raw.trim().replace(/\s+/gu, " ");
  const match = /^(?:link|pick-up|pickup)\s+(\S+)\s*$/iu.exec(trimmed);
  if (match?.[1] === undefined) return null;
  const t3ThreadId = extractT3ThreadId(match[1]);
  if (t3ThreadId === null) return null;
  return { kind: "link-thread", t3ThreadId };
}
