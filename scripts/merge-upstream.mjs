#!/usr/bin/env node
// Fork-only. Welds upstream main into fork/dev as .agents/skills/update-upstream/SKILL.md
// describes, up to a draft PR; it never publishes or lands. Run with --help for flags and exit
// codes. stdout carries one JSON summary line; progress goes to stderr.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";

import { parseSeams, SEAMS_FILE } from "./check-fork-seams.mjs";
import { findRealGh } from "./lib/agent-gh-policy.mjs";

export const FORK_BRANCH = "fork/dev";
export const UPSTREAM_BRANCH = "main";
export const WELD_PREFIX = "sync/upstream-";
export const LOCKFILE = "pnpm-lock.yaml";
export const BUDGET_FILE = "apps/server/src/provider/agentContextBudget.json";
export const BUDGET_LABEL = "agent-context-increase";
export const ROUTE_TREE = "apps/web/src/routeTree.gen.ts";
const LOCALE_PATTERN = /^apps\/[^/]+\/src\/i18n\/translations\/[^/]+\.json$/;
const DEFAULT_MODEL_LINE = "Model: claude-opus-5-5; harness: Claude Code.";
const DEFAULT_TRAILERS = "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>";
const DEFAULT_PR_FOOTER = "🤖 Generated with [Claude Code](https://claude.com/claude-code)";
const PR_BODY_LIMIT = 60_000;

export const EXIT = { ok: 0, error: 1, conflicts: 2, checks: 3, busy: 4 };

const USAGE = `Usage: node scripts/merge-upstream.mjs [--dry-run | --prepare | --continue] [--worktree-dir <dir>]
  (no flag)       fetch, create the weld worktree, merge, check, push, open a draft PR
  --dry-run       fetch and print the overlap report; change nothing
  --prepare       stop before merging so superseded-feature drops can be committed first
  --continue      resume inside the weld worktree after a stop
  --worktree-dir  parent directory of the weld worktree (default: beside this checkout)
Exit codes: 0 done, up to date, or prepared; 1 error; 2 conflicts need a hand; 3 checks or push
failed; 4 a weld is already open or in progress.
MERGE_UPSTREAM_MODEL_LINE, MERGE_UPSTREAM_TRAILERS and MERGE_UPSTREAM_PR_FOOTER override the
attribution; set them empty to omit it. MERGE_UPSTREAM_REPO overrides the fork repo (origin).`;

/**
 * @param {readonly string[]} paths unmerged paths after `git merge`
 * @returns {{ lockfile: string[], locale: string[], manual: string[] }}
 */
export const classifyConflicts = (paths) => {
  const result = { lockfile: [], locale: [], manual: [] };
  for (const path of paths) {
    if (path === LOCKFILE) result.lockfile.push(path);
    else if (LOCALE_PATTERN.test(path)) result.locale.push(path);
    else result.manual.push(path);
  }
  return result;
};

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

/**
 * Key-level 3-way merge: theirs (upstream) plus the keys ours (the fork) added, changed, or
 * deleted. Keys both sides changed apart are conflicts. Added keys follow their ours neighbour.
 * @param {{ base: Record<string, unknown> | null, ours: Record<string, unknown>, theirs: Record<string, unknown> }} input
 * @returns {{ merged: Record<string, unknown>, conflicts: string[] }}
 */
export const mergeLocaleJson = ({ base, ours, theirs }) => {
  const baseObject = base ?? {};
  const values = new Map(Object.entries(theirs));
  const order = Object.keys(theirs);
  const conflicts = [];
  const oursKeys = Object.keys(ours);

  oursKeys.forEach((key, index) => {
    const inBase = has(baseObject, key);
    if (inBase && same(ours[key], baseObject[key])) return;
    if (!values.has(key)) {
      if (inBase) {
        conflicts.push(key);
        return;
      }
      const anchor = oursKeys
        .slice(0, index)
        .reverse()
        .find((candidate) => values.has(candidate));
      order.splice(anchor === undefined ? 0 : order.indexOf(anchor) + 1, 0, key);
      values.set(key, ours[key]);
      return;
    }
    const theirsValue = values.get(key);
    if (same(theirsValue, ours[key])) return;
    if (inBase && same(theirsValue, baseObject[key])) values.set(key, ours[key]);
    else conflicts.push(key);
  });

  for (const key of Object.keys(baseObject)) {
    if (has(ours, key) || !values.has(key)) continue;
    if (same(values.get(key), baseObject[key])) {
      values.delete(key);
      order.splice(order.indexOf(key), 1);
    } else {
      conflicts.push(key);
    }
  }

  return { merged: Object.fromEntries(order.map((key) => [key, values.get(key)])), conflicts };
};

