/**
 * Hardcoded Discord PR attribution footer.
 *
 * When a PR URL is first linked to a Discord thread, the bot appends a footer
 * using the **thread starter** (not the current requester) and the Discord
 * thread title. No agent prompt is required.
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import { gitCommandEnv } from "./githubLinks.ts";
import { normalizePullRequestUrl } from "./prLinks.ts";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

type ExecFileResult = {
  readonly stdout: string;
  readonly stderr: string;
};

type ExecFileLike = (
  file: string,
  args: ReadonlyArray<string>,
  options?: NodeChildProcess.ExecFileOptions,
) => Promise<ExecFileResult>;

/** Marker used to detect an existing Discord attribution footer (idempotent). */
export const DISCORD_PR_ATTRIBUTION_MARKER = "in chat thread **Discord** ·";

/** Marker for optional T3 thread link on the same footer line. */
export const T3_PR_THREAD_LINK_MARKER = " · [T3](";

export type DiscordPrAttributionInput = {
  /** Thread starter display name (fallback: username). */
  readonly starterDisplayName: string;
  /** Thread starter Discord snowflake user id. */
  readonly starterUserId: string;
  /** Discord thread title (channel name). */
  readonly threadTitle: string;
  /** Jump URL into the Discord thread (prefer starter message). */
  readonly threadJumpUrl: string;
  /**
   * Optional T3 web thread URL. Full host for private GitHub repos; short
   * `https://t3vm/?thread=…` for public repos (see pickT3ThreadUrlForGithubRepo).
   */
  readonly t3ThreadUrl?: string | null | undefined;
};

export type DiscordThreadStarterLike = {
  readonly id: string;
  readonly author?:
    | {
        readonly id?: string | undefined;
        readonly username?: string | undefined;
        readonly displayName?: string | undefined;
      }
    | undefined
    | null;
};

/**
 * Public Discord user profile URL (opens profile in app/browser when signed in).
 * Prefer this over bare snowflake ids, which are not navigable links.
 */
export function buildDiscordUserProfileUrl(userId: string): string {
  return `https://discord.com/users/${userId.trim()}`;
}

/** True when the URL is a full discord.com/channels/... jump (not a truncated placeholder). */
export function isValidDiscordChannelJumpUrl(url: string): boolean {
  const trimmed = url.trim();
  if (trimmed.length === 0) return false;
  // Require guild + channel segments; optional message id.
  return /^https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/channels\/[^/\s]+\/[^/\s]+(?:\/[^/\s]+)?$/u.test(
    trimmed,
  );
}

/**
 * Full T3 web UI deep link for a thread (`{base}/?thread={id}`).
 * Returns null when base or thread id is missing.
 */
export function buildT3WebThreadUrl(
  webUiBaseUrl: string | undefined | null,
  threadId: string | undefined | null,
): string | null {
  const base = webUiBaseUrl?.trim();
  const id = threadId?.trim();
  if (base === undefined || base.length === 0 || id === undefined || id.length === 0) {
    return null;
  }
  return `${base.replace(/\/+$/u, "")}/?thread=${id}`;
}

/**
 * Public-safe short form: same URL with hostname forced to `t3vm` (no port).
 * Example: `https://t3vm.tail….ts.net/?thread=x` → `https://t3vm/?thread=x`
 */
