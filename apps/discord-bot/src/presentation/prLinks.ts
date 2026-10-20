/**
 * Extract and format GitHub pull request URLs from Discord message text.
 *
 * URLs are stored in first-seen order. Duplicates are ignored after normalization
 * (strip query/hash, drop common subpaths like /files, case-fold host/owner/repo).
 */

/** GitHub PR URL: https://github.com/owner/repo/pull/123[/optional-suffix] */
const GITHUB_PR_URL_SOURCE =
  "https?:\\/\\/(?:www\\.)?github\\.com\\/([A-Za-z0-9_.-]+)\\/([A-Za-z0-9_.-]+)\\/pull\\/(\\d+)(?:\\/[^\\s<>\"'#?]*)?(?:[?#][^\\s<>\"']*)?";

/** Non-global: safe for single-URL normalization. */
const GITHUB_PR_URL_SINGLE = new RegExp(GITHUB_PR_URL_SOURCE, "i");

/** Global: for multi-match extraction only — never share lastIndex with single-match helpers. */
const GITHUB_PR_URL_GLOBAL = new RegExp(GITHUB_PR_URL_SOURCE, "gi");

export type NormalizedPullRequestLink = {
  /** Canonical browse URL: https://github.com/owner/repo/pull/N */
  readonly url: string;
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  /** `owner/repo` slug (lowercase). */
  readonly repoSlug: string;
};

/**
 * Normalize `owner/repo` or a github.com repo URL to a lowercase `owner/repo` slug.
 */
export function normalizeGithubRepoSlug(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  const urlMatch =
    /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:\/.*)?$/iu.exec(
      trimmed,
    );
  if (urlMatch?.[1] !== undefined && urlMatch[2] !== undefined) {
    return `${urlMatch[1].toLowerCase()}/${urlMatch[2].toLowerCase().replace(/\.git$/iu, "")}`;
  }

  const slugMatch = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/u.exec(trimmed);
  if (slugMatch?.[1] !== undefined && slugMatch[2] !== undefined) {
    return `${slugMatch[1].toLowerCase()}/${slugMatch[2].toLowerCase()}`;
  }
  return null;
}

/**
 * Discord label for a PR:
 * - same repo as the channel (or unknown channel repo) → `PR #N`
 * - different repo → `owner/repo PR #N`
 */
export function formatPullRequestLabel(
  pr: Pick<NormalizedPullRequestLink, "owner" | "repo" | "number" | "repoSlug">,
  channelRepoSlug?: string | null,
): string {
  const channel = normalizeGithubRepoSlug(channelRepoSlug);
  if (channel === null || channel === pr.repoSlug) {
    return `PR #${pr.number}`;
  }
  return `${pr.repoSlug} PR #${pr.number}`;
}

/**
 * Normalize a raw GitHub PR URL (or fragment containing one) to a canonical form.
 * Returns null when the text does not contain a valid GitHub PR URL.
 */
export function normalizePullRequestUrl(raw: string): NormalizedPullRequestLink | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  const match = GITHUB_PR_URL_SINGLE.exec(trimmed);
  if (match === null) return null;

  const owner = (match[1] ?? "").toLowerCase();
  const repo = (match[2] ?? "").replace(/\.git$/iu, "").toLowerCase();
  const number = Number.parseInt(match[3] ?? "", 10);
  if (owner.length === 0 || repo.length === 0 || !Number.isFinite(number) || number <= 0) {
    return null;
  }

  const url = `https://github.com/${owner}/${repo}/pull/${number}`;
  return {
    url,
    owner,
    repo,
    number,
    repoSlug: `${owner}/${repo}`,
  };
}

/**
 * Extract PR URLs from free text in left-to-right first-seen order without duplicates.
 */
export function extractPullRequestUrls(text: string | null | undefined): ReadonlyArray<string> {
  if (text === null || text === undefined || text.length === 0) return [];

  const found: string[] = [];
  const seen = new Set<string>();

  for (const match of text.matchAll(GITHUB_PR_URL_GLOBAL)) {
    const normalized = normalizePullRequestUrl(match[0] ?? "");
    if (normalized === null || seen.has(normalized.url)) continue;
    seen.add(normalized.url);
    found.push(normalized.url);
  }
  return found;
}

export function extractPullRequestUrlsFromDiscordMessage(input: {
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
  return extractPullRequestUrls(parts.join("\n"));
}

/** Append newly seen PR URLs preserving first-seen order; never duplicates. */
export function mergePullRequestUrls(
  existing: ReadonlyArray<string> | null | undefined,
  incoming: ReadonlyArray<string> | null | undefined,
): ReadonlyArray<string> {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const raw of [...(existing ?? []), ...(incoming ?? [])]) {
    const normalized = normalizePullRequestUrl(raw);
    if (normalized === null || seen.has(normalized.url)) continue;
    seen.add(normalized.url);
    result.push(normalized.url);
  }
  return result;
}

/**
 * Order PR URLs for the pinned thread header: current project/repo first,
 * then everything else. Within each group, preserve first-seen order.
 */
export function sortPullRequestUrlsForDisplay(
  urls: ReadonlyArray<string>,
  channelRepoSlug?: string | null,
): ReadonlyArray<string> {
  const ordered = mergePullRequestUrls([], urls);
  if (ordered.length === 0) return ordered;

  const channel = normalizeGithubRepoSlug(channelRepoSlug);
  if (channel === null) return ordered;

  const current: string[] = [];
  const other: string[] = [];
  for (const url of ordered) {
    const normalized = normalizePullRequestUrl(url);
    if (normalized !== null && normalized.repoSlug === channel) {
      current.push(normalized.url);
    } else {
      other.push(normalized?.url ?? url);
    }
  }
  return [...current, ...other];
}

export function formatPullRequestLinksForDiscord(
  urls: ReadonlyArray<string>,
  options?: {
    /** Channel / project GitHub repo as `owner/repo` (or github URL). */
    readonly channelRepoSlug?: string | null;
  },
): string | null {
  const ordered = sortPullRequestUrlsForDisplay(urls, options?.channelRepoSlug);
  if (ordered.length === 0) return null;

  const lines = ordered.map((url) => {
    const normalized = normalizePullRequestUrl(url);
    if (normalized === null) return `• ${url}`;
    const label = formatPullRequestLabel(normalized, options?.channelRepoSlug);
    return `• [${label}](${normalized.url})`;
  });
  return ["**PRs**", ...lines].join("\n");
}