/**
 * Upstream growth of the agent context budget is accepted on the weld; fork growth is not.
 * @param {{ head: Record<string, number> | null, forkDev: Record<string, number> | null, upstream: Record<string, number> | null }} input
 * @returns {{ label: boolean, grown: { key: string, forkDev: number, head: number, upstream: number | undefined }[] }}
 */
export const decideBudgetLabel = ({ head, forkDev, upstream }) => {
  if (!head || !forkDev) return { label: false, grown: [] };
  const grown = Object.entries(head)
    .filter(([key, value]) => typeof value === "number" && value > (forkDev[key] ?? 0))
    .map(([key, value]) => ({
      key,
      forkDev: forkDev[key] ?? 0,
      head: value,
      upstream: upstream?.[key],
    }));
  const label = grown.length > 0 && grown.every((entry) => entry.upstream === entry.head);
  return { label, grown };
};

/**
 * Parse `git log --format=%x00%h %s --name-only` into the commits that touched each file.
 * @param {string} output
 * @returns {Map<string, string[]>}
 */
export const parseLogNameOnly = (output) => {
  const byFile = new Map();
  for (const chunk of output.split("\0").filter((part) => part.trim() !== "")) {
    const [commit = "", ...files] = chunk.split("\n");
    for (const file of files.map((line) => line.trim()).filter(Boolean)) {
      const list = byFile.get(file) ?? [];
      list.push(commit.trim());
      byFile.set(file, list);
    }
  }
  return byFile;
};

/**
 * Seam entries the upstream range touches, with their reason and the commits that touched them.
 * @param {{ rangeFiles: readonly string[], seamsText: string, commitsByFile: Map<string, string[]> }} input
 * @returns {{ path: string, reason: string, commits: string[] }[]}
 */
export const computeOverlap = ({ rangeFiles, seamsText, commitsByFile }) => {
  const reasons = new Map(
    seamsText
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"))
      .map((line) => {
        const match = /^(\S+)\s+#\s*(.*)$/.exec(line);
        return match ? [match[1], match[2]] : [line, ""];
      }),
  );
  const touched = new Set(rangeFiles);
  return parseSeams(seamsText)
    .entries.filter((path) => touched.has(path))
    .map((path) => ({
      path,
      reason: reasons.get(path) ?? "",
      commits: commitsByFile.get(path) ?? [],
    }));
};

/**
 * @param {{ base: string, sha: string, commits: number, modelLine?: string, trailers?: string }} input
 */
export const buildMergeMessage = ({ base, sha, commits, modelLine = "", trailers = "" }) =>
  [
    `Merge upstream main through ${sha.slice(0, 12)}`,
    `Weld pingdotgg/t3code main ${base.slice(0, 12)}..${sha.slice(0, 12)} (${commits} commits) into ${FORK_BRANCH}.`,
    modelLine.trim(),
    trailers.trim(),
  ]
    .filter(Boolean)
    .join("\n\n");

/**
 * @param {{ base: string, sha: string, commits: number, files: number, overlap: { path: string, reason: string, commits: string[] }[], rangeLog: string[] }} input
 */
export const formatOverlapReport = ({ base, sha, commits, files, overlap, rangeLog }) => {
  const lines = [
    `Upstream range \`${base.slice(0, 12)}..${sha.slice(0, 12)}\`: ${commits} commits, ${files} files.`,
    "",
    "### Commits",
    "",
    ...rangeLog.map((line) => `- ${line}`),
    "",
    `### Overlap with ${SEAMS_FILE} (${overlap.length})`,
    "",
  ];
  if (overlap.length === 0) lines.push("None: the range touches no seam file.");
  for (const entry of overlap) {
    lines.push(`- \`${entry.path}\`: ${entry.reason}`);
    for (const commit of entry.commits) lines.push(`  - ${commit}`);
  }
  return lines.join("\n");
};

/**
 * @param {{ report: string, autoResolved: { path: string, how: string }[], manual: string[], forkCommits: string[], footer?: string }} input
 */
