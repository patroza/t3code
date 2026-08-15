/**
 * fork/dev helpers for the agent ship gate.
 *
 * Draft / no-PR pushes lint+format only the files changed against fork/dev.
 * Publishing requires HEAD to contain the current fork/dev tip.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeProcess from "node:process";

export const FORK_DEV_REFS = ["origin/fork/dev", "fork/dev"];

const defaultRunGit = (args, opts) => {
  const result = NodeChildProcess.spawnSync("git", args, {
    encoding: "utf8",
    cwd: opts.cwd,
    shell: false,
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};

/**
 * @param {{
 *   cwd?: string
 *   runGit?: (args: string[], opts: { cwd: string }) => { status: number | null, stdout: string }
 * }} [opts]
 * @returns {string | null}
 */
export const resolveForkDevRef = (opts = {}) => {
  const cwd = opts.cwd ?? NodeProcess.cwd();
  const runGit = opts.runGit ?? defaultRunGit;
  for (const ref of FORK_DEV_REFS) {
    const result = runGit(["rev-parse", "--verify", ref], { cwd });
    if ((result.status ?? 1) === 0) return ref;
  }
  return null;
};

/**
 * Files changed on HEAD relative to the merge-base with fork/dev.
 * Falls back to the files in HEAD itself when fork/dev is missing.
 *
 * @param {{
 *   cwd?: string
 *   runGit?: (args: string[], opts: { cwd: string }) => { status: number | null, stdout: string }
 * }} [opts]
 * @returns {string[]}
 */
export const listChangedFilesAgainstForkDev = (opts = {}) => {
  const cwd = opts.cwd ?? NodeProcess.cwd();
  const runGit = opts.runGit ?? defaultRunGit;
  const ref = resolveForkDevRef({ cwd, runGit });
  const result = (() => {
    if (!ref) {
      return runGit(
        ["diff-tree", "--no-commit-id", "--name-only", "--diff-filter=ACMR", "-r", "HEAD"],
        { cwd },
      );
    }
    const mergeBase = runGit(["merge-base", "HEAD", ref], { cwd });
    const base = String(mergeBase.stdout ?? "").trim();
    if ((mergeBase.status ?? 1) !== 0 || !base) {
      return runGit(
        ["diff-tree", "--no-commit-id", "--name-only", "--diff-filter=ACMR", "-r", "HEAD"],
        { cwd },
      );
    }
    return runGit(["diff", "--name-only", "--diff-filter=ACMR", `${base}..HEAD`], { cwd });
  })();
  if ((result.status ?? 1) !== 0) return [];
  return String(result.stdout ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
};

/**
 * @param {{
 *   cwd?: string
 *   runGit?: (args: string[], opts: { cwd: string }) => { status: number | null, stdout: string }
 *   fetch?: boolean
 * }} [opts]
 * @returns {{ ok: true, ref: string } | { ok: false, detail: string }}
 */
export const assertUpToDateWithForkDev = (opts = {}) => {
  const cwd = opts.cwd ?? NodeProcess.cwd();
  const runGit = opts.runGit ?? defaultRunGit;
  if (opts.fetch !== false) {
    runGit(["fetch", "origin", "fork/dev"], { cwd });
  }
  const ref = resolveForkDevRef({ cwd, runGit });
  if (!ref) {
    return { ok: false, detail: "cannot resolve origin/fork/dev (fetch it, then retry)" };
  }
  const ancestor = runGit(["merge-base", "--is-ancestor", ref, "HEAD"], { cwd });
  if ((ancestor.status ?? 1) !== 0) {
    return {
      ok: false,
      detail: `HEAD is not up to date with ${ref} — rebase or merge latest fork/dev before publishing`,
    };
  }
  return { ok: true, ref };
};
