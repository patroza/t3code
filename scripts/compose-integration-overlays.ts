#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalConsole:off

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { readManifest, StackError } from "./rebase-pr-stack.ts";

function run(
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
  options: { allowFailure?: boolean; env?: NodeJS.ProcessEnv; stdioInherit?: boolean } = {},
): { status: number | null; stdout: string; stderr: string } {
  const result = NodeChildProcess.spawnSync(command, [...args], {
    cwd,
    encoding: "utf8",
    stdio: options.stdioInherit ? "inherit" : "pipe",
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_EDITOR: "true",
      ...options.env,
    },
  });
  const stdout = typeof result.stdout === "string" ? result.stdout.trim() : "";
  const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
  if (!options.allowFailure && result.status !== 0) {
    throw new StackError(
      `${command} ${args.join(" ")} failed: ${stderr || stdout || `exit ${result.status}`}`,
    );
  }
  return { status: result.status, stdout, stderr };
}

function git(
  cwd: string,
  args: ReadonlyArray<string>,
  options: { allowFailure?: boolean } = {},
): string {
  return run("git", args, cwd, options).stdout;
}

export function overlayCommitList(revListOutput: string): ReadonlyArray<string> {
  return revListOutput
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function isLockfileOnlyCommit(paths: ReadonlyArray<string>): boolean {
  return paths.length > 0 && paths.every((path) => path === "pnpm-lock.yaml");
}

/** Drop proxy vars so install hits the registry directly (agent sessions may inherit SOCKS). */
export function envWithoutProxy(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, CI: "" };
  for (const key of Object.keys(env)) {
    if (/^(https?|all|no)_?proxy$/i.test(key)) {
      delete env[key];
    }
  }
  return env;
}

/**
 * Prefer a work directory on the same filesystem as warm `node_modules` so
 * `cp --reflink=auto` can clone CoW extents (btrfs/xfs). `/tmp` is often tmpfs —
 * never use it when a home-side cache dir exists.
 */
export function composeWorkRoot(sourceRoot: string): string {
  const fromEnv = process.env.COMPOSE_WORK_ROOT?.trim();
  if (fromEnv) {
    NodeFS.mkdirSync(fromEnv, { recursive: true });
    return fromEnv;
  }
  const home = process.env.HOME?.trim();
  if (home) {
    const preferred = NodePath.join(home, ".t3", "compose-work");
    try {
      NodeFS.mkdirSync(preferred, { recursive: true });
      return preferred;
    } catch {
      // fall through
    }
  }
  const sourceParent = NodePath.dirname(NodePath.resolve(sourceRoot));
  try {
    NodeFS.accessSync(sourceParent, NodeFS.constants.W_OK);
    return sourceParent;
  } catch {
    return NodeOS.tmpdir();
  }
}

export function candidateNodeModulesDirs(sourceRoot: string): ReadonlyArray<string> {
  const fromEnv = process.env.COMPOSE_NODE_MODULES_SOURCE?.trim();
  const candidates = [
    ...(fromEnv ? [fromEnv] : []),
    NodePath.join(sourceRoot, "node_modules"),
    NodePath.join(NodePath.resolve(sourceRoot, ".."), "node_modules"),
    NodePath.join(NodeOS.homedir(), "pj", "t3code", "node_modules"),
    NodePath.join(NodeOS.homedir(), "deploy", "t3code", "node_modules"),
  ];
  return candidates.filter((dir, index) => candidates.indexOf(dir) === index);
}

/**
 * Seed `repoDir/node_modules` from a warm tree via `cp -a --reflink=auto`
 * (btrfs/xfs CoW when same FS; falls back to full copy).
 */
