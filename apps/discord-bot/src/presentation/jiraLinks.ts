/**
 * Extract and format Jira issue keys / browse links from Discord message text.
 *
 * Keys are stored in first-seen order. Duplicates are ignored (case-insensitive match
 * with canonical uppercase key form).
 */

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

/**
 * Extract issue keys from free text (message content, embed fields, etc.)
 * in left-to-right first-seen order without duplicates.
 */
export function extractJiraIssueKeys(text: string | null | undefined): ReadonlyArray<string> {
  if (text === null || text === undefined || text.length === 0) return [];

  const found: string[] = [];
  const seen = new Set<string>();

  const push = (raw: string) => {
    const key = normalizeJiraIssueKey(raw);
    if (key === null || seen.has(key)) return;
    seen.add(key);
    found.push(key);
  };

  // Prefer URL-sourced keys first so they appear in URL order when mixed with bare keys
  // in the same string — still overall left-to-right via a single scan of positions.
  type Hit = { readonly index: number; readonly key: string };
  const hits: Hit[] = [];

  for (const pattern of [
    JIRA_BROWSE_URL_PATTERN,
    JIRA_SELECTED_ISSUE_PATTERN,
    JIRA_ISSUE_KEY_PATTERN,
  ]) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const key = normalizeJiraIssueKey(match[1] ?? "");
      if (key === null) continue;
      hits.push({ index: match.index, key });
    }
  }

  hits.sort((a, b) => a.index - b.index || a.key.localeCompare(b.key));
  for (const hit of hits) {
    push(hit.key);
  }
  return found;
}

export function extractJiraIssueKeysFromDiscordMessage(input: {
  readonly content?: string | null | undefined;
  readonly embeds?:
    | ReadonlyArray<{
        readonly url?: string | null | undefined;
        readonly title?: string | null | undefined;
        readonly description?: string | null | undefined;
        readonly footer?: { readonly text?: string | null | undefined } | null | undefined;
      }>
    | null
    | undefined;
}): ReadonlyArray<string> {
  const parts: string[] = [];
  if (input.content) parts.push(input.content);
  for (const embed of input.embeds ?? []) {
    if (embed.url) parts.push(embed.url);
    if (embed.title) parts.push(embed.title);
    if (embed.description) parts.push(embed.description);
    if (embed.footer?.text) parts.push(embed.footer.text);
  }
  return extractJiraIssueKeys(parts.join("\n"));
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
