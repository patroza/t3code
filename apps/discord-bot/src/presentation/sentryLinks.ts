/**
 * Detect Sentry issue URLs / Discord alert embeds so they are not treated as Jira.
 *
 * Sentry short ids (`SCANNER-313`) have the same shape as Jira keys (`PROJ-123`).
 * Classification must use the surrounding URL / bot author, not the token alone.
 */

/** Host is sentry.io or a subdomain (org.sentry.io, de.sentry.io, …). */
const SENTRY_HOST = /(?:^|\.)sentry\.io$/iu;

/**
 * Absolute sentry.io issue/share URL. Trailing punctuation is left on the match
 * and stripped during normalize so markdown `(url)` / `url.` still parse.
 */
const SENTRY_URL_PATTERN = /https?:\/\/(?:[a-z0-9-]+\.)*sentry\.io\/[^\s<>"'\])]*/gi;

export type SentryDiscordMessageInput = {
  readonly content?: string | null | undefined;
  readonly author?:
    | {
        readonly username?: string | null | undefined;
        readonly displayName?: string | null | undefined;
        readonly global_name?: string | null | undefined;
        readonly bot?: boolean | undefined;
      }
    | null
    | undefined;
  readonly embeds?:
    | ReadonlyArray<{
        readonly url?: string | null | undefined;
        readonly title?: string | null | undefined;
        readonly description?: string | null | undefined;
        readonly author?: { readonly name?: string | null | undefined } | null | undefined;
        readonly footer?: { readonly text?: string | null | undefined } | null | undefined;
      }>
    | null
    | undefined;
};

export function isSentryHostname(hostname: string): boolean {
  return SENTRY_HOST.test(hostname.trim());
}

export function sentryIssueUrlRanges(
  text: string,
): ReadonlyArray<{ readonly start: number; readonly end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  SENTRY_URL_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SENTRY_URL_PATTERN.exec(text)) !== null) {
    ranges.push({ start: match.index, end: match.index + match[0].length });
  }
  return ranges;
}

export function textHasSentryIssueUrl(text: string | null | undefined): boolean {
  if (text === null || text === undefined || text.length === 0) return false;
  return sentryIssueUrlRanges(text).length > 0;
}

function authorLooksLikeSentryBot(name: string | null | undefined): boolean {
  if (name === null || name === undefined) return false;
  const trimmed = name.trim();
  if (trimmed.length === 0) return false;
  return /^sentry(?:[\s._-]?bot)?$/iu.test(trimmed);
}

/** True when this Discord message is a Sentry alert, unfurl, or pasted sentry.io link. */
export function discordMessageLooksLikeSentry(input: SentryDiscordMessageInput): boolean {
  if (authorLooksLikeSentryBot(input.author?.username)) return true;
  if (authorLooksLikeSentryBot(input.author?.displayName)) return true;
  if (authorLooksLikeSentryBot(input.author?.global_name)) return true;
  if (textHasSentryIssueUrl(input.content)) return true;
  for (const embed of input.embeds ?? []) {
    if (authorLooksLikeSentryBot(embed.author?.name)) return true;
    if (typeof embed.url === "string" && textHasSentryIssueUrl(embed.url)) return true;
    if (typeof embed.title === "string" && textHasSentryIssueUrl(embed.title)) return true;
    if (typeof embed.description === "string" && textHasSentryIssueUrl(embed.description)) {
      return true;
    }
    if (typeof embed.footer?.text === "string" && textHasSentryIssueUrl(embed.footer.text)) {
      return true;
    }
  }
  return false;
}

/**
 * Canonical browse URL: https host, no query/hash, no trailing slash on the path.
 * Returns null when the string is not a sentry.io http(s) URL.
 */
export function normalizeSentryIssueUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  const match = /https?:\/\/(?:[a-z0-9-]+\.)*sentry\.io\/[^\s<>"'\])]*/iu.exec(trimmed);
  if (match === null) return null;

  let candidate = match[0] ?? "";
  candidate = candidate.replace(/[),.;]+$/u, "");
  try {
    const url = new URL(candidate);
    if (!isSentryHostname(url.hostname)) return null;
    url.hash = "";
    url.search = "";
    url.protocol = "https:";
    if (url.pathname.length > 1) {
      url.pathname = url.pathname.replace(/\/+$/u, "");
    }
    return url.toString();
  } catch {
    return null;
  }
}

export function mergeSentryIssueUrls(
  existing: ReadonlyArray<string> | null | undefined,
  incoming: ReadonlyArray<string> | null | undefined,
): ReadonlyArray<string> {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const raw of [...(existing ?? []), ...(incoming ?? [])]) {
    const url = normalizeSentryIssueUrl(raw);
    if (url === null || seen.has(url)) continue;
    seen.add(url);
    result.push(url);
  }
  return result;
}

export function extractSentryIssueUrls(text: string | null | undefined): ReadonlyArray<string> {
  if (text === null || text === undefined || text.length === 0) return [];
  const found: string[] = [];
  const seen = new Set<string>();
  for (const range of sentryIssueUrlRanges(text)) {
    const url = normalizeSentryIssueUrl(text.slice(range.start, range.end));
    if (url === null || seen.has(url)) continue;
    seen.add(url);
    found.push(url);
  }
  return found;
}

export function extractSentryIssueUrlsFromDiscordMessage(
  input: SentryDiscordMessageInput,
): ReadonlyArray<string> {
  const parts: string[] = [];
  if (input.content) parts.push(input.content);
  for (const embed of input.embeds ?? []) {
    if (embed.url) parts.push(embed.url);
    if (embed.title) parts.push(embed.title);
    if (embed.description) parts.push(embed.description);
  }
  return extractSentryIssueUrls(parts.join("\n"));
}

/** Compact pin/prompt label: issue path id (`SCANNER-313` or numeric id). */
export function sentryIssueLabelFromUrl(url: string): string {
  const normalized = normalizeSentryIssueUrl(url) ?? url.trim();
  try {
    const parsed = new URL(normalized);
    const issueMatch = parsed.pathname.match(/\/issues\/([^/]+)/iu);
    if (issueMatch?.[1] !== undefined && issueMatch[1].length > 0) {
      return decodeURIComponent(issueMatch[1]);
    }
    const shareMatch = parsed.pathname.match(/\/share\/([^/]+)/iu);
    if (shareMatch?.[1] !== undefined && shareMatch[1].length > 0) {
      return decodeURIComponent(shareMatch[1]);
    }
  } catch {
    // fall through
  }
  return normalized;
}

export function formatSentryLinksForDiscord(urls: ReadonlyArray<string>): string | null {
  const ordered = mergeSentryIssueUrls([], urls);
  if (ordered.length === 0) return null;
  const lines = ordered.map((url) => {
    const label = sentryIssueLabelFromUrl(url);
    return `• [${label}](${url})`;
  });
  return ["**Sentry**", ...lines].join("\n");
}
