/**
 * Assign linked GitHub PRs from Discord slash `/omegent assign` (alias `/agent assign`).
 *
 * - No `github` option → assign to the invoker's mapped GitHub login (`@me`).
 * - `github: MindfulLearner` / `@MindfulLearner` → assign that login.
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";

import { gitCommandEnv } from "./githubLinks.ts";
import { normalizePullRequestUrl, type NormalizedPullRequestLink } from "./prLinks.ts";

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

/** Discord slash / mention placeholders that mean "the person who ran the command". */
const SELF_ASSIGNEE_TOKENS = new Set(["", "@me", "me", "self"]);

/**
 * Normalize a GitHub login from slash input.
 * Returns `null` for empty / @me / self (caller should resolve via identity map).
 * Returns `{ ok: false }` for invalid logins.
 */
export function parseAssignGithubOption(raw: string | null | undefined):
  | { readonly kind: "self" }
  | { readonly kind: "login"; readonly login: string }
  | {
      readonly kind: "invalid";
      readonly detail: string;
    } {
  const trimmed = (raw ?? "").trim();
  if (SELF_ASSIGNEE_TOKENS.has(trimmed.toLowerCase())) {
    return { kind: "self" };
  }
  const withoutAt = trimmed.replace(/^@/u, "").trim();
  if (withoutAt.length === 0) {
    return { kind: "self" };
  }
  // GitHub login: alphanumeric / hyphen, max 39, cannot start/end with hyphen.
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u.test(withoutAt)) {
    return {
      kind: "invalid",
      detail: `Invalid GitHub username \`${trimmed}\`. Use a login like \`MindfulLearner\`, or omit for yourself.`,
    };
  }
  return { kind: "login", login: withoutAt };
}

export type ResolveAssignLoginInput = {
  readonly githubOption?: string | null | undefined;
  readonly requesterDiscordId?: string | null | undefined;
  readonly resolveByDiscordId: (
    discordId: string,
  ) => { readonly github?: { readonly login?: string | undefined } | undefined } | null;
};

export type ResolveAssignLoginResult =
  | { readonly ok: true; readonly login: string; readonly source: "self" | "explicit" }
  | { readonly ok: false; readonly message: string };

/**
 * Resolve who to assign: explicit GitHub login, or requester via identity map.
 */
export function resolveAssignGithubLogin(input: ResolveAssignLoginInput): ResolveAssignLoginResult {
  const parsed = parseAssignGithubOption(input.githubOption);
  if (parsed.kind === "invalid") {
    return { ok: false, message: parsed.detail };
  }
  if (parsed.kind === "login") {
    return { ok: true, login: parsed.login, source: "explicit" };
  }

  const discordId = input.requesterDiscordId?.trim() ?? "";
  if (discordId.length === 0) {
    return {
      ok: false,
      message: "Could not resolve your Discord user id. Pass `github:<login>` explicitly.",
    };
  }
  const person = input.resolveByDiscordId(discordId);
  const login = person?.github?.login?.trim();
  if (login === undefined || login.length === 0) {
    return {
      ok: false,
      message:
        "You are not in the Discord→GitHub identity map (or have no `githubLogin`). Pass `github:<login>`, or ask an operator to map your Discord id.",
    };
  }
  return { ok: true, login, source: "self" };
}

export type AssignPullRequestResult = {
  readonly url: string;
  readonly status: "assigned" | "skipped" | "error";
  readonly detail?: string | undefined;
};

/**
 * Assign `login` on each PR URL via GitHub Issues assignees API (works for PRs).
 * Best-effort: failures are returned per-URL and never throw.
 */
export async function assignPullRequestAssignees(input: {
  readonly prUrls: ReadonlyArray<string>;
  readonly login: string;
  readonly execFile?: ExecFileLike;
}): Promise<ReadonlyArray<AssignPullRequestResult>> {
  const execImpl = input.execFile ?? execFile;
  const login = input.login.trim().replace(/^@/u, "");
  const results: AssignPullRequestResult[] = [];

  for (const raw of input.prUrls) {
    const normalized = normalizePullRequestUrl(raw);
    if (normalized === null) {
      results.push({ url: raw, status: "skipped", detail: "not a github pull request url" });
      continue;
    }

    try {
      await postPullRequestAssignee(normalized, login, execImpl);
      results.push({ url: normalized.url, status: "assigned" });
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

async function postPullRequestAssignee(
  pr: NormalizedPullRequestLink,
  login: string,
  execImpl: ExecFileLike,
): Promise<void> {
  // Issues assignees endpoint is the supported way to set PR assignees.
  await execImpl(
    "gh",
    [
      "api",
      `repos/${pr.owner}/${pr.repo}/issues/${pr.number}/assignees`,
      "-X",
      "POST",
      "-f",
      `assignees[]=${login}`,
    ],
    { env: gitCommandEnv(), maxBuffer: 2 * 1024 * 1024 },
  );
}

/** Format a short public slash reply summarizing assign results. */
export function formatAssignSlashReply(input: {
  readonly login: string;
  readonly results: ReadonlyArray<AssignPullRequestResult>;
}): string {
  const loginLabel = `@${input.login.replace(/^@/u, "")}`;
  if (input.results.length === 0) {
    return `No linked pull requests on this thread to assign to ${loginLabel}.`;
  }

  const assigned = input.results.filter((r) => r.status === "assigned");
  const errors = input.results.filter((r) => r.status === "error");
  const skipped = input.results.filter((r) => r.status === "skipped");

  const lines: string[] = [];
  if (assigned.length > 0) {
    lines.push(
      `Assigned ${loginLabel} on ${assigned.length} PR(s):`,
      ...assigned.map((r) => `• ${r.url}`),
    );
  }
  if (errors.length > 0) {
    lines.push(
      `Failed ${errors.length} PR(s):`,
      ...errors.map((r) => `• ${r.url}${r.detail !== undefined ? ` — ${r.detail}` : ""}`),
    );
  }
  if (skipped.length > 0 && assigned.length === 0 && errors.length === 0) {
    lines.push(`Nothing assignable (${skipped.length} skipped).`);
  }

  return lines.join("\n");
}
