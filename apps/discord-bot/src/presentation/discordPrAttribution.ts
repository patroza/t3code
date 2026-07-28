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

export type DiscordPrAttributionInput = {
  /** Thread starter display name (fallback: username). */
  readonly starterDisplayName: string;
  /** Thread starter Discord snowflake user id. */
  readonly starterUserId: string;
  /** Discord thread title (channel name). */
  readonly threadTitle: string;
  /** Jump URL into the Discord thread (prefer starter message). */
  readonly threadJumpUrl: string;
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
 * Build the single-line attribution footer from thread starter + title.
 */
export function formatDiscordPrAttributionFooter(input: DiscordPrAttributionInput): string {
  const displayName = input.starterDisplayName.trim() || "unknown";
  const userId = input.starterUserId.trim();
  const title = sanitizeMarkdownLinkLabel(input.threadTitle.trim() || "Discord thread");
  const jumpUrl = input.threadJumpUrl.trim();

  // Keep display name linked to the raw Discord user id (matches AGENTS.md format).
  return `opened by [${escapeMarkdownLinkLabel(displayName)}](${userId}) in chat thread **Discord** · [${escapeMarkdownLinkLabel(title)}](${jumpUrl})`;
}

export function buildDiscordThreadJumpUrl(input: {
  readonly guildId: string;
  readonly discordThreadId: string;
  /** Prefer the starter message id; falls back to the thread id. */
  readonly messageId?: string | null | undefined;
}): string {
  const messageId =
    input.messageId !== null && input.messageId !== undefined && input.messageId.trim() !== ""
      ? input.messageId.trim()
      : input.discordThreadId;
  return `https://discord.com/channels/${input.guildId}/${input.discordThreadId}/${messageId}`;
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
 * Best-effort: failures are returned per-URL and never throw.
 */
export async function ensureDiscordPrAttributionFooters(input: {
  readonly prUrls: ReadonlyArray<string>;
  readonly footer: string;
  readonly execFile?: ExecFileLike;
}): Promise<ReadonlyArray<EnsureDiscordPrAttributionResult>> {
  const execImpl = input.execFile ?? execFile;
  const results: EnsureDiscordPrAttributionResult[] = [];

  for (const raw of input.prUrls) {
    const normalized = normalizePullRequestUrl(raw);
    if (normalized === null) {
      results.push({ url: raw, status: "skipped", detail: "not a github pull request url" });
      continue;
    }

    try {
      const currentBody = await readPullRequestBody(normalized, execImpl);
      const nextBody = appendDiscordPrAttributionFooter(currentBody, input.footer);
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