export const buildPrBody = ({ report, autoResolved, manual, forkCommits, footer = "" }) => {
  const sections = [report];
  if (forkCommits.length > 0) {
    sections.push(
      ["### Fork commits on this weld", "", ...forkCommits.map((c) => `- ${c}`)].join("\n"),
    );
  }
  sections.push(
    [
      "### Conflicts",
      "",
      ...(autoResolved.length === 0 && manual.length === 0 ? ["None."] : []),
      ...autoResolved.map((entry) => `- \`${entry.path}\`: ${entry.how} (auto)`),
      ...manual.map((path) => `- \`${path}\`: resolved by hand`),
    ].join("\n"),
  );
  sections.push("Land with `gh pr merge --merge`. Do not squash.");
  if (footer.trim()) sections.push(footer.trim());
  let body = sections.join("\n\n");
  if (body.length > PR_BODY_LIMIT) {
    const tail = sections.slice(1).join("\n\n");
    body = `${report.slice(0, PR_BODY_LIMIT - tail.length - 40)}\n\n…(report truncated)\n\n${tail}`;
  }
  return body;
};

class Stop extends Error {
  /** @param {number} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const log = (message) => NodeProcess.stderr.write(`merge-upstream: ${message}\n`);

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd: string, inherit?: boolean, allowFail?: boolean, env?: NodeJS.ProcessEnv }} options
 */
const run = (command, args, { cwd, inherit = false, allowFail = false, env }) => {
  const result = NodeChildProcess.spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: env ?? NodeProcess.env,
    maxBuffer: 256 * 1024 * 1024,
    stdio: inherit ? ["ignore", 2, 2] : ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFail) {
    throw new Error(`${command} ${args.join(" ")} failed: ${(result.stderr ?? "").trim()}`);
  }
  return { ok: result.status === 0, stdout: (result.stdout ?? "").trim() };
};

const git = (cwd, ...args) => run("git", args, { cwd }).stdout;
const gitOk = (cwd, ...args) => run("git", args, { cwd, allowFail: true }).ok;

// The real gh, not the .tools/bin shim: nothing here publishes, so the ship gate has no say.
const ghRun = (cwd, args, allowFail = false) => {
  const binary = findRealGh();
  if (!binary) throw new Error("could not resolve the real `gh` binary (set AGENT_GH_REAL)");
  return run(binary, args, { cwd, allowFail });
};
const gh = (cwd, ...args) => ghRun(cwd, args).stdout;

const readJsonAt = (cwd, ref, path) => {
  const result = run("git", ["show", `${ref}:${path}`], { cwd, allowFail: true });
  if (!result.ok) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
};

/** owner/name of `origin`, so a fork of the fork welds into itself. */
const forkRepo = (cwd) => {
  if (NodeProcess.env.MERGE_UPSTREAM_REPO) return NodeProcess.env.MERGE_UPSTREAM_REPO;
  const url = git(cwd, "remote", "get-url", "origin");
  const match = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(url);
  if (!match) throw new Error(`origin (${url}) is not a GitHub remote; set MERGE_UPSTREAM_REPO`);
  return match[1];
};

const timer = (durations) => (phase, fn) => {
  const started = NodeProcess.hrtime.bigint();
  try {
    return fn();
  } finally {
    const ms = Number((NodeProcess.hrtime.bigint() - started) / 1_000_000n);
    durations[phase] = (durations[phase] ?? 0) + ms;
  }
};

const statePath = (cwd) =>
  NodePath.resolve(cwd, git(cwd, "rev-parse", "--git-path", "merge-upstream.json"));
const saveState = (cwd, state) =>
  NodeFS.writeFileSync(statePath(cwd), `${JSON.stringify(state, null, 2)}\n`);
const loadState = (cwd) => {
  const path = statePath(cwd);
  if (!NodeFS.existsSync(path)) {
    throw new Stop(
      EXIT.error,
      "no merge-upstream state here; run --continue inside the weld worktree",
    );
  }
  return JSON.parse(NodeFS.readFileSync(path, "utf8"));
};

const summaryOf = (state, extra = {}) => ({
  pr: state.pr ?? null,
  sha: state.sha ?? null,
  commits: state.commits ?? 0,
  files: state.files ?? 0,
  seamOverlap: (state.overlap ?? []).map((entry) => entry.path),
  autoResolved: (state.autoResolved ?? []).map((entry) => entry.path),
  manualConflicts: state.manual ?? [],
  worktree: state.worktree ?? null,
  durationsMs: state.durations ?? {},
  ...extra,
});