export function toT3PublicShortThreadUrl(fullUrl: string): string {
  const trimmed = fullUrl.trim();
  try {
    const url = new URL(trimmed);
    url.hostname = "t3vm";
    url.port = "";
    return url.toString();
  } catch {
    return trimmed.replace(/^(https?:\/\/)[^/?#]+/u, "$1t3vm");
  }
}

/**
 * Private GitHub repo → full t3vm host URL. Public/unknown → short `t3vm` host only
 * (avoids leaking tailnet hostnames on public PR bodies).
 */
export function pickT3ThreadUrlForGithubRepo(input: {
  readonly fullUrl: string | null | undefined;
  readonly repoIsPrivate: boolean | null;
}): string | null {
  const full = input.fullUrl?.trim();
  if (full === undefined || full.length === 0) return null;
  if (input.repoIsPrivate === true) return full;
  return toT3PublicShortThreadUrl(full);
}

/** Append ` · [T3](url)` when missing. */
export function withT3ThreadLink(
  discordFooter: string,
  t3ThreadUrl: string | null | undefined,
): string {
  const base = discordFooter.trim();
  const t3 = t3ThreadUrl?.trim();
  if (base.length === 0) return t3 !== undefined && t3.length > 0 ? `[T3](${t3})` : "";
  if (t3 === undefined || t3.length === 0) return base;
  if (base.includes(T3_PR_THREAD_LINK_MARKER) || base.includes(`](${t3})`)) return base;
  return `${base}${T3_PR_THREAD_LINK_MARKER}${t3})`;
}

/**
 * Build the single-line attribution footer from thread starter + title.
 * User link uses Discord profile URL; thread link must be a full channel jump URL.
 * Optional T3 thread link is appended as ` · [T3](url)`.
 */
export function formatDiscordPrAttributionFooter(input: DiscordPrAttributionInput): string {
  const displayName = input.starterDisplayName.trim() || "unknown";
  const userId = input.starterUserId.trim();
  const title = sanitizeMarkdownLinkLabel(input.threadTitle.trim() || "Discord thread");
  const profileUrl = buildDiscordUserProfileUrl(userId);
  const jumpUrl = input.threadJumpUrl.trim();

  const openedBy = `opened by [${escapeMarkdownLinkLabel(displayName)}](${profileUrl}) in chat thread **Discord**`;
  const withDiscord = isValidDiscordChannelJumpUrl(jumpUrl)
    ? `${openedBy} · [${escapeMarkdownLinkLabel(title)}](${jumpUrl})`
    : openedBy;
  return withT3ThreadLink(withDiscord, input.t3ThreadUrl);
}

export function buildDiscordThreadJumpUrl(input: {
  readonly guildId: string;
  readonly discordThreadId: string;
  /** Prefer the starter message id; falls back to the thread id. */
  readonly messageId?: string | null | undefined;
}): string {
  const guildId = input.guildId.trim();
  const discordThreadId = input.discordThreadId.trim();
  if (guildId.length === 0 || discordThreadId.length === 0) {
    return "";
  }
  const messageId =
    input.messageId !== null && input.messageId !== undefined && input.messageId.trim() !== ""
      ? input.messageId.trim()
      : discordThreadId;
  return `https://discord.com/channels/${guildId}/${discordThreadId}/${messageId}`;
}

export function starterDisplayName(starter: DiscordThreadStarterLike | null | undefined): string {
  if (starter === null || starter === undefined) return "unknown";
  const display = starter.author?.displayName?.trim();
  if (display !== undefined && display.length > 0) return display;
  const username = starter.author?.username?.trim();
  if (username !== undefined && username.length > 0) return username;
  return "unknown";
}

export function starterUserId(starter: DiscordThreadStarterLike | null | undefined): string | null {
  const id = starter?.author?.id?.trim();
  return id !== undefined && id.length > 0 ? id : null;
}

/** True when the PR body already has a Discord attribution footer. */
export function prBodyHasDiscordAttribution(body: string | null | undefined): boolean {
  if (body === null || body === undefined || body.length === 0) return false;
  return (
    body.includes(DISCORD_PR_ATTRIBUTION_MARKER) ||
    /opened by \[.+?\]\(.+?\) in chat thread/u.test(body)
  );
}

/**
 * Append the footer when missing. Returns null when body already has attribution
 * (caller should skip the GitHub update).
 */
export function appendDiscordPrAttributionFooter(
  body: string | null | undefined,
  footer: string,
): string | null {
  const trimmedFooter = footer.trim();
  if (trimmedFooter.length === 0) return null;
  if (prBodyHasDiscordAttribution(body)) return null;

  const base = (body ?? "").replace(/\s+$/u, "");
  if (base.length === 0) return `${trimmedFooter}\n`;
  return `${base}\n\n---\n\n${trimmedFooter}\n`;
}

/**
 * Newly observed PR URLs that are not already in the durable first-seen list.
 */
export function newlyObservedPullRequestUrls(
  existing: ReadonlyArray<string> | null | undefined,
  incoming: ReadonlyArray<string> | null | undefined,
): ReadonlyArray<string> {
  const seen = new Set<string>();
  for (const raw of existing ?? []) {
    const normalized = normalizePullRequestUrl(raw);
    if (normalized !== null) seen.add(normalized.url);
  }

  const result: string[] = [];
  for (const raw of incoming ?? []) {
    const normalized = normalizePullRequestUrl(raw);
    if (normalized === null || seen.has(normalized.url)) continue;
    seen.add(normalized.url);
    result.push(normalized.url);
  }
  return result;
}

function escapeMarkdownLinkLabel(value: string): string {
  return value.replace(/\[/gu, "\\[").replace(/\]/gu, "\\]");
}

function sanitizeMarkdownLinkLabel(value: string): string {
  // Collapse newlines / excessive whitespace so the footer stays one line.
  return value.replace(/\s+/gu, " ").trim();
}

export type EnsureDiscordPrAttributionResult = {
  readonly url: string;
  readonly status: "updated" | "already_present" | "skipped" | "error";
  readonly detail?: string | undefined;
};

/**
 * For each PR URL, append the Discord attribution footer when missing.
 * When `t3FullThreadUrl` is set, appends ` · [T3](…)` using the full host for
 * private GitHub repos and the short `t3vm` host for public/unknown repos.
 * Best-effort: failures are returned per-URL and never throw.
 */
export async function ensureDiscordPrAttributionFooters(input: {
  readonly prUrls: ReadonlyArray<string>;
  /** Discord attribution line (may already include T3; otherwise T3 is chosen per-repo). */
  readonly footer: string;
  /** Full T3 web URL (`{T3_WEB_UI_BASE_URL}/?thread=…`). Shortened for public repos. */
  readonly t3FullThreadUrl?: string | null | undefined;
  readonly execFile?: ExecFileLike;
}): Promise<ReadonlyArray<EnsureDiscordPrAttributionResult>> {
  const execImpl = input.execFile ?? execFile;
  const results: EnsureDiscordPrAttributionResult[] = [];
  const footerHasT3 = input.footer.includes(T3_PR_THREAD_LINK_MARKER);

  for (const raw of input.prUrls) {
    const normalized = normalizePullRequestUrl(raw);
    if (normalized === null) {
      results.push({ url: raw, status: "skipped", detail: "not a github pull request url" });
      continue;
    }

    try {
      const currentBody = await readPullRequestBody(normalized, execImpl);
      let footer = input.footer;
      if (!footerHasT3 && input.t3FullThreadUrl !== undefined && input.t3FullThreadUrl !== null) {
        const repoIsPrivate = await readGithubRepoIsPrivate(normalized, execImpl);
        const t3Url = pickT3ThreadUrlForGithubRepo({
          fullUrl: input.t3FullThreadUrl,
          repoIsPrivate,
        });
        footer = withT3ThreadLink(input.footer, t3Url);
      }
      const nextBody = appendDiscordPrAttributionFooter(currentBody, footer);
      if (nextBody === null) {
        results.push({ url: normalized.url, status: "already_present" });
        continue;
      }

      await writePullRequestBody(normalized, nextBody, execImpl);
      results.push({ url: normalized.url, status: "updated" });
    } catch (error) {
      results.push({
        url: normalized.url,
        status: "error",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return results;
}

async function readGithubRepoIsPrivate(
  pr: { readonly owner: string; readonly repo: string },
  execImpl: ExecFileLike,
): Promise<boolean | null> {
  try {
    const { stdout } = await execImpl(
      "gh",
      ["api", `repos/${pr.owner}/${pr.repo}`, "--jq", ".private"],
      { env: gitCommandEnv(), maxBuffer: 64 * 1024 },
    );
    const value = stdout.trim().toLowerCase();
    if (value === "true") return true;
    if (value === "false") return false;
    return null;
  } catch {
    return null;
  }
}

async function readPullRequestBody(
  pr: { readonly owner: string; readonly repo: string; readonly number: number },
  execImpl: ExecFileLike,
): Promise<string> {
  const { stdout } = await execImpl(
    "gh",
    ["api", `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`, "--jq", '.body // ""'],
    { env: gitCommandEnv(), maxBuffer: 4 * 1024 * 1024 },
  );
  return stdout;
}

async function writePullRequestBody(
  pr: { readonly owner: string; readonly repo: string; readonly number: number },
  body: string,
  execImpl: ExecFileLike,
): Promise<void> {
  const tempDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-discord-pr-body-"));
  const bodyFile = NodePath.join(tempDir, "body.json");
  try {
    await NodeFSP.writeFile(bodyFile, JSON.stringify({ body }), "utf8");
    await execImpl(
      "gh",
      [
        "api",
        `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`,
        "-X",
        "PATCH",
        "--input",
        bodyFile,
      ],
      { env: gitCommandEnv(), maxBuffer: 4 * 1024 * 1024 },
    );
  } finally {
    await NodeFSP.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
