/**
 * Post a "Local proof" commit status after a green full ship gate, so Fork CI's pull_request run
 * can skip the jobs the gate already covered. GitHub only accepts statuses on commits it has, so
 * a pre-push gate defers the post until the push lands.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";
import * as NodeProcess from "node:process";
import { FORK_CI_WORKFLOW } from "./fork-ci-tree-evidence.mjs";
import { LOCAL_PROOF_CONTEXT, formatLocalProof } from "./fork-ci-local-proof.mjs";
import { parseRepoSlug } from "./agent-pr-state.mjs";

/**
 * @typedef {(args: string[], opts: { cwd: string }) => { status: number | null, stdout: string, stderr?: string }} Runner
 */

/** @param {string} command @returns {Runner} */
const defaultRun = (command) => (args, opts) => {
  const result = NodeChildProcess.spawnSync(command, args, {
    encoding: "utf8",
    cwd: opts.cwd,
    shell: false,
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};

/**
 * @param {Runner} run
 * @param {string} cwd
 * @param {string[]} args
 */
const value = (run, cwd, args) => {
  const result = run(args, { cwd });
  if (result.status !== 0) return null;
  const text = String(result.stdout).trim();
  return text.length > 0 ? text : null;
};

/**
 * @param {{ root: string, sha: string, env?: NodeJS.ProcessEnv, machine?: string, runGit?: Runner, runGh?: Runner }} opts
 * @returns {{ repo: string, sha: string, description: string } | { error: string }}
 */
const localProofFor = (opts) => {
  const runGit = opts.runGit ?? defaultRun("git");
  const env = opts.env ?? NodeProcess.env;
  const repo =
    env["T3CODE_FORK_REPOSITORY"]?.trim() ||
    parseRepoSlug(value(runGit, opts.root, ["remote", "get-url", "origin"]));
  if (!repo) return { error: "cannot resolve the origin repository" };
  const tree = value(runGit, opts.root, ["rev-parse", `${opts.sha}^{tree}`]);
  const workflowBlob = value(runGit, opts.root, ["rev-parse", `${opts.sha}:${FORK_CI_WORKFLOW}`]);
  if (!tree || !workflowBlob) return { error: `cannot read the tree of ${opts.sha}` };
  const machine = opts.machine ?? NodeOS.hostname();
  return { repo, sha: opts.sha, description: formatLocalProof({ tree, workflowBlob, machine }) };
};

/**
 * @param {{ root: string, repo: string, sha: string, runGh?: Runner }} opts
 */
const commitExistsOnGitHub = (opts) => {
  const runGh = opts.runGh ?? defaultRun("gh");
  return (
    runGh(["api", "--silent", `repos/${opts.repo}/commits/${opts.sha}`], { cwd: opts.root })
      .status === 0
  );
};

/**
 * Post the proof on `sha`, which must already be on GitHub.
 * @param {{ root: string, sha: string, env?: NodeJS.ProcessEnv, machine?: string, runGit?: Runner, runGh?: Runner }} opts
 * @returns {{ posted: true, description: string } | { posted: false, reason: string }}
 */
export const postLocalProof = (opts) => {
  const proof = localProofFor(opts);
  if ("error" in proof) return { posted: false, reason: proof.error };
  const runGh = opts.runGh ?? defaultRun("gh");
  if (!commitExistsOnGitHub({ root: opts.root, repo: proof.repo, sha: proof.sha, runGh })) {
    return { posted: false, reason: `${proof.sha.slice(0, 12)} is not on ${proof.repo} yet` };
  }
  const result = runGh(
    [
      "api",
      "--silent",
      "--method",
      "POST",
      `repos/${proof.repo}/statuses/${proof.sha}`,
      "-f",
      "state=success",
      "-f",
      `context=${LOCAL_PROOF_CONTEXT}`,
      "-f",
      `description=${proof.description}`,
    ],
    { cwd: opts.root },
  );
  if (result.status !== 0) {
    return {
      posted: false,
      reason: String(result.stderr ?? "").trim() || `gh api exited ${result.status}`,
    };
  }
  return { posted: true, description: proof.description };
};

/**
 * Wait for a push to land, then post. Runs in a short-lived child of the pre-push hook.
 * @param {{ root: string, sha: string, attempts?: number, intervalMs?: number, sleep?: (ms: number) => Promise<void> } & Parameters<typeof postLocalProof>[0]} opts
 */
export const postLocalProofAfterPush = async (opts) => {
  const attempts = opts.attempts ?? 40;
  const intervalMs = opts.intervalMs ?? 3_000;
  const sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let last = /** @type {ReturnType<typeof postLocalProof>} */ ({ posted: false, reason: "" });
  for (let attempt = 0; attempt < attempts; attempt++) {
    last = postLocalProof(opts);
    if (last.posted || !last.reason.endsWith("yet")) return last;
    await sleep(intervalMs);
  }
  return last;
};

/**
 * The local commit a pre-push hook pushes for HEAD, from the hook's stdin
 * (`<local ref> <local sha> <remote ref> <remote sha>` per line). Deletions push the zero id.
 * @param {string} stdin
 * @param {string} headSha
 */
export const pushesHead = (stdin, headSha) =>
  String(stdin)
    .split("\n")
    .some((line) => line.trim().split(/\s+/)[1]?.toLowerCase() === headSha.toLowerCase());