const fetchRefs = (cwd) => {
  const upstreamUrl = git(cwd, "remote", "get-url", "upstream");
  if (!/pingdotgg\/t3code(\.git)?$/.test(upstreamUrl)) {
    throw new Error(`remote upstream is ${upstreamUrl}, expected pingdotgg/t3code`);
  }
  git(cwd, "fetch", "--quiet", "origin", FORK_BRANCH);
  git(cwd, "fetch", "--quiet", "upstream", UPSTREAM_BRANCH);
  return {
    forkDev: git(cwd, "rev-parse", `origin/${FORK_BRANCH}`),
    sha: git(cwd, "rev-parse", `upstream/${UPSTREAM_BRANCH}`),
  };
};

const openWelds = (cwd, repo) =>
  JSON.parse(
    gh(
      cwd,
      "pr",
      "list",
      "--repo",
      repo,
      "--base",
      FORK_BRANCH,
      "--state",
      "open",
      "--json",
      "number,headRefName,isDraft,url",
    ),
  ).filter((pr) => pr.headRefName.startsWith(WELD_PREFIX));

const overlapFor = (cwd, { forkDev, sha }) => {
  const base = git(cwd, "merge-base", forkDev, sha);
  const range = `${base}..${sha}`;
  const commits = Number(git(cwd, "rev-list", "--count", range));
  const rangeFiles = git(cwd, "diff", "--name-only", "--no-renames", base, sha)
    .split("\n")
    .filter(Boolean);
  const rangeLog = git(cwd, "log", "--format=%h %s", range).split("\n").filter(Boolean);
  const commitsByFile = parseLogNameOnly(
    git(cwd, "log", "--no-renames", "--format=%x00%h %s", "--name-only", range),
  );
  const seamsText = run("git", ["show", `${forkDev}:${SEAMS_FILE}`], {
    cwd,
    allowFail: true,
  }).stdout;
  const overlap = computeOverlap({ rangeFiles, seamsText, commitsByFile });
  const report = formatOverlapReport({
    base,
    sha,
    commits,
    files: rangeFiles.length,
    overlap,
    rangeLog,
  });
  return { base, commits, files: rangeFiles.length, overlap, report };
};

