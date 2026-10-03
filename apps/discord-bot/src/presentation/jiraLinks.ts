/**
 * Extract and format Jira issue keys / browse links from Discord message text.
 *
 * Keys are stored in first-seen order. Duplicates are ignored (case-insensitive match
 * with canonical uppercase key form).
 *
 * Sentry short ids (`SCANNER-313`) match the Jira key shape. Tokens inside sentry.io
 * URLs, Sentry Discord embeds, or Sentry-bot messages are not treated as Jira.
 */

import {
  discordMessageLooksLikeSentry,
  sentryIssueUrlRanges,
  type SentryDiscordMessageInput,
} from "./sentryLinks.ts";

/** Classic Jira issue key: PROJ-123 (project 2–10 alnum chars, numeric id). */
const JIRA_ISSUE_KEY_PATTERN = /\b([A-Z][A-Z0-9]{1,9}-\d{1,7})\b/g;

/** Browse-style Atlassian URLs that embed an issue key. */
const JIRA_BROWSE_URL_PATTERN =
  /https?:\/\/[^\s<>"']+\.atlassian\.net\/(?:browse|jira\/browse)\/([A-Z][A-Z0-9]{1,9}-\d{1,7})(?:[^\s<>"']*)?/gi;

/** Board / issue navigator deep links: ?selectedIssue=PROJ-123 */
const JIRA_SELECTED_ISSUE_PATTERN = /[?&]selectedIssue=([A-Z][A-Z0-9]{1,9}-\d{1,7})\b/gi;

const FALSE_POSITIVE_KEYS = new Set([
  // Common non-Jira tokens that match the key shape
  "UTF-8",
  "ISO-8601",
  "HTTP-1",
  "HTTP-2",
  "TLS-1",
]);

export function normalizeJiraIssueKey(raw: string): string | null {
  const key = raw.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9]{1,9}-\d{1,7}$/u.test(key)) return null;
  if (FALSE_POSITIVE_KEYS.has(key)) return null;
  return key;
}

/**
 * Strip trailing slash and normalize a browse base URL.
 * Accepts either `https://org.atlassian.net` or a full API URL that embeds the site.
 */
export function resolveJiraBrowseBaseUrl(raw: string | undefined | null): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const trimmed = raw.trim().replace(/\/+$/u, "");
  if (trimmed.length === 0) return undefined;

  // Classic site URL
  const siteMatch = trimmed.match(/^(https?:\/\/[a-z0-9.-]+\.atlassian\.net)(?:\/.*)?$/iu);
  if (siteMatch?.[1] !== undefined) return siteMatch[1];

  // Leave non-atlassian bases as-is when they look like a site root (no /ex/jira/)
  if (/^https?:\/\//iu.test(trimmed) && !trimmed.includes("/ex/jira/")) {
    return trimmed;
  }
  return undefined;
}

export function jiraBrowseUrl(baseUrl: string | undefined, key: string): string | null {
  const normalized = normalizeJiraIssueKey(key);
  if (normalized === null) return null;
  const base = resolveJiraBrowseBaseUrl(baseUrl);
  if (base === undefined) return null;
  return `${base}/browse/${normalized}`;
}

export type ExtractJiraIssueKeysOptions = {
  /**
   * When false, only keys from Atlassian browse / selectedIssue URLs are returned.
   * Default true, unless the text already contains a sentry.io URL (bare keys in
   * that blob are Sentry short ids, not Jira).
   */
  readonly includeBareKeys?: boolean;
  /** Skip tokens whose match index sits inside a sentry.io URL. Default true. */
  readonly skipSentryUrls?: boolean;
};

type JiraKeyHit = { readonly index: number; readonly key: string };

function collectJiraKeyHits(
  text: string,
  patterns: ReadonlyArray<RegExp>,
  sentryRanges: ReadonlyArray<{ readonly start: number; readonly end: number }>,
  skipSentryUrls: boolean,
): JiraKeyHit[] {
  const hits: JiraKeyHit[] = [];
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const matchIndex = match.index;
      if (
        skipSentryUrls &&
        sentryRanges.some((range) => matchIndex >= range.start && matchIndex < range.end)
      ) {
        continue;
      }
      const key = normalizeJiraIssueKey(match[1] ?? "");
      if (key === null) continue;
      hits.push({ index: matchIndex, key });
    }
  }
  hits.sort((a, b) => a.index - b.index || a.key.localeCompare(b.key));
  return hits;
}

const ATLASSIAN_KEY_PATTERNS = [JIRA_BROWSE_URL_PATTERN, JIRA_SELECTED_ISSUE_PATTERN];
const ALL_KEY_PATTERNS = [...ATLASSIAN_KEY_PATTERNS, JIRA_ISSUE_KEY_PATTERN];

/**
 * Extract issue keys from free text (message content, embed fields, etc.)
 * in left-to-right first-seen order without duplicates.
 */