export function seedNodeModules(repoDir: string, sourceRoot: string): string | undefined {
  const dest = NodePath.join(repoDir, "node_modules");
  if (NodeFS.existsSync(dest)) return dest;
  for (const source of candidateNodeModulesDirs(sourceRoot)) {
    if (!NodeFS.existsSync(source) || !NodeFS.statSync(source).isDirectory()) continue;
    console.log(`Seeding node_modules from ${source} (cp -a --reflink=auto)…`);
    const started = Date.now();
    const result = run("cp", ["-a", "--reflink=auto", source, dest], repoDir, {
      allowFailure: true,
    });
    if (result.status === 0 && NodeFS.existsSync(dest)) {
      console.log(`Seeded node_modules in ${((Date.now() - started) / 1000).toFixed(1)}s`);
      return dest;
    }
    console.warn(
      `Reflink/copy from ${source} failed (${result.stderr || result.stdout || `exit ${result.status}`}); trying next candidate.`,
    );
    try {
      NodeFS.rmSync(dest, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  console.warn("No warm node_modules seed available; pnpm install will be cold.");
  return undefined;
}

function commitPaths(repoDir: string, commit: string): ReadonlyArray<string> {
  return git(repoDir, ["diff-tree", "--no-commit-id", "--name-only", "-r", commit])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function conflictingPaths(repoDir: string): ReadonlyArray<string> {
  return git(repoDir, ["diff", "--name-only", "--diff-filter=U"])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function cherryPickInProgress(repoDir: string): boolean {
  return (
    NodeFS.existsSync(NodePath.join(repoDir, ".git", "CHERRY_PICK_HEAD")) ||
    NodeFS.existsSync(NodePath.join(repoDir, ".git", "sequencer", "todo"))
  );
}

/**
 * Cherry-pick overlay commits onto the integration base.
 * Lockfile-only commits are skipped (combined tree is regenerated after compose).
 * If a mixed commit conflicts only on `pnpm-lock.yaml`, keep the current lock and continue.
 */
export function cherryPickOverlayCommits(
  repoDir: string,
  commits: ReadonlyArray<string>,
): { skippedLockfileOnly: number; deferredLockfileConflicts: number } {
  let skippedLockfileOnly = 0;
  let deferredLockfileConflicts = 0;
  for (const commit of commits) {
    const paths = commitPaths(repoDir, commit);
    if (isLockfileOnlyCommit(paths)) {
      console.log(`Skipping lockfile-only overlay commit ${commit.slice(0, 12)}`);
      skippedLockfileOnly += 1;
      continue;
    }
    const result = run("git", ["-c", "commit.gpgsign=false", "cherry-pick", commit], repoDir, {
      allowFailure: true,
    });
    if (result.status === 0) continue;
    if (!cherryPickInProgress(repoDir)) {
      throw new StackError(
        `git cherry-pick ${commit.slice(0, 12)} failed: ${result.stderr || result.stdout}`,
      );
    }
    const conflicts = conflictingPaths(repoDir);
    if (conflicts.length === 1 && conflicts[0] === "pnpm-lock.yaml") {
      git(repoDir, ["checkout", "--ours", "--", "pnpm-lock.yaml"]);
      git(repoDir, ["add", "--", "pnpm-lock.yaml"]);
      const cont = run(
        "git",
        ["-c", "commit.gpgsign=false", "cherry-pick", "--continue"],
        repoDir,
        { allowFailure: true },
      );
      if (cont.status !== 0 && cherryPickInProgress(repoDir)) {
        throw new StackError(
          `Could not continue cherry-pick after deferring lockfile for ${commit.slice(0, 12)}: ${cont.stderr || cont.stdout}`,
        );
      }
      console.log(
        `Deferred pnpm-lock.yaml conflict for ${commit.slice(0, 12)} (will regenerate after compose)`,
      );
      deferredLockfileConflicts += 1;
      continue;
    }
    throw new StackError(
      `Overlay cherry-pick conflict on ${commit.slice(0, 12)}: ${conflicts.join(", ") || "(unknown paths)"}. ` +
        `Record a durable resolution policy if this is a known product conflict, or fix the overlay tip.`,
    );
  }
  return { skippedLockfileOnly, deferredLockfileConflicts };
}

function regenerateIntegrationLockfile(repoDir: string, sourceRoot: string): boolean {
  seedNodeModules(repoDir, sourceRoot);
  console.log("Regenerating pnpm-lock.yaml for composed integration tree…");
  const install = run("pnpm", ["install", "--no-frozen-lockfile", "--prefer-offline"], repoDir, {
    allowFailure: true,
    env: envWithoutProxy(),
    stdioInherit: true,
  });
  if (install.status !== 0) {
    throw new StackError(
      `pnpm install --no-frozen-lockfile failed after overlay compose (exit ${install.status}).`,
    );
  }
  const dirty = run("git", ["status", "--porcelain", "--", "pnpm-lock.yaml"], repoDir, {
    allowFailure: true,
  }).stdout;
  if (!dirty) {
    console.log("pnpm-lock.yaml already matched the composed tree.");
    return false;
  }
  git(repoDir, ["add", "--", "pnpm-lock.yaml"]);
  git(repoDir, [
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "chore(integration): regenerate pnpm-lock.yaml after overlay compose",
  ]);
  console.log("Committed regenerated integration lockfile.");
  return true;
}

export function composeIntegration(sourceRoot = process.cwd(), push = true): string {
  const manifest = readManifest(sourceRoot);
  const originUrl = git(sourceRoot, ["remote", "get-url", "origin"]);
  const workRoot = composeWorkRoot(sourceRoot);
  const workDir = NodeFS.mkdtempSync(NodePath.join(workRoot, "compose-overlays-"));
  const repoDir = NodePath.join(workDir, "repo");
  NodeFS.mkdirSync(repoDir);
  console.log(`Compose work dir: ${workDir}`);
  try {
    git(repoDir, ["init", "--quiet"]);
    git(repoDir, ["config", "user.name", "T3 Code PR Stack"]);
    git(repoDir, ["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"]);
    git(repoDir, ["config", "commit.gpgsign", "false"]);
    git(repoDir, ["remote", "add", "origin", originUrl]);
    const branches = [
      manifest.forkChangesBranch,
      manifest.integrationBranch,
      ...manifest.integrationOverlays.map(({ branch }) => branch),
    ];
    git(repoDir, [
      "fetch",
      "--quiet",
      "--no-tags",
      "origin",
      ...branches.map((branch) => `+refs/heads/${branch}:refs/remotes/origin/${branch}`),
    ]);
    const base = git(repoDir, ["rev-parse", `origin/${manifest.forkChangesBranch}`]);
    const previous = git(repoDir, ["rev-parse", `origin/${manifest.integrationBranch}`]);
    git(repoDir, ["checkout", "--quiet", "--detach", base]);
    let needsLockfileRegen = false;
    for (const overlay of manifest.integrationOverlays) {
      const tip = git(repoDir, ["rev-parse", `origin/${overlay.branch}`]);
      const ancestor = NodeChildProcess.spawnSync(
        "git",
        ["merge-base", "--is-ancestor", base, tip],
        { cwd: repoDir, encoding: "utf8" },
      );
      if (ancestor.status !== 0) {
        throw new StackError(
          `Overlay PR #${overlay.number} (${overlay.branch}) is not based on current ${manifest.forkChangesBranch}.`,
        );
      }
      const commits = overlayCommitList(
        git(repoDir, ["rev-list", "--reverse", "--no-merges", `${base}..${tip}`]),
      );
      if (commits.length === 0) {
        throw new StackError(
          `Overlay PR #${overlay.number} has no commits above ${manifest.forkChangesBranch}.`,
        );
      }
      const result = cherryPickOverlayCommits(repoDir, commits);
      if (result.skippedLockfileOnly > 0 || result.deferredLockfileConflicts > 0) {
        needsLockfileRegen = true;
      }
    }
    // Always regenerate when overlays land packages: product trees must match frozen CI.
    if (needsLockfileRegen || manifest.integrationOverlays.length > 0) {
      regenerateIntegrationLockfile(repoDir, sourceRoot);
    }
    const next = git(repoDir, ["rev-parse", "HEAD"]);
    if (push && next !== previous) {
      git(repoDir, [
        "push",
        `--force-with-lease=refs/heads/${manifest.integrationBranch}:${previous}`,
        "origin",
        `${next}:refs/heads/${manifest.integrationBranch}`,
      ]);
    }
    return next;
  } finally {
    NodeFS.rmSync(workDir, { recursive: true, force: true });
  }
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === NodeURL.pathToFileURL(NodePath.resolve(process.argv[1])).href;

if (isMain) {
  const push = !process.argv.includes("--dry-run");
  try {
    const tip = composeIntegration(process.cwd(), push);
    console.log(`${push ? "Updated" : "Would update"} integration to ${tip}.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