const createWorktree = (cwd, { sha, forkDev, parentDir }) => {
  const sha12 = sha.slice(0, 12);
  const branch = `${WELD_PREFIX}${sha12}`;
  const worktree = NodePath.join(parentDir, `sync-upstream-${sha12}`);
  const existing = git(cwd, "worktree", "list", "--porcelain")
    .split("\n\n")
    .find((block) => block.includes(`branch refs/heads/${branch}`));
  if (existing) {
    const path = existing.split("\n")[0]?.replace(/^worktree /, "");
    throw new Stop(
      EXIT.busy,
      `weld ${branch} is already in progress at ${path}; run --continue there`,
    );
  }
  if (gitOk(cwd, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`)) {
    throw new Stop(
      EXIT.busy,
      `branch ${branch} already exists without a worktree; delete it or weld by hand`,
    );
  }
  git(cwd, "worktree", "add", "--quiet", "-b", branch, worktree, forkDev);
  run("git", ["branch", "--unset-upstream"], { cwd: worktree, allowFail: true });
  return { branch, worktree };
};

const unmergedPaths = (cwd) =>
  git(cwd, "diff", "--name-only", "--diff-filter=U").split("\n").filter(Boolean);

const resolveLocale = (cwd, path) => {
  const stage = (n) => {
    const result = run("git", ["show", `:${n}:${path}`], { cwd, allowFail: true });
    return result.ok ? JSON.parse(result.stdout) : null;
  };
  const [base, ours, theirs] = [stage(1), stage(2), stage(3)];
  if (!ours || !theirs) return { ok: false, keys: ["(file deleted on one side)"] };
  const { merged, conflicts } = mergeLocaleJson({ base, ours, theirs });
  if (conflicts.length > 0) return { ok: false, keys: conflicts };
  NodeFS.writeFileSync(NodePath.join(cwd, path), `${JSON.stringify(merged, null, 2)}\n`);
  return { ok: true, keys: [] };
};

/** Resolves what it can, stages it, and returns what still needs a hand. */
const autoResolve = (state) => {
  const cwd = state.worktree;
  const classes = classifyConflicts(unmergedPaths(cwd));
  for (const path of classes.lockfile) {
    git(cwd, "checkout", "--theirs", "--", path);
    git(cwd, "add", "--", path);
    state.autoResolved.push({ path, how: "upstream's lockfile, regenerated with `pnpm install`" });
  }
  const localeKeys = {};
  const resolvedLocales = [];
  for (const path of classes.locale) {
    const result = resolveLocale(cwd, path);
    if (result.ok) resolvedLocales.push(path);
    else localeKeys[path] = result.keys;
  }
  if (resolvedLocales.length > 0) {
    run("vp", ["fmt", "--write", ...resolvedLocales], { cwd, allowFail: true });
    git(cwd, "add", "--", ...resolvedLocales);
    for (const path of resolvedLocales)
      state.autoResolved.push({ path, how: "key-level 3-way merge" });
  }
  return [...classes.manual, ...Object.keys(localeKeys)].map((path) =>
    localeKeys[path] ? `${path} (keys: ${localeKeys[path].join(", ")})` : path,
  );
};

const mergePhase = (state, time) => {
  const cwd = state.worktree;
  const message = buildMergeMessage({
    base: state.base,
    sha: state.sha,
    commits: state.commits,
    modelLine: NodeProcess.env.MERGE_UPSTREAM_MODEL_LINE ?? DEFAULT_MODEL_LINE,
    trailers: NodeProcess.env.MERGE_UPSTREAM_TRAILERS ?? DEFAULT_TRAILERS,
  });
  time("merge", () =>
    run("git", ["merge", "--no-ff", "--no-commit", "-m", message, state.sha], {
      cwd,
      allowFail: true,
    }),
  );
  if (!gitOk(cwd, "rev-parse", "-q", "--verify", "MERGE_HEAD")) {
    throw new Error("git merge did not start a merge; see the output above");
  }
  state.conflicts = unmergedPaths(cwd);
  state.phase = "merging";
  saveState(cwd, state);
};

const finishMerge = (state, time) => {
  const cwd = state.worktree;
  const remaining = time("resolve", () => autoResolve(state));
  const autoPaths = new Set(state.autoResolved.map((entry) => entry.path));
  state.manual = state.conflicts.filter((path) => !autoPaths.has(path));
  saveState(cwd, state);
  if (remaining.length > 0) {
    throw new Stop(
      EXIT.conflicts,
      [
        `${remaining.length} conflict(s) need a hand in ${cwd}:`,
        ...remaining.map((path) => `  ${path}`),
        "Next: resolve each as a 3-way merge (seam files take upstream and re-apply the fork hook),",
        `then \`git add <files>\` and \`node scripts/merge-upstream.mjs --continue\` in ${cwd}.`,
      ].join("\n"),
    );
  }
  time("install", () =>
    run("pnpm", ["install", "--no-frozen-lockfile"], {
      cwd,
      inherit: true,
      env: { ...NodeProcess.env, CI: "" },
    }),
  );
  git(cwd, "add", "--", LOCKFILE);
  time("commit", () => run("git", ["commit", "--no-edit"], { cwd, inherit: true }));
  state.phase = "merged";
  saveState(cwd, state);
};

const checksPhase = (state, time) => {
  const cwd = state.worktree;
  const checks = [
    ["seams", "node", ["scripts/check-fork-seams.mjs", state.sha]],
    ["i18n", "vp", ["run", "i18n:check"]],
    ["typecheck", "vp", ["run", "typecheck"]],
  ];
  const failed = checks
    .filter(([name, command, args]) => {
      log(`check: ${name}`);
      return !time(
        `check:${name}`,
        () => run(command, args, { cwd, inherit: true, allowFail: true }).ok,
      );
    })
    .map(([name]) => name);
  if (git(cwd, "status", "--porcelain", "--", ROUTE_TREE) !== "") {
    git(cwd, "checkout", "--", ROUTE_TREE);
  }
  const dirty = git(cwd, "status", "--porcelain", "--untracked-files=no");
  if (failed.length > 0 || dirty !== "") {
    throw new Stop(
      EXIT.checks,
      [
        failed.length > 0
          ? `checks failed: ${failed.join(", ")}`
          : "checks left uncommitted changes:",
        ...(dirty ? [dirty] : []),
        `Next: fix in commits of their own in ${cwd}, then \`node scripts/merge-upstream.mjs --continue\`.`,
      ].join("\n"),
    );
  }
  state.phase = "checked";
  saveState(cwd, state);
};

