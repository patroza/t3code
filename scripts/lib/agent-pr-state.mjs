/**
 * Resolve whether the current branch's open PR should enforce the agent ship gate.
 *
 * Modes:
 *   none    — no open PR (or closed/merged): changed-file check only
 *   draft   — open draft PR: changed-file check only
 *   ready   — open non-draft PR: full ship gate on every agent push
 *   unknown — gh missing / failed: fail closed (run the full gate)
 *
 * This fork lives under `patroza/t3code` but `gh` defaults to the upstream
 * parent (`pingdotgg/t3code`). A bare `gh pr view` therefore never finds the
 * fork's PRs, which would silently disable the gate. `.envrc` sets `GH_REPO`
 * to fix that for interactive shells, but the pre-push hook must not depend on
 * direnv being loaded — so resolve the PR against the fork repo explicitly:
 * `T3CODE_FORK_REPOSITORY` when set, else the `origin` remote, passed as
 * `gh pr list --head <branch> --repo` (an explicit `--repo` overrides GH_REPO).
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeProcess from "node:process";

/**
 * @param {{ isDraft?: boolean, state?: string } | null | undefined} pr
 * @returns {"none" | "draft" | "ready"}
 */
export const classifyPrPayload = (pr) => {
  if (pr == null) return "none";
  const state = String(pr.state ?? "").toUpperCase();
  if (state === "CLOSED" || state === "MERGED") return "none";
  if (pr.isDraft === true) return "draft";
  return "ready";
};

/**
 * @param {"none" | "draft" | "ready" | "unknown"} mode
 * @returns {boolean}
 */
export const shouldRunShipGateOnPush = (mode) => mode === "ready" || mode === "unknown";

/**
 * How much of the gate a push pays for.
 *
 * Draft / no-PR: format + lint of files changed against fork/dev.
 * Ready / unknown: full workspace check + typecheck + unit tests.
 *
 * @param {"none" | "draft" | "ready" | "unknown"} mode
 * @returns {"full" | "changed"}
 */
export const shipGateScopeForPush = (mode) => (shouldRunShipGateOnPush(mode) ? "full" : "changed");

/** Strip ANSI color codes so `gh --json` stays parseable when color is forced. */
const stripAnsi = (text) => String(text).replace(/\u001b\[[0-9;]*m/g, "");

/** Return the JSON array while ignoring shell integration noise around it. */
const extractJsonArray = (text) => {
  const cleaned = stripAnsi(text).trim();
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) return cleaned;
  return cleaned.slice(start, end + 1);
};

/**
 * Parse `owner/repo` from a GitHub remote URL (ssh, https, or git protocol).
 * @param {string | null | undefined} url
 * @returns {string | null}
 */
export const parseRepoSlug = (url) => {
  if (!url) return null;
  const trimmed = String(url).trim();
  const match = trimmed.match(
    /(?:git@[^:]+:|ssh:\/\/[^/]+\/|https?:\/\/[^/]+\/|git:\/\/[^/]+\/)([^/]+\/[^/]+?)(?:\.git)?\/?$/,
  );
  return match ? match[1] : null;
};

/**
 * @param {{
 *   cwd?: string
 *   env?: NodeJS.ProcessEnv
 *   branch?: string
 *   repoSlug?: string | null
 *   runGh?: (args: string[], opts: { cwd: string, env: NodeJS.ProcessEnv }) =>
 *     { status: number | null, stdout: string, stderr: string, error?: NodeJS.ErrnoException }
 *   runGit?: (args: string[], opts: { cwd: string }) =>
 *     { status: number | null, stdout: string, error?: NodeJS.ErrnoException }
 * }} [opts]
 * @returns {{ mode: "none" | "draft" | "ready" | "unknown", pr: { number?: number, url?: string, isDraft?: boolean, state?: string } | null, detail?: string }}
 */
export const resolveOpenPrState = (opts = {}) => {
  const cwd = opts.cwd ?? NodeProcess.cwd();
  const env = { ...(opts.env ?? NodeProcess.env) };
  delete env.FORCE_COLOR;
  delete env.CLICOLOR_FORCE;
  env.NO_COLOR = "1";
  env.CLICOLOR = "0";
  env.GH_FORCE_TTY = "0";
  env.TERM = "dumb";
  const runGh =
    opts.runGh ??
    ((args, runOpts) => {
      const result = NodeChildProcess.spawnSync("gh", args, {
        encoding: "utf8",
        cwd: runOpts.cwd,
        env: runOpts.env,
        shell: false,
      });
      return {
        status: result.status,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        error: result.error,
      };
    });
  const runGit =
    opts.runGit ??
    ((args, runOpts) => {
      const result = NodeChildProcess.spawnSync("git", args, {
        encoding: "utf8",
        cwd: runOpts.cwd,
        shell: false,
      });
      return { status: result.status, stdout: result.stdout ?? "", error: result.error };
    });

  const gitValue = (args) => {
    const r = runGit(args, { cwd });
    if (r.error || (r.status !== null && r.status !== 0)) return null;
    const v = String(r.stdout ?? "").trim();
    return v || null;
  };

  const branch = opts.branch ?? gitValue(["rev-parse", "--abbrev-ref", "HEAD"]);
  const repoSlug =
    opts.repoSlug !== undefined
      ? opts.repoSlug
      : env["T3CODE_FORK_REPOSITORY"]?.trim() ||
        parseRepoSlug(gitValue(["remote", "get-url", "origin"]));

  // Detached HEAD or unknown origin: we cannot pin the PR to the fork repo.
  // Fail closed so the gate still runs rather than silently skipping.
  if (!branch || branch === "HEAD" || !repoSlug) {
    return {
      mode: "unknown",
      pr: null,
      detail:
        !branch || branch === "HEAD" ? "no branch (detached HEAD?)" : "cannot resolve origin repo",
    };
  }

  const result = runGh(
    [
      "pr",
      "list",
      "--head",
      branch,
      "--repo",
      repoSlug,
      "--state",
      "open",
      "--json",
      "number,url,isDraft,state",
    ],
    { cwd, env },
  );

  if (result.error && result.error.code === "ENOENT") {
    return { mode: "unknown", pr: null, detail: "gh not found on PATH" };
  }

  const status = result.status === null ? 1 : result.status;
  const stderr = stripAnsi(result.stderr ?? "").trim();
  const stdout = extractJsonArray(result.stdout ?? "");

  // gh error (auth / network / bad repo): fail closed, run the gate.
  if (status !== 0) {
    return {
      mode: "unknown",
      pr: null,
      detail: stderr.trim() || stdout || `gh pr list exited ${status}`,
    };
  }

  if (!stdout) {
    return { mode: "none", pr: null, detail: "no open PR for branch" };
  }

  try {
    const list = JSON.parse(stdout);
    const pr = Array.isArray(list) ? list[0] : list;
    if (!pr) return { mode: "none", pr: null, detail: "no open PR for branch" };
    const mode = classifyPrPayload(pr);
    return { mode, pr, detail: mode === "none" ? `PR ${pr.number} is ${pr.state}` : undefined };
  } catch (error) {
    return {
      mode: "unknown",
      pr: null,
      detail: `failed to parse gh pr list JSON: ${error?.message ?? error}`,
    };
  }
};
