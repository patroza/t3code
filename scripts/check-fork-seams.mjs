#!/usr/bin/env node
// Fork-only. Fails when an upstream file differs from the upstream merge base without a
// fork-seams.txt entry. Usage: check-fork-seams.mjs [upstream-ref] [--fetch]; the ref defaults to
// $FORK_SEAMS_UPSTREAM_REF, then upstream/main, and --fetch uses GitHub's upstream main instead.
// Node built-ins only: the Fork Seams CI job runs it without installing dependencies.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";

export const SEAMS_FILE = "fork-seams.txt";
export const DEFAULT_UPSTREAM_REF = "upstream/main";
export const UPSTREAM_URL = "https://github.com/pingdotgg/t3code";

/**
 * Parse fork-seams.txt: one `<path>  # <feature>: <why>` per line; `#` lines are comments.
 * @param {string} text
 * @returns {{ entries: string[], problems: string[] }}
 */
export const parseSeams = (text) => {
  const entries = [];
  const problems = [];
  const seen = new Set();
  text.split("\n").forEach((raw, index) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    const path = line.split(/\s+#/)[0].trim();
    if (/\s/.test(path)) {
      problems.push(`line ${index + 1}: expected "<path>  # <feature>: <why>", got "${line}"`);
      return;
    }
    if (!line.slice(path.length).includes("#")) {
      problems.push(`line ${index + 1}: ${path} has no "# <feature>: <why>" reason`);
    }
    if (seen.has(path)) problems.push(`line ${index + 1}: ${path} is listed twice`);
    seen.add(path);
    entries.push(path);
  });
  const sorted = [...entries].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (sorted.some((path, i) => path !== entries[i])) {
    problems.push("entries are not sorted (byte order); sort the non-comment lines");
  }
  return { entries, problems };
};

/**
 * @param {{ changed: readonly string[], seams: readonly string[], upstreamFiles: ReadonlySet<string> }} input
 *   changed: upstream files (at the merge base) that HEAD modified or deleted.
 * @returns {{ unlisted: string[], stale: string[], notUpstream: string[] }}
 */
export const evaluateSeams = ({ changed, seams, upstreamFiles }) => {
  const listed = new Set(seams);
  const changedSet = new Set(changed);
  return {
    unlisted: changed.filter((path) => !listed.has(path)),
    stale: seams.filter((path) => upstreamFiles.has(path) && !changedSet.has(path)),
    notUpstream: seams.filter((path) => !upstreamFiles.has(path)),
  };
};

/** @param {string} output NUL-separated `git` path output */
export const splitNul = (output) => output.split("\0").filter(Boolean);

const git = (args, cwd) => {
  const result = NodeChildProcess.spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${(result.stderr ?? "").trim()}`);
  }
  return result.stdout;
};

/**
 * @param {{ cwd: string, upstreamRef: string, seamsText: string }} input
 */
export const checkForkSeams = ({ cwd, upstreamRef, seamsText }) => {
  const mergeBase = git(["merge-base", "HEAD", upstreamRef], cwd).trim();
  const upstreamFiles = new Set(
    splitNul(git(["ls-tree", "-r", "-z", "--name-only", mergeBase], cwd)),
  );
  // Blob ids only (no rename detection), so a blobless CI clone never fetches file contents.
  const changed = splitNul(
    git(["diff", "--name-only", "--no-renames", "--diff-filter=MDT", "-z", mergeBase, "HEAD"], cwd),
  );
  const { entries, problems } = parseSeams(seamsText);
  return { mergeBase, problems, ...evaluateSeams({ changed, seams: entries, upstreamFiles }) };
};

const main = () => {
  const args = NodeProcess.argv.slice(2);
  const fetch = args.includes("--fetch");
  const positional = args.filter((arg) => !arg.startsWith("--"));
  const cwd = git(["rev-parse", "--show-toplevel"], NodeProcess.cwd()).trim();

  let upstreamRef =
    positional[0] ?? NodeProcess.env.FORK_SEAMS_UPSTREAM_REF ?? DEFAULT_UPSTREAM_REF;
  if (fetch) {
    git(["fetch", "--quiet", "--no-tags", "--filter=blob:none", UPSTREAM_URL, "main"], cwd);
    upstreamRef = git(["rev-parse", "FETCH_HEAD"], cwd).trim();
  }

  const seamsPath = NodePath.join(cwd, SEAMS_FILE);
  const seamsText = NodeFS.existsSync(seamsPath) ? NodeFS.readFileSync(seamsPath, "utf8") : "";
  const result = checkForkSeams({ cwd, upstreamRef, seamsText });

  console.log(`fork-seams: merge base with ${upstreamRef} is ${result.mergeBase.slice(0, 12)}`);
  for (const path of result.stale) {
    console.warn(`fork-seams: warning: ${path} no longer differs from upstream; drop its entry`);
  }
  for (const path of result.notUpstream) {
    console.warn(
      `fork-seams: warning: ${path} is not an upstream file; fork-only files need no entry`,
    );
  }

  let failed = false;
  for (const problem of result.problems) {
    console.error(`fork-seams: ${SEAMS_FILE} ${problem}`);
    failed = true;
  }
  if (result.unlisted.length > 0) {
    failed = true;
    console.error(
      `fork-seams: ${result.unlisted.length} upstream file(s) differ from upstream but are not in ${SEAMS_FILE}:`,
    );
    for (const path of result.unlisted) console.error(`  ${path}`);
    console.error(
      "Move the fork logic into a fork-only file and keep only a hook here, then list the file as\n" +
        `"<path>  # <feature>: <why>" in ${SEAMS_FILE}. Restore files the fork does not need to change.`,
    );
  }
  if (failed) NodeProcess.exit(1);
  console.log("fork-seams: ok");
};

if (
  NodeProcess.argv[1] &&
  NodePath.resolve(NodeProcess.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  main();
}