const publishPhase = (state, time) => {
  const cwd = state.worktree;
  const pushed = time("push", () =>
    run("git", ["push", "--quiet", "-u", "origin", state.branch], {
      cwd,
      inherit: true,
      allowFail: true,
    }),
  );
  if (!pushed.ok)
    throw new Stop(EXIT.checks, "git push failed (see the pre-push gate output above)");

  const existing = JSON.parse(
    gh(
      cwd,
      "pr",
      "list",
      "--repo",
      state.repo,
      "--head",
      state.branch,
      "--state",
      "open",
      "--json",
      "number,url",
    ),
  )[0];
  if (existing) {
    state.pr = existing.number;
    state.prUrl = existing.url;
  } else {
    const forkCommits = git(
      cwd,
      "log",
      "--first-parent",
      "--no-merges",
      "--format=%h %s",
      `${state.forkDev}..HEAD`,
    )
      .split("\n")
      .filter(Boolean);
    const body = buildPrBody({
      report: state.report,
      autoResolved: state.autoResolved,
      manual: state.manual,
      forkCommits,
      footer: NodeProcess.env.MERGE_UPSTREAM_PR_FOOTER ?? DEFAULT_PR_FOOTER,
    });
    const bodyFile = NodePath.resolve(
      cwd,
      git(cwd, "rev-parse", "--git-path", "merge-upstream-pr.md"),
    );
    NodeFS.writeFileSync(bodyFile, body);
    const url = time("pr", () =>
      gh(
        cwd,
        "pr",
        "create",
        "--repo",
        state.repo,
        "--draft",
        "--base",
        FORK_BRANCH,
        "--head",
        state.branch,
        "--title",
        `Merge upstream main through ${state.sha.slice(0, 12)}`,
        "--body-file",
        bodyFile,
      ),
    );
    state.prUrl = url.split("\n").pop();
    state.pr = Number(/\/pull\/(\d+)/.exec(state.prUrl)?.[1] ?? 0) || null;
  }
  saveState(cwd, state);

  time("budget", () => {
    const decision = decideBudgetLabel({
      head: readJsonAt(cwd, "HEAD", BUDGET_FILE),
      forkDev: readJsonAt(cwd, state.forkDev, BUDGET_FILE),
      upstream: readJsonAt(cwd, state.sha, BUDGET_FILE),
    });
    state.budget = decision;
    if (decision.grown.length > 0 && !decision.label) {
      log(
        `agent context budget grew beyond upstream's values; the Agent Context Budget check will fail`,
      );
    }
    if (!decision.label || !state.pr || state.budgetLabeled) return;
    const rows = decision.grown.map(
      (g) => `| \`${g.key}\` | ${g.forkDev} | ${g.head} | ${g.upstream} |`,
    );
    const comment = [
      `Added \`${BUDGET_LABEL}\`: every value that grew against \`${FORK_BRANCH}\` equals upstream main's, so the growth is upstream's own.`,
      "",
      `| ${BUDGET_FILE} | ${FORK_BRANCH} | weld | upstream |`,
      "| --- | --- | --- | --- |",
      ...rows,
    ].join("\n");
    const labeled = ghRun(
      cwd,
      ["pr", "edit", String(state.pr), "--repo", state.repo, "--add-label", BUDGET_LABEL],
      true,
    );
    if (!labeled.ok) {
      log(`could not add the ${BUDGET_LABEL} label; add it by hand`);
      return;
    }
    gh(cwd, "pr", "comment", String(state.pr), "--repo", state.repo, "--body", comment);
    state.budgetLabeled = true;
  });
  state.phase = "done";
  saveState(cwd, state);
};

const parseArgs = (argv) => {
  const flags = { dryRun: false, prepare: false, resume: false, help: false, worktreeDir: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") flags.dryRun = true;
    else if (arg === "--prepare") flags.prepare = true;
    else if (arg === "--continue") flags.resume = true;
    else if (arg === "--help" || arg === "-h") flags.help = true;
    else if (arg === "--worktree-dir") flags.worktreeDir = argv[++i] ?? null;
    else {
      NodeProcess.stderr.write(`merge-upstream: unknown argument ${arg}\n${USAGE}\n`);
      return null;
    }
  }
  return flags;
};

const advance = (state, time) => {
  if (state.phase === "prepared") mergePhase(state, time);
  if (state.phase === "merging") finishMerge(state, time);
  if (state.phase === "merged") checksPhase(state, time);
  if (state.phase === "checked") publishPhase(state, time);
};