export function extractJiraIssueKeys(
  text: string | null | undefined,
  options?: ExtractJiraIssueKeysOptions,
): ReadonlyArray<string> {
  if (text === null || text === undefined || text.length === 0) return [];

  const skipSentryUrls = options?.skipSentryUrls ?? true;
  const sentryRanges =
    skipSentryUrls || options?.includeBareKeys === false ? sentryIssueUrlRanges(text) : [];
  const includeBareKeys =
    options?.includeBareKeys ?? (skipSentryUrls ? sentryRanges.length === 0 : true);

  const found: string[] = [];
  const seen = new Set<string>();
  const patterns = includeBareKeys ? ALL_KEY_PATTERNS : ATLASSIAN_KEY_PATTERNS;
  for (const hit of collectJiraKeyHits(text, patterns, sentryRanges, skipSentryUrls)) {
    if (seen.has(hit.key)) continue;
    seen.add(hit.key);
    found.push(hit.key);
  }
  return found;
}

function joinDiscordMessageText(input: SentryDiscordMessageInput): string {
  const parts: string[] = [];
  if (input.content) parts.push(input.content);
  for (const embed of input.embeds ?? []) {
    if (embed.url) parts.push(embed.url);
    if (embed.title) parts.push(embed.title);
    if (embed.description) parts.push(embed.description);
    if (embed.footer?.text) parts.push(embed.footer.text);
  }
  return parts.join("\n");
}

export function extractJiraIssueKeysFromDiscordMessage(
  input: SentryDiscordMessageInput,
): ReadonlyArray<string> {
  const text = joinDiscordMessageText(input);
  const sentryContext = discordMessageLooksLikeSentry(input);
  return extractJiraIssueKeys(text, {
    includeBareKeys: !sentryContext,
    skipSentryUrls: true,
  });
}

/**
 * Jira-shaped tokens in a Sentry alert / sentry.io URL that must not be stored as Jira keys.
 * Atlassian browse URLs in the same message are kept (not returned here).
 */
export function jiraIssueKeysMaskedBySentryContext(
  input: SentryDiscordMessageInput,
): ReadonlyArray<string> {
  const text = joinDiscordMessageText(input);
  const sentryContext = discordMessageLooksLikeSentry(input);
  const sentryRanges = sentryIssueUrlRanges(text);
  if (!sentryContext && sentryRanges.length === 0) return [];

  const atlassianOnly = new Set(
    extractJiraIssueKeys(text, { includeBareKeys: false, skipSentryUrls: true }),
  );
  return extractJiraIssueKeys(text, { includeBareKeys: true, skipSentryUrls: false }).filter(
    (key) => !atlassianOnly.has(key),
  );
}

export function jiraIssueKeysMaskedBySentryFromMessages(
  messages: ReadonlyArray<SentryDiscordMessageInput | null | undefined>,
): ReadonlyArray<string> {
  const keys: string[] = [];
  for (const message of messages) {
    if (message === null || message === undefined) continue;
    keys.push(...jiraIssueKeysMaskedBySentryContext(message));
  }
  return mergeJiraIssueKeys([], keys);
}

/** Drop `omit` from `keys` (canonical uppercase), preserving first-seen order. */
export function omitJiraIssueKeys(
  keys: ReadonlyArray<string> | null | undefined,
  omit: ReadonlyArray<string> | null | undefined,
): ReadonlyArray<string> {
  const dropped = new Set(mergeJiraIssueKeys([], omit));
  if (dropped.size === 0) return mergeJiraIssueKeys([], keys);
  return mergeJiraIssueKeys([], keys).filter((key) => !dropped.has(key));
}

/**
 * Merge stored + newly extracted Jira keys, then drop Sentry short ids that were
 * never independently extracted from a non-Sentry message / Atlassian URL.
 */
export function jiraIssueKeysAfterExcludingSentryFalsePositives(
  existing: ReadonlyArray<string> | null | undefined,
  extracted: ReadonlyArray<string> | null | undefined,
  sentryMasked: ReadonlyArray<string> | null | undefined,
): ReadonlyArray<string> {
  const keptExtracted = mergeJiraIssueKeys([], extracted);
  const drop = omitJiraIssueKeys(sentryMasked, keptExtracted);
  return omitJiraIssueKeys(mergeJiraIssueKeys(existing, keptExtracted), drop);
}

/** Append newly seen keys preserving first-seen order; never duplicates. */
export function mergeJiraIssueKeys(
  existing: ReadonlyArray<string> | null | undefined,
  incoming: ReadonlyArray<string> | null | undefined,
): ReadonlyArray<string> {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const raw of [...(existing ?? []), ...(incoming ?? [])]) {
    const key = normalizeJiraIssueKey(raw);
    if (key === null || seen.has(key)) continue;
    seen.add(key);
    result.push(key);
  }
  return result;
}

export function formatJiraLinksForDiscord(
  keys: ReadonlyArray<string>,
  browseBaseUrl: string | undefined,
): string | null {
  const ordered = mergeJiraIssueKeys([], keys);
  if (ordered.length === 0) return null;

  const lines = ordered.map((key) => {
    const url = jiraBrowseUrl(browseBaseUrl, key);
    return url === null ? `• \`${key}\`` : `• [${key}](${url})`;
  });
  return ["**Jira**", ...lines].join("\n");
}
