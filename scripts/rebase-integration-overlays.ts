#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalConsole:off
/**
 * Fast ship helper: force registered integration overlays onto current fork/changes.
 *
 * Used by Compose fork integration before compose so a merge to fork/changes does not
 * hard-fail with "overlay is not based on current fork/changes" when rebases are clean.
 *
 * Does not rewrite main / tim / candidates. Does not rebase ordinary feature PRs.
 */

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import {
  isSuccessfulFeatureRebaseSkip,
  readManifest,
  StackError,
  type StackManifest,
} from "./rebase-pr-stack.ts";

function run(
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
  options: { allowFailure?: boolean; env?: NodeJS.ProcessEnv } = {},
): { status: number | null; stdout: string; stderr: string } {
  const result = NodeChildProcess.spawnSync(command, [...args], {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_EDITOR: "true",
      GIT_SEQUENCE_EDITOR: "true",
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

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, "");
}

export interface OverlayRebasePlan {
  readonly number: number;
  readonly branch: string;
  readonly tip: string;
  readonly newBase: string;
  readonly oldBase: string | null;
  readonly action: "skip-already-based" | "rebase" | "error";
  readonly reason?: string;
}

/**
 * Decide how to advance one overlay tip onto the current fork/changes tip.
 * Pure helper for tests — no network.
 */
export function planOverlayRebase(input: {
  readonly number: number;
  readonly branch: string;
  readonly tip: string;
  readonly newBase: string;
  readonly isNewBaseAncestorOfTip: boolean;
  readonly mergeBaseWithNewBase: string | null;
}): OverlayRebasePlan {
  if (input.isNewBaseAncestorOfTip) {
    return {
      number: input.number,
      branch: input.branch,
      tip: input.tip,
      newBase: input.newBase,
      oldBase: null,
      action: "skip-already-based",
      reason: "already based on fork/changes",
    };
  }
  const oldBase = input.mergeBaseWithNewBase;
  if (!oldBase || oldBase === input.tip) {
    return {
      number: input.number,
      branch: input.branch,
      tip: input.tip,
      newBase: input.newBase,
      oldBase,
      action: "error",
      reason:
        "cannot recover rebase range (no merge-base with current fork/changes, or tip is not a descendant of any shared ancestor)",
    };
  }
  return {
    number: input.number,
    branch: input.branch,
    tip: input.tip,
    newBase: input.newBase,
    oldBase,
    action: "rebase",
  };
}

export interface OverlayRebaseResult {
  readonly updated: ReadonlyArray<{ number: number; branch: string; from: string; to: string }>;
  readonly skipped: ReadonlyArray<{ number: number; branch: string; reason: string }>;
  readonly conflicts: ReadonlyArray<{ number: number; branch: string; message: string }>;
}

function rebaseInProgress(repoDir: string): boolean {
  return (
    NodeFS.existsSync(NodePath.join(repoDir, ".git", "rebase-merge")) ||
    NodeFS.existsSync(NodePath.join(repoDir, ".git", "rebase-apply"))
  );
}

/**
 * Rebase every registered integration overlay onto current origin/fork/changes.
 * Force-with-lease pushes when `push` is true.
 */
export function rebaseIntegrationOverlays(
  sourceRoot = process.cwd(),
  options: { push?: boolean; manifest?: StackManifest } = {},
): OverlayRebaseResult {
  const push = options.push !== false;
  const root = NodePath.resolve(sourceRoot);
  const manifest = options.manifest ?? readManifest(root);
  const originUrl = git(root, ["remote", "get-url", "origin"]);
  const workDir = NodeFS.mkdtempSync(
    NodePath.join(NodeOS.tmpdir(), "rebase-integration-overlays-"),
  );
  const repoDir = NodePath.join(workDir, "repo");
  NodeFS.mkdirSync(repoDir);

  const updated: Array<{ number: number; branch: string; from: string; to: string }> = [];
  const skipped: Array<{ number: number; branch: string; reason: string }> = [];
  const conflicts: Array<{ number: number; branch: string; message: string }> = [];

  try {
    git(repoDir, ["init", "--quiet"]);
    git(repoDir, ["config", "user.name", "T3 Code PR Stack"]);
    git(repoDir, ["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"]);
    git(repoDir, ["config", "commit.gpgsign", "false"]);
    git(repoDir, ["remote", "add", "origin", originUrl]);

    const branches = [
      manifest.forkChangesBranch,
      ...manifest.integrationOverlays.map(({ branch }) => branch),
    ];
    git(repoDir, [
      "fetch",
      "--quiet",
      "--no-tags",
      "origin",
      ...branches.map((branch) => `+refs/heads/${branch}:refs/remotes/origin/${branch}`),
    ]);

    const newBase = git(repoDir, ["rev-parse", `origin/${manifest.forkChangesBranch}`]);
    console.log(
      `Rebase overlays onto ${manifest.forkChangesBranch} @ ${newBase.slice(0, 12)} (${manifest.integrationOverlays.length} registered)`,
    );

    for (const overlay of manifest.integrationOverlays) {
      const tip = git(repoDir, ["rev-parse", `origin/${overlay.branch}`], { allowFailure: true });
      if (!tip) {
        conflicts.push({
          number: overlay.number,
          branch: overlay.branch,
          message: "missing remote branch",
        });
        continue;
      }

      const isAncestor =
        run("git", ["merge-base", "--is-ancestor", newBase, tip], {
          cwd: repoDir,
          allowFailure: true,
        }).status === 0;
      const mergeBase = git(repoDir, ["merge-base", newBase, tip], { allowFailure: true }) || null;
      const plan = planOverlayRebase({
        number: overlay.number,
        branch: overlay.branch,
        tip,
        newBase,
        isNewBaseAncestorOfTip: isAncestor,
        mergeBaseWithNewBase: mergeBase,
      });

      if (plan.action === "skip-already-based") {
        console.log(`  #${overlay.number} ${overlay.branch}: already based (skip)`);
        skipped.push({
          number: overlay.number,
          branch: overlay.branch,
          reason: `already based on ${manifest.forkChangesBranch}`,
        });
        continue;
      }
      if (plan.action === "error" || !plan.oldBase) {
        console.error(`  #${overlay.number} ${overlay.branch}: ${plan.reason}`);
        conflicts.push({
          number: overlay.number,
          branch: overlay.branch,
          message: plan.reason ?? "cannot plan rebase",
        });
        continue;
      }

      console.log(
        `  #${overlay.number} ${overlay.branch}: rebase --onto ${newBase.slice(0, 12)} ${plan.oldBase.slice(0, 12)} (from ${tip.slice(0, 12)})`,
      );
      git(repoDir, ["checkout", "--quiet", "--detach", tip]);
      const rebaseResult = run(
        "git",
        ["-c", "commit.gpgsign=false", "rebase", "--onto", newBase, plan.oldBase],
        repoDir,
        { allowFailure: true },
      );
      if (rebaseResult.status !== 0) {
        if (rebaseInProgress(repoDir)) {
          run("git", ["rebase", "--abort"], repoDir, { allowFailure: true });
        }
        const conflictPaths = git(repoDir, ["diff", "--name-only", "--diff-filter=U"], {
          allowFailure: true,
        });
        const message = conflictPaths
          ? `conflict rebasing onto ${manifest.forkChangesBranch} from ${plan.oldBase.slice(0, 12)}: ${conflictPaths.split("\n").join(", ")}`
          : stripAnsi(rebaseResult.stderr || rebaseResult.stdout || "rebase --onto failed");
        console.error(`  #${overlay.number} ${overlay.branch}: ${message}`);
        conflicts.push({ number: overlay.number, branch: overlay.branch, message });
        continue;
      }

      const newTip = git(repoDir, ["rev-parse", "HEAD"]);
      if (newTip === tip) {
        skipped.push({
          number: overlay.number,
          branch: overlay.branch,
          reason: "rebase produced identical tip",
        });
        continue;
      }

      if (push) {
        const pushResult = run(
          "git",
          [
            "push",
            `--force-with-lease=refs/heads/${overlay.branch}:${tip}`,
            "origin",
            `${newTip}:refs/heads/${overlay.branch}`,
          ],
          repoDir,
          { allowFailure: true },
        );
        if (pushResult.status !== 0) {
          // Concurrent updater may have already landed a based tip.
          git(repoDir, [
            "fetch",
            "--quiet",
            "origin",
            `+refs/heads/${overlay.branch}:refs/remotes/origin/${overlay.branch}`,
          ]);
          const latest = git(repoDir, ["rev-parse", `origin/${overlay.branch}`], {
            allowFailure: true,
          });
          const alreadyBased =
            latest !== "" &&
            run("git", ["merge-base", "--is-ancestor", newBase, latest], {
              cwd: repoDir,
              allowFailure: true,
            }).status === 0;
          if (alreadyBased) {
            skipped.push({
              number: overlay.number,
              branch: overlay.branch,
              reason: `remote already based on ${manifest.forkChangesBranch} after concurrent update`,
            });
            continue;
          }
          conflicts.push({
            number: overlay.number,
            branch: overlay.branch,
            message: `push failed: ${stripAnsi(
              pushResult.stderr || pushResult.stdout || "force-with-lease rejected",
            )}`,
          });
          continue;
        }
      }

      console.log(
        `  #${overlay.number} ${overlay.branch}: updated ${tip.slice(0, 12)} → ${newTip.slice(0, 12)}${push ? " (pushed)" : ""}`,
      );
      updated.push({
        number: overlay.number,
        branch: overlay.branch,
        from: tip,
        to: newTip,
      });
    }

    return { updated, skipped, conflicts };
  } finally {
    try {
      NodeFS.rmSync(workDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

/**
 * Fail if any overlay could not be made based on fork/changes.
 * Successful skips (already based / identical tip / concurrent update) are OK.
 */
export function assertOverlaysReadyForCompose(
  result: OverlayRebaseResult,
  forkChangesBranch: string,
): void {
  const hardSkips = result.skipped.filter(
    (entry) => !isSuccessfulFeatureRebaseSkip(entry.reason, forkChangesBranch),
  );
  if (result.conflicts.length === 0 && hardSkips.length === 0) {
    return;
  }
  const details = [
    ...result.conflicts.map((entry) => `#${entry.number} (${entry.branch}): ${entry.message}`),
    ...hardSkips.map((entry) => `#${entry.number} (${entry.branch}): ${entry.reason}`),
  ].join("; ");
  throw new StackError(
    `Integration overlay auto-rebase incomplete (compose cannot proceed): ${details}`,
  );
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === NodeURL.pathToFileURL(NodePath.resolve(process.argv[1])).href;

if (isMain) {
  const push = !process.argv.includes("--dry-run");
  try {
    const manifest = readManifest(process.cwd());
    const result = rebaseIntegrationOverlays(process.cwd(), { push });
    console.log(
      `Overlays: updated=${result.updated.length} skipped=${result.skipped.length} conflicts=${result.conflicts.length}`,
    );
    assertOverlaysReadyForCompose(result, manifest.forkChangesBranch);
    if (!push) {
      console.log("Dry-run only (no push).");
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