const main = () => {
  const flags = parseArgs(NodeProcess.argv.slice(2));
  if (!flags) return EXIT.error;
  if (flags.help) {
    NodeProcess.stderr.write(`${USAGE}\n`);
    return EXIT.ok;
  }
  const cwd = git(NodeProcess.cwd(), "rev-parse", "--show-toplevel");
  const durations = {};
  const time = timer(durations);
  let state = { durations };

  try {
    if (flags.resume) {
      state = loadState(cwd);
      state.durations ??= {};
      const resumeTime = timer(state.durations);
      if (state.phase === "merging" && !gitOk(cwd, "rev-parse", "-q", "--verify", "MERGE_HEAD")) {
        const committed = run("git", ["rev-parse", "HEAD^2"], { cwd, allowFail: true });
        if (committed.stdout !== state.sha) {
          throw new Stop(EXIT.error, "the merge was aborted; remove this worktree and rerun");
        }
        state.phase = "merged";
      }
      advance(state, resumeTime);
    } else {
      const repo = forkRepo(cwd);
      const refs = time("fetch", () => fetchRefs(cwd));
      state = { ...state, repo, ...refs };
      if (gitOk(cwd, "merge-base", "--is-ancestor", refs.sha, refs.forkDev)) {
        log(
          `up to date: upstream/main ${refs.sha.slice(0, 12)} is already in origin/${FORK_BRANCH}`,
        );
        NodeProcess.stdout.write(`${JSON.stringify(summaryOf(state, { status: "up-to-date" }))}\n`);
        return EXIT.ok;
      }
      const welds = openWelds(cwd, repo);
      if (welds.length > 0 && !flags.dryRun) {
        const pr = welds[0];
        log(
          `weld already open: #${pr.number} ${pr.headRefName}${pr.isDraft ? " (draft)" : ""} ${pr.url}; finish it first`,
        );
        NodeProcess.stdout.write(
          `${JSON.stringify(summaryOf({ ...state, pr: pr.number }, { status: "open-weld" }))}\n`,
        );
        return EXIT.busy;
      }
      for (const pr of welds) log(`open weld: #${pr.number} ${pr.headRefName}`);
      Object.assign(
        state,
        time("overlap", () => overlapFor(cwd, refs)),
      );
      NodeProcess.stderr.write(`\n${state.report}\n\n`);
      if (flags.dryRun) {
        NodeProcess.stdout.write(`${JSON.stringify(summaryOf(state, { status: "dry-run" }))}\n`);
        return EXIT.ok;
      }
      const parentDir = flags.worktreeDir
        ? NodePath.resolve(flags.worktreeDir)
        : NodePath.dirname(cwd);
      Object.assign(
        state,
        time("worktree", () => createWorktree(cwd, { ...refs, parentDir })),
      );
      state.autoResolved = [];
      state.conflicts = [];
      state.manual = [];
      state.phase = "prepared";
      saveState(state.worktree, state);
      log(`weld worktree ${state.worktree} on ${state.branch}`);
      time("install", () =>
        run("vp", ["i"], {
          cwd: state.worktree,
          inherit: true,
          env: { ...NodeProcess.env, CI: "" },
        }),
      );
      if (flags.prepare) {
        log(
          `prepared; commit any superseded-feature drops in ${state.worktree}, then run --continue there`,
        );
        NodeProcess.stdout.write(`${JSON.stringify(summaryOf(state, { status: "prepared" }))}\n`);
        return EXIT.ok;
      }
      advance(state, time);
    }
    log(
      `draft PR ${state.prUrl ?? "(none)"}; land with \`gh pr merge ${state.pr ?? "<n>"} --merge\` once checks are green`,
    );
    NodeProcess.stdout.write(`${JSON.stringify(summaryOf(state, { status: "opened" }))}\n`);
    return EXIT.ok;
  } catch (error) {
    const code = error instanceof Stop ? error.code : EXIT.error;
    log(error instanceof Error ? error.message : String(error));
    const status =
      { [EXIT.conflicts]: "conflicts", [EXIT.checks]: "checks-failed", [EXIT.busy]: "busy" }[
        code
      ] ?? "error";
    NodeProcess.stdout.write(`${JSON.stringify(summaryOf(state, { status }))}\n`);
    return code;
  }
};

if (
  NodeProcess.argv[1] &&
  NodePath.resolve(NodeProcess.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  process.exitCode = main();
}
