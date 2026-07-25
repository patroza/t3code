#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalConsole:off

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { readManifest, StackError } from "./rebase-pr-stack.ts";

function git(cwd: string, args: ReadonlyArray<string>): string {
  const result = NodeChildProcess.spawnSync("git", [...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true" },
  });
  if (result.status !== 0) {
    throw new StackError(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

export function overlayCommitList(revListOutput: string): ReadonlyArray<string> {
  return revListOutput
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function composeIntegration(sourceRoot = process.cwd(), push = true): string {
  const manifest = readManifest(sourceRoot);
  const originUrl = git(sourceRoot, ["remote", "get-url", "origin"]);
  const workDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "compose-overlays-"));
  const repoDir = NodePath.join(workDir, "repo");
  NodeFS.mkdirSync(repoDir);
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
      git(repoDir, ["cherry-pick", ...commits]);
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
