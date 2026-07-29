#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalFetch:off
// @effect-diagnostics globalConsole:off

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const EXPECTED_REPOSITORY = process.env.T3CODE_FORK_REPOSITORY ?? "patroza/t3code";
const STATE_FILE = "rebase-pr-stack-state.json";
const ZERO_SHA = "0000000000000000000000000000000000000000";

/**
 * Git ref (blob) listing historical `fork/changes` tips, newest first.
 * Written by the stack cascade so feature PRs can recover the exact base they
 * were built on after rewrites (`oldBase..head` is the PR's own commits).
 */
export const FORK_CHANGES_BASE_HISTORY_REF = "refs/t3/stack/base-history/fork-changes";
export const FORK_CHANGES_BASE_HISTORY_MAX = 100 as const;

export function parseBaseHistory(text: string): ReadonlyArray<string> {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[0-9a-f]{7,40}$/i.test(line));
}

export function appendBaseHistory(
  existingNewestFirst: ReadonlyArray<string>,
  tipsNewestFirst: ReadonlyArray<string>,
  max: number = FORK_CHANGES_BASE_HISTORY_MAX,
): ReadonlyArray<string> {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tip of [...tipsNewestFirst, ...existingNewestFirst]) {
    const key = tip.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tip);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Newest known historical base tip that is still an ancestor of `head`.
 * Feature commits are exactly `recoveredBase..head`.
 */
export function recoverOldBaseTip(input: {
  readonly historicalBaseTipsNewestFirst: ReadonlyArray<string>;
  readonly isAncestorOfHead: (tip: string) => boolean;
}): string | null {
  for (const tip of input.historicalBaseTipsNewestFirst) {
    if (input.isAncestorOfHead(tip)) return tip;
  }
  return null;
}

export interface StackPullRequest {
  readonly number: number;
  readonly branch: string;
}

/**
 * Automatic conflict resolution for protected stack rebases.
 *
 * - `commit` is a full 40-char SHA for a one-shot replay of that exact commit, or `"*"` to
 *   match any commit on `branch` for `path` (durable across layer rewrites).
 * - During `git rebase`, `ours` is the new base and `theirs` is the commit being replayed.
 */
export interface StackConflictResolution {
  readonly branch: string;
  /** Full 40-char SHA, or `"*"` for any commit on this branch+path. */
  readonly commit: string;
  readonly path: string;
  readonly strategy: "ours" | "theirs";
}

export interface StackManifest {
  readonly upstreamRemote: string;
  readonly upstreamBranch: string;
  readonly forkChangesBranch: string;
  readonly integrationBranch: string;
  readonly pullRequests: ReadonlyArray<StackPullRequest>;
  readonly integrationOverlays: ReadonlyArray<StackPullRequest>;
  readonly conflictResolutions?: ReadonlyArray<StackConflictResolution>;
}

export interface PullRequestSnapshot {
  readonly number: number;
  readonly state: string;
  readonly headBranch: string;
  readonly headOwner: string;
  readonly baseBranch: string;
  readonly isDraft: boolean;
}

interface RebaseOperation {
  readonly kind: "pull-request" | "integration";
  readonly index: number;
  readonly branch: string;
  readonly parentBranch: string;
  readonly pullRequestNumber?: number;
  readonly oldBase: string;
  readonly oldTip: string;
  readonly newBase: string;
  readonly commits: ReadonlyArray<string>;
}

interface PersistedState {
  readonly version: 1;
  readonly sourceRoot: string;
  readonly repoDir: string;
  readonly originUrl: string;
  readonly upstreamUrl: string;
  readonly manifest: StackManifest;
  readonly snapshots: Readonly<Record<string, string>>;
  readonly upstreamTip: string;
  readonly initialBaseForAll: boolean;
  readonly newTips: Readonly<Record<string, string>>;
  readonly nextIndex: number;
  readonly currentOperation?: RebaseOperation | undefined;
}

export interface StackRunOptions {
  readonly sourceRoot?: string;
  readonly manifestPath?: string;
  readonly push: boolean;
  readonly validatePullRequests?: boolean;
  readonly pullRequests?: ReadonlyArray<PullRequestSnapshot>;
  readonly preserveState?: boolean;
  readonly initialBaseForAll?: boolean;
  /**
   * After each replayed commit lands during a layer rebase, typecheck packages
   * touched by that commit. Fail the stack rewrite on the first red commit
   * instead of stacking `fix(stack)` tips later. Requires `node_modules` in the
   * rewrite worktree (install once before sync when enabling this).
   */
  readonly verifyEachCommit?: boolean;
  readonly beforePush?: (state: Readonly<PersistedState>) => void | Promise<void>;
}

/** Paths where whole-file ours/theirs is never a durable product-safe policy. */
const PRODUCT_CONFLICT_PATH_PREFIXES = [
  "apps/server/src/",
  "apps/web/src/",
  "apps/mobile/src/",
  "apps/desktop/src/",
  "apps/discord-bot/src/",
  "apps/vscode/src/",
  "packages/client-runtime/src/",
  "packages/contracts/src/",
  "packages/shared/src/",
] as const;

export function isProductConflictPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  return PRODUCT_CONFLICT_PATH_PREFIXES.some(
    (prefix) => normalized === prefix.slice(0, -1) || normalized.startsWith(prefix),
  );
}

/**
 * Map changed repo paths to pnpm filter names for commit-local typecheck.
 * Config/docs/workflow-only commits return an empty list (no package gate).
 */
export function packagesForChangedPaths(paths: ReadonlyArray<string>): ReadonlyArray<string> {
  const filters = new Set<string>();
  for (const raw of paths) {
    const path = raw.replaceAll("\\", "/");
    if (path.startsWith("packages/client-runtime/")) filters.add("@t3tools/client-runtime");
    else if (path.startsWith("packages/contracts/")) filters.add("@t3tools/contracts");
    else if (path.startsWith("packages/shared/")) filters.add("@t3tools/shared");
    else if (path.startsWith("packages/ssh/")) filters.add("@t3tools/ssh");
    else if (path.startsWith("packages/tailscale/")) filters.add("@t3tools/tailscale");
    else if (path.startsWith("packages/effect-acp/")) filters.add("effect-acp");
    else if (path.startsWith("packages/effect-codex-app-server/")) {
      filters.add("effect-codex-app-server");
    } else if (path.startsWith("apps/server/")) filters.add("t3");
    else if (path.startsWith("apps/web/")) filters.add("@t3tools/web");
    else if (path.startsWith("apps/mobile/")) filters.add("@t3tools/mobile");
    else if (path.startsWith("apps/desktop/")) filters.add("@t3tools/desktop");
    else if (path.startsWith("apps/discord-bot/")) filters.add("@t3tools/discord-bot");
    else if (path.startsWith("apps/vscode/")) filters.add("t3-code");
    else if (path.startsWith("apps/marketing/")) filters.add("@t3tools/marketing");
    else if (path.startsWith("scripts/")) filters.add("@t3tools/scripts");
    else if (path.startsWith("oxlint-plugin-t3code/")) filters.add("@t3tools/oxlint-plugin-t3code");
  }
  return [...filters].sort();
}

/**
 * Typecheck packages touched by `HEAD` vs its first parent. Used as
 * `git rebase --exec` and as the `verify-head` CLI entry.
 */
export function verifyReplayHead(
  repoDir: string,
  options?: { readonly stateDir?: string | undefined },
): void {
  const gitOpts = options?.stateDir === undefined ? {} : { stateDir: options.stateDir };
  const parent = run("git", ["rev-parse", "--verify", "HEAD^"], {
    cwd: repoDir,
    allowFailure: true,
    ...gitOpts,
  });
  if (parent.status !== 0) {
    console.log("verify-head: root commit; skipping package typecheck");
    return;
  }
  const diff = git(repoDir, ["diff", "--name-only", "HEAD^", "HEAD"], gitOpts);
  const paths = diff
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const packages = packagesForChangedPaths(paths);
  if (packages.length === 0) {
    console.log(
      `verify-head: ${git(repoDir, ["rev-parse", "--short", "HEAD"], gitOpts)} touches no package sources; ok`,
    );
    return;
  }
  if (!NodeFS.existsSync(NodePath.join(repoDir, "node_modules"))) {
    throw new StackError(
      "verify-each-commit requires node_modules in the rewrite worktree. " +
        "Run `CI= pnpm install --no-frozen-lockfile` in the worktree (or source tree with " +
        "linked modules) before `sync --verify-each-commit`.",
      options?.stateDir === undefined ? undefined : { stateDir: options.stateDir },
    );
  }
  const sha = git(repoDir, ["rev-parse", "--short", "HEAD"], gitOpts);
  const subject = git(repoDir, ["log", "-1", "--format=%s"], gitOpts);
  console.log(`verify-head: ${sha} ${subject} → ${packages.join(", ")}`);
  for (const pkg of packages) {
    const result = run("pnpm", ["--filter", pkg, "run", "typecheck"], {
      cwd: repoDir,
      allowFailure: true,
      env: { ELECTRON_SKIP_BINARY_DOWNLOAD: "1" },
      ...gitOpts,
    });
    if (result.status !== 0) {
      throw new StackError(
        `Commit ${sha} ("${subject}") failed typecheck for ${pkg}. ` +
          `Fix the replayed commit (or the conflict resolution that produced it); ` +
          `do not land a tip-only fix(stack) product patch.`,
        options?.stateDir === undefined ? undefined : { stateDir: options.stateDir },
      );
    }
  }
}

function thisScriptPath(): string {
  return NodeURL.fileURLToPath(import.meta.url);
}

export interface StackRunResult {
  readonly stateDir: string;
  readonly snapshots: Readonly<Record<string, string>>;
  readonly newTips: Readonly<Record<string, string>>;
  readonly upstreamTip: string;
  readonly pushed: boolean;
}

export class StackError extends Error {
  readonly stateDir: string | undefined;

  constructor(
    message: string,
    options?: { readonly stateDir?: string | undefined; readonly cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.stateDir = options?.stateDir;
  }
}

export class RebaseConflictError extends StackError {
  readonly pullRequestNumber: number | undefined;
  readonly branch: string;
  readonly parentBranch: string;
  readonly commit: string;
  readonly commitSubject: string;
  readonly conflictingPaths: ReadonlyArray<string>;

  constructor(
    operation: RebaseOperation,
    stateDir: string,
    commit: string,
    commitSubject: string,
    conflictingPaths: ReadonlyArray<string>,
  ) {
    const label =
      operation.pullRequestNumber === undefined
        ? `integration branch ${operation.branch}`
        : `PR #${operation.pullRequestNumber} (${operation.branch})`;
    super(
      `Rebase conflict in ${label} onto ${operation.parentBranch} while replaying ${commit}: ${conflictingPaths.join(", ")}`,
      { stateDir },
    );
    this.pullRequestNumber = operation.pullRequestNumber;
    this.branch = operation.branch;
    this.parentBranch = operation.parentBranch;
    this.commit = commit;
    this.commitSubject = commitSubject;
    this.conflictingPaths = conflictingPaths;
  }
}

class GitCommandError extends StackError {
  readonly args: ReadonlyArray<string>;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;

  constructor(
    args: ReadonlyArray<string>,
    cwd: string,
    result: NodeChildProcess.SpawnSyncReturns<string>,
    stateDir?: string,
  ) {
    const stderr = result.stderr.trim();
    super(`git ${args.join(" ")} failed in ${cwd}${stderr ? `: ${stderr}` : ""}`, { stateDir });
    this.args = args;
    this.stdout = result.stdout;
    this.stderr = result.stderr;
    this.exitCode = result.status ?? 1;
  }
}

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, "");
}

function run(
  executable: string,
  args: ReadonlyArray<string>,
  options: {
    readonly cwd: string;
    readonly allowFailure?: boolean;
    readonly env?: NodeJS.ProcessEnv;
    readonly stateDir?: string;
  },
): NodeChildProcess.SpawnSyncReturns<string> {
  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    // Keep FORCE_COLOR as-is when set; force "0" breaks some t3 gh-wrapper list queries.
    // Strip ANSI from stdout/stderr so callers can parse `gh --json`.
    ...options.env,
  };
  const result = NodeChildProcess.spawnSync(executable, [...args], {
    cwd: options.cwd,
    encoding: "utf8",
    env: baseEnv,
  });
  if (result.stdout) result.stdout = stripAnsi(result.stdout);
  if (result.stderr) result.stderr = stripAnsi(result.stderr);
  if (result.error) {
    throw new StackError(`Unable to run ${executable}: ${result.error.message}`, {
      stateDir: options.stateDir,
      cause: result.error,
    });
  }
  if (!options.allowFailure && result.status !== 0) {
    if (executable === "git") {
      throw new GitCommandError(args, options.cwd, result, options.stateDir);
    }
    throw new StackError(
      `${executable} ${args.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim()}`,
      { stateDir: options.stateDir },
    );
  }
  return result;
}

function git(
  cwd: string,
  args: ReadonlyArray<string>,
  options: {
    readonly allowFailure?: boolean;
    readonly env?: NodeJS.ProcessEnv;
    readonly stateDir?: string;
  } = {},
): string {
  return run("git", args, { cwd, ...options }).stdout.trim();
}

function assertObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new StackError(`${label} must be an object.`);
  }
}

export function parseManifest(source: string): StackManifest {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (cause) {
    throw new StackError("The PR stack manifest is not valid JSON.", { cause });
  }
  assertObject(value, "The PR stack manifest");
  const {
    upstreamRemote,
    upstreamBranch,
    forkChangesBranch,
    integrationBranch,
    pullRequests,
    integrationOverlays = [],
    conflictResolutions = [],
  } = value;
  if (
    typeof upstreamRemote !== "string" ||
    upstreamRemote.length === 0 ||
    typeof upstreamBranch !== "string" ||
    upstreamBranch.length === 0 ||
    typeof forkChangesBranch !== "string" ||
    forkChangesBranch.length === 0 ||
    typeof integrationBranch !== "string" ||
    integrationBranch.length === 0 ||
    !Array.isArray(pullRequests) ||
    !Array.isArray(integrationOverlays) ||
    !Array.isArray(conflictResolutions)
  ) {
    throw new StackError("The PR stack manifest has missing or invalid fields.");
  }

  const parsedPullRequests = pullRequests.map((entry, index) => {
    assertObject(entry, `pullRequests[${index}]`);
    if (
      !Number.isSafeInteger(entry.number) ||
      Number(entry.number) <= 0 ||
      typeof entry.branch !== "string" ||
      entry.branch.length === 0
    ) {
      throw new StackError(`pullRequests[${index}] has an invalid number or branch.`);
    }
    return { number: Number(entry.number), branch: entry.branch };
  });
  const parsedIntegrationOverlays = integrationOverlays.map((entry, index) => {
    assertObject(entry, `integrationOverlays[${index}]`);
    if (
      !Number.isSafeInteger(entry.number) ||
      Number(entry.number) <= 0 ||
      typeof entry.branch !== "string" ||
      entry.branch.length === 0
    ) {
      throw new StackError(`integrationOverlays[${index}] has an invalid number or branch.`);
    }
    return { number: Number(entry.number), branch: entry.branch };
  });
  const parsedConflictResolutions = conflictResolutions.map((entry, index) => {
    assertObject(entry, `conflictResolutions[${index}]`);
    const branch = entry.branch;
    const commitValue = entry.commit;
    const path = entry.path;
    const strategy = entry.strategy;
    const commitOk =
      typeof commitValue === "string" &&
      (commitValue === "*" || /^[0-9a-f]{40}$/i.test(commitValue));
    if (
      typeof branch !== "string" ||
      branch.length === 0 ||
      !commitOk ||
      typeof path !== "string" ||
      path.length === 0 ||
      NodePath.isAbsolute(path) ||
      path.split("/").includes("..") ||
      (strategy !== "ours" && strategy !== "theirs")
    ) {
      throw new StackError(
        `conflictResolutions[${index}] is invalid (need branch, commit SHA or "*", relative path, ours|theirs).`,
      );
    }
    // commitValue narrowed by commitOk (string + shape check).
    const commit = commitValue as string;
    return {
      branch,
      commit: commit === "*" ? "*" : commit.toLowerCase(),
      path,
      strategy: strategy as "ours" | "theirs",
    } satisfies StackConflictResolution;
  });

  const managed = [...parsedPullRequests, ...parsedIntegrationOverlays];
  const numbers = new Set(managed.map(({ number }) => number));
  const branches = new Set(managed.map(({ branch }) => branch));
  if (numbers.size !== managed.length || branches.size !== managed.length) {
    throw new StackError("The PR stack manifest contains duplicate PR numbers or branches.");
  }
  if (branches.has(integrationBranch)) {
    throw new StackError("The integration branch must not also be a PR branch.");
  }
  if (parsedPullRequests.at(-1) && parsedPullRequests.at(-1)?.branch !== forkChangesBranch) {
    throw new StackError(
      `The top PR branch must be the fork changes branch (${forkChangesBranch}).`,
    );
  }

  return {
    upstreamRemote,
    upstreamBranch,
    forkChangesBranch,
    integrationBranch,
    pullRequests: parsedPullRequests,
    integrationOverlays: parsedIntegrationOverlays,
    ...(parsedConflictResolutions.length > 0
      ? { conflictResolutions: parsedConflictResolutions }
      : {}),
  };
}

export function readManifest(
  sourceRoot: string,
  manifestPath = NodePath.join(sourceRoot, ".github", "pr-stack.json"),
): StackManifest {
  return parseManifest(NodeFS.readFileSync(manifestPath, "utf8"));
}

function expectedBase(manifest: StackManifest, index: number): string {
  return index === 0
    ? manifest.upstreamBranch
    : (manifest.pullRequests[index - 1]?.branch ?? manifest.upstreamBranch);
}

export function validatePullRequestSnapshots(
  manifest: StackManifest,
  pullRequests: ReadonlyArray<PullRequestSnapshot>,
): void {
  for (const [index, expected] of manifest.pullRequests.entries()) {
    const actual = pullRequests.find(({ number }) => number === expected.number);
    if (!actual || actual.state !== "open") {
      throw new StackError(`Manifest PR #${expected.number} is not open.`);
    }
    if (!actual.isDraft) {
      throw new StackError(`Managed PR #${expected.number} must remain a draft.`);
    }
    if (actual.headOwner !== EXPECTED_REPOSITORY.split("/")[0]) {
      throw new StackError(
        `PR #${expected.number} is owned by ${actual.headOwner}, expected ${EXPECTED_REPOSITORY.split("/")[0]}.`,
      );
    }
    if (actual.headBranch !== expected.branch) {
      throw new StackError(
        `PR #${expected.number} uses ${actual.headBranch}, expected ${expected.branch}.`,
      );
    }
    const base = expectedBase(manifest, index);
    if (actual.baseBranch !== base) {
      throw new StackError(
        `PR #${expected.number} is based on ${actual.baseBranch}, expected ${base}.`,
      );
    }
  }
  for (const expected of manifest.integrationOverlays) {
    const actual = pullRequests.find(({ number }) => number === expected.number);
    if (!actual || actual.state !== "open") {
      throw new StackError(`Integration overlay PR #${expected.number} is not open.`);
    }
    if (!actual.isDraft) {
      throw new StackError(`Integration overlay PR #${expected.number} must remain a draft.`);
    }
    if (actual.headOwner !== EXPECTED_REPOSITORY.split("/")[0]) {
      throw new StackError(`Integration overlay PR #${expected.number} is not owned by this fork.`);
    }
    if (actual.headBranch !== expected.branch) {
      throw new StackError(
        `Integration overlay PR #${expected.number} uses ${actual.headBranch}, expected ${expected.branch}.`,
      );
    }
    if (actual.baseBranch !== manifest.forkChangesBranch) {
      throw new StackError(
        `Integration overlay PR #${expected.number} is based on ${actual.baseBranch}, expected ${manifest.forkChangesBranch}.`,
      );
    }
  }
}

interface GitHubPullResponse {
  readonly number?: unknown;
  readonly state?: unknown;
  readonly head?: {
    readonly ref?: unknown;
    readonly user?: { readonly login?: unknown } | null;
    readonly repo?: { readonly full_name?: unknown } | null;
  } | null;
  readonly base?: { readonly ref?: unknown } | null;
  readonly draft?: unknown;
}

function githubToken(): string {
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (!token) {
    throw new StackError("GH_TOKEN or GITHUB_TOKEN is required to validate pull requests.");
  }
  return token;
}

async function githubRequest(path: string): Promise<unknown> {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${githubToken()}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "t3code-rebase-pr-stack",
    },
  });
  if (!response.ok) {
    throw new StackError(`GitHub API request ${path} failed with HTTP ${response.status}.`);
  }
  return response.json();
}

export async function fetchPullRequestSnapshots(
  manifest: StackManifest,
): Promise<ReadonlyArray<PullRequestSnapshot>> {
  const openResponses: Array<GitHubPullResponse> = [];
  for (let page = 1; ; page += 1) {
    const value = await githubRequest(
      `/repos/${EXPECTED_REPOSITORY}/pulls?state=open&per_page=100&page=${page}`,
    );
    if (!Array.isArray(value)) {
      throw new StackError("GitHub returned an invalid open pull request response.");
    }
    openResponses.push(...(value as Array<GitHubPullResponse>));
    if (value.length < 100) break;
  }

  const byNumber = new Map<number, GitHubPullResponse>();
  for (const response of openResponses) {
    if (typeof response.number === "number") byNumber.set(response.number, response);
  }
  for (const { number } of [...manifest.pullRequests, ...manifest.integrationOverlays]) {
    if (!byNumber.has(number)) {
      const value = await githubRequest(`/repos/${EXPECTED_REPOSITORY}/pulls/${number}`);
      assertObject(value, `GitHub PR #${number}`);
      byNumber.set(number, value as GitHubPullResponse);
    }
  }

  return [...byNumber.values()].map((response) => {
    const number = response.number;
    const state = response.state;
    const headBranch = response.head?.ref;
    const headOwner = response.head?.user?.login;
    const headRepository = response.head?.repo?.full_name;
    const baseBranch = response.base?.ref;
    const isDraft = response.draft;
    if (
      typeof number !== "number" ||
      typeof state !== "string" ||
      typeof headBranch !== "string" ||
      typeof headOwner !== "string" ||
      typeof baseBranch !== "string" ||
      typeof isDraft !== "boolean"
    ) {
      throw new StackError("GitHub returned an invalid pull request record.");
    }
    if (headRepository !== EXPECTED_REPOSITORY) {
      return {
        number,
        state,
        headBranch,
        headOwner: typeof headRepository === "string" ? headRepository : headOwner,
        baseBranch,
        isDraft,
      };
    }
    return { number, state, headBranch, headOwner, baseBranch, isDraft };
  });
}

async function fetchPullRequestHeadHistory(
  pullRequestNumber: number,
): Promise<ReadonlyArray<string>> {
  const tips: Array<string> = [];
  for (let page = 1; ; page += 1) {
    const value = await githubRequest(
      `/repos/${EXPECTED_REPOSITORY}/issues/${pullRequestNumber}/events?per_page=100&page=${page}`,
    );
    if (!Array.isArray(value)) {
      throw new StackError(`GitHub returned invalid events for PR #${pullRequestNumber}.`);
    }
    for (const event of value) {
      if (
        typeof event === "object" &&
        event !== null &&
        "event" in event &&
        event.event === "head_ref_force_pushed" &&
        "commit_id" in event &&
        typeof event.commit_id === "string"
      ) {
        tips.unshift(event.commit_id);
      }
    }
    if (value.length < 100) break;
  }
  return appendBaseHistory([], tips);
}

async function fetchBaseHistoryByBranch(
  openPulls: ReadonlyArray<{
    readonly number: number;
    readonly headBranch: string;
  }>,
  features: ReadonlyArray<OpenFeaturePullRequestTreeNode>,
): Promise<Readonly<Record<string, ReadonlyArray<string>>>> {
  const pullByBranch = new Map(openPulls.map((pull) => [pull.headBranch, pull]));
  const baseBranches = new Set(
    features.filter(({ depth }) => depth > 0).map(({ baseBranch }) => baseBranch),
  );
  const entries = await Promise.all(
    [...baseBranches].map(async (branch) => {
      const pull = pullByBranch.get(branch);
      return [
        branch,
        pull === undefined ? [] : await fetchPullRequestHeadHistory(pull.number),
      ] as const;
    }),
  );
  return Object.fromEntries(entries);
}

async function validatePullRequests(
  manifest: StackManifest,
  supplied?: ReadonlyArray<PullRequestSnapshot>,
): Promise<void> {
  validatePullRequestSnapshots(manifest, supplied ?? (await fetchPullRequestSnapshots(manifest)));
}

function resolveRemoteUrl(sourceRoot: string, remote: string): string {
  const url = git(sourceRoot, ["remote", "get-url", remote]);
  if (!url) throw new StackError(`Remote ${remote} has no URL.`);
  return url;
}

function writeState(stateDir: string, state: PersistedState): void {
  NodeFS.writeFileSync(
    NodePath.join(stateDir, STATE_FILE),
    `${JSON.stringify(state, undefined, 2)}\n`,
    "utf8",
  );
}

function readState(stateDir: string): PersistedState {
  const statePath = NodePath.join(stateDir, STATE_FILE);
  let value: unknown;
  try {
    value = JSON.parse(NodeFS.readFileSync(statePath, "utf8"));
  } catch (cause) {
    throw new StackError(`Unable to read rebase state from ${statePath}.`, {
      stateDir,
      cause,
    });
  }
  assertObject(value, "Rebase state");
  if (
    value.version !== 1 ||
    typeof value.sourceRoot !== "string" ||
    typeof value.repoDir !== "string" ||
    typeof value.originUrl !== "string" ||
    typeof value.upstreamUrl !== "string" ||
    typeof value.upstreamTip !== "string" ||
    typeof value.nextIndex !== "number"
  ) {
    throw new StackError(`Invalid rebase state in ${statePath}.`, { stateDir });
  }
  return value as unknown as PersistedState;
}

function updateState(
  stateDir: string,
  state: PersistedState,
  patch: Partial<PersistedState>,
): PersistedState {
  const updated = { ...state, ...patch };
  writeState(stateDir, updated);
  return updated;
}

function initializeState(
  sourceRoot: string,
  manifest: StackManifest,
  initialBaseForAll: boolean,
): { readonly stateDir: string; readonly state: PersistedState } {
  const stateDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "rebase-pr-stack-"));
  const repoDir = NodePath.join(stateDir, "repo");
  NodeFS.mkdirSync(repoDir);
  const originUrl = resolveRemoteUrl(sourceRoot, "origin");
  const upstreamUrl = resolveRemoteUrl(sourceRoot, manifest.upstreamRemote);

  try {
    git(repoDir, ["init", "--quiet"], { stateDir });
    git(repoDir, ["config", "user.name", "T3 Code PR Stack"], { stateDir });
    git(
      repoDir,
      ["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"],
      {
        stateDir,
      },
    );
    git(repoDir, ["config", "commit.gpgsign", "false"], { stateDir });
    git(repoDir, ["remote", "add", "origin", originUrl], { stateDir });
    git(repoDir, ["remote", "add", manifest.upstreamRemote, upstreamUrl], { stateDir });

    const originBranches = [
      manifest.upstreamBranch,
      ...manifest.pullRequests.map(({ branch }) => branch),
      manifest.integrationBranch,
    ];
    git(
      repoDir,
      [
        "fetch",
        "--quiet",
        "--no-tags",
        "origin",
        ...originBranches.map((branch) => `+refs/heads/${branch}:refs/remotes/origin/${branch}`),
      ],
      { stateDir },
    );
    git(
      repoDir,
      [
        "fetch",
        "--quiet",
        "--no-tags",
        manifest.upstreamRemote,
        `+refs/heads/${manifest.upstreamBranch}:refs/remotes/${manifest.upstreamRemote}/${manifest.upstreamBranch}`,
      ],
      { stateDir },
    );

    const snapshots = Object.fromEntries(
      originBranches.map((branch) => [
        branch,
        git(repoDir, ["rev-parse", `refs/remotes/origin/${branch}`], { stateDir }),
      ]),
    );
    const upstreamTip = git(
      repoDir,
      ["rev-parse", `refs/remotes/${manifest.upstreamRemote}/${manifest.upstreamBranch}`],
      { stateDir },
    );
    const originMain = snapshots[manifest.upstreamBranch];
    if (!originMain) throw new StackError("The origin main snapshot is missing.", { stateDir });
    const ancestorStatus = run("git", ["merge-base", "--is-ancestor", originMain, upstreamTip], {
      cwd: repoDir,
      allowFailure: true,
      stateDir,
    }).status;
    if (ancestorStatus !== 0) {
      throw new StackError(
        `origin/${manifest.upstreamBranch} (${originMain}) has diverged from ${manifest.upstreamRemote}/${manifest.upstreamBranch} (${upstreamTip}); refusing to update fork main.`,
        { stateDir },
      );
    }

    const state: PersistedState = {
      version: 1,
      sourceRoot,
      repoDir,
      originUrl,
      upstreamUrl,
      manifest,
      snapshots,
      upstreamTip,
      initialBaseForAll,
      newTips: {},
      nextIndex: 0,
    };
    writeState(stateDir, state);
    return { stateDir, state };
  } catch (error) {
    if (error instanceof StackError && error.stateDir) throw error;
    throw new StackError(error instanceof Error ? error.message : String(error), {
      stateDir,
      cause: error,
    });
  }
}

function revList(repoDir: string, range: string, stateDir: string): ReadonlyArray<string> {
  const output = git(repoDir, ["rev-list", "--reverse", range], { stateDir });
  return output ? output.split("\n") : [];
}

function makeOperation(state: PersistedState): RebaseOperation | undefined {
  const { manifest, snapshots, newTips, nextIndex, initialBaseForAll } = state;
  if (nextIndex < manifest.pullRequests.length) {
    const pullRequest = manifest.pullRequests[nextIndex];
    if (!pullRequest) return undefined;
    const parentBranch = expectedBase(manifest, nextIndex);
    const oldTip = snapshots[pullRequest.branch];
    const desiredOldBase =
      snapshots[nextIndex === 0 || initialBaseForAll ? manifest.upstreamBranch : parentBranch];
    const newBase = nextIndex === 0 ? state.upstreamTip : newTips[parentBranch];
    if (!desiredOldBase || !oldTip || !newBase) {
      throw new StackError(`Missing snapshot while preparing PR #${pullRequest.number}.`);
    }
    // A newly inserted middle layer is not yet an ancestor of its old child,
    // and an updated parent may have moved after its child was last rebased.
    // Replay from their actual common ancestor instead of assuming the desired
    // parent tip was already present in the child.
    const oldBase =
      nextIndex === 0 || initialBaseForAll
        ? desiredOldBase
        : git(state.repoDir, ["merge-base", desiredOldBase, oldTip], {
            stateDir: NodePath.dirname(state.repoDir),
          });
    return {
      kind: "pull-request",
      index: nextIndex,
      branch: pullRequest.branch,
      parentBranch,
      pullRequestNumber: pullRequest.number,
      oldBase,
      oldTip,
      newBase,
      commits: revList(state.repoDir, `${oldBase}..${oldTip}`, NodePath.dirname(state.repoDir)),
    };
  }
  if (nextIndex === manifest.pullRequests.length) {
    const top = manifest.pullRequests.at(-1);
    if (!top) return undefined;
    const desiredOldBase = snapshots[top.branch];
    const oldTip = snapshots[manifest.integrationBranch];
    const newBase = newTips[top.branch];
    if (!desiredOldBase || !oldTip || !newBase) {
      throw new StackError("Missing snapshot while preparing the integration branch.");
    }
    const oldBase = git(state.repoDir, ["merge-base", desiredOldBase, oldTip], {
      stateDir: NodePath.dirname(state.repoDir),
    });
    return {
      kind: "integration",
      index: nextIndex,
      branch: manifest.integrationBranch,
      parentBranch: top.branch,
      oldBase,
      oldTip,
      newBase,
      commits: revList(state.repoDir, `${oldBase}..${oldTip}`, NodePath.dirname(state.repoDir)),
    };
  }
  return undefined;
}

function rebaseInProgress(repoDir: string): boolean {
  const gitDir = git(repoDir, ["rev-parse", "--git-dir"]);
  const absoluteGitDir = NodePath.resolve(repoDir, gitDir);
  return (
    NodeFS.existsSync(NodePath.join(absoluteGitDir, "rebase-merge")) ||
    NodeFS.existsSync(NodePath.join(absoluteGitDir, "rebase-apply"))
  );
}

function conflictError(
  stateDir: string,
  state: PersistedState,
  operation: RebaseOperation,
): RebaseConflictError {
  const conflictsOutput = git(state.repoDir, ["diff", "--name-only", "--diff-filter=U"], {
    stateDir,
  });
  const conflictingPaths = conflictsOutput ? conflictsOutput.split("\n") : [];
  const commit =
    git(state.repoDir, ["rev-parse", "--verify", "REBASE_HEAD"], {
      allowFailure: true,
      stateDir,
    }) ||
    operation.commits[0] ||
    ZERO_SHA;
  const commitSubject =
    commit === ZERO_SHA
      ? "unknown commit"
      : git(state.repoDir, ["show", "-s", "--format=%s", commit], {
          allowFailure: true,
          stateDir,
        });
  const subject = commitSubject || "unknown commit";
  if (conflictingPaths.length > 0) {
    console.error(conflictResolutionManifestSnippet(operation.branch, commit, conflictingPaths));
  }
  return new RebaseConflictError(operation, stateDir, commit, subject, conflictingPaths);
}

function matchConflictResolution(
  configured: ReadonlyArray<StackConflictResolution>,
  branch: string,
  commit: string,
  path: string,
): StackConflictResolution | undefined {
  const exact = configured.find(
    (entry) =>
      entry.branch === branch &&
      entry.commit !== "*" &&
      entry.commit === commit &&
      entry.path === path,
  );
  if (exact) return exact;
  return configured.find(
    (entry) => entry.branch === branch && entry.commit === "*" && entry.path === path,
  );
}

function applyConfiguredConflictResolutions(
  stateDir: string,
  state: PersistedState,
  operation: RebaseOperation,
): boolean {
  const conflictingPaths = git(state.repoDir, ["diff", "--name-only", "--diff-filter=U"], {
    stateDir,
  })
    .split("\n")
    .filter(Boolean);
  const commit = git(state.repoDir, ["rev-parse", "--verify", "REBASE_HEAD"], {
    stateDir,
  }).toLowerCase();
  const configured = state.manifest.conflictResolutions ?? [];
  const resolutions = conflictingPaths.map((path) =>
    matchConflictResolution(configured, operation.branch, commit, path),
  );
  if (resolutions.some((entry) => entry === undefined)) {
    return false;
  }

  for (const resolution of resolutions) {
    if (!resolution) continue;
    if (isProductConflictPath(resolution.path)) {
      console.warn(
        `WARNING: whole-file ${resolution.strategy} on product path ${resolution.path} ` +
          `(${operation.branch}). Prefer a 3-way merge; durable * policies on shared app/package ` +
          `sources cause silent feature loss and tip-only fix(stack) patches.`,
      );
    }
    git(state.repoDir, ["checkout", `--${resolution.strategy}`, "--", resolution.path], {
      stateDir,
    });
    git(state.repoDir, ["add", "--", resolution.path], { stateDir });
    const scope = resolution.commit === "*" ? "any-commit" : commit.slice(0, 12);
    console.log(
      `Applied configured ${resolution.strategy} resolution for ${operation.branch} ${scope} ${resolution.path}`,
    );
  }
  return true;
}

function finishOperation(
  stateDir: string,
  state: PersistedState,
  operation: RebaseOperation,
): PersistedState {
  const tip = git(state.repoDir, ["rev-parse", "HEAD"], { stateDir });
  return updateState(stateDir, state, {
    newTips: { ...state.newTips, [operation.branch]: tip },
    nextIndex: operation.index + 1,
    currentOperation: undefined,
  });
}

function startOperation(
  stateDir: string,
  state: PersistedState,
  operation: RebaseOperation,
  options?: { readonly verifyEachCommit?: boolean },
): PersistedState {
  let updated = updateState(stateDir, state, { currentOperation: operation });
  if (operation.commits.length === 0) {
    git(updated.repoDir, ["checkout", "--quiet", "--detach", operation.newBase], { stateDir });
    return finishOperation(stateDir, updated, operation);
  }
  if (operation.oldBase === operation.newBase) {
    git(updated.repoDir, ["checkout", "--quiet", "--detach", operation.oldTip], { stateDir });
    if (options?.verifyEachCommit === true) {
      // No rewrite, but still gate the layer tip when verifying a full stack run.
      verifyReplayHead(updated.repoDir, { stateDir });
    }
    return finishOperation(stateDir, updated, operation);
  }
  git(updated.repoDir, ["checkout", "--quiet", "--detach", operation.oldTip], { stateDir });
  const rebaseArgs = [
    "-c",
    "commit.gpgsign=false",
    "rebase",
    "--onto",
    operation.newBase,
    operation.oldBase,
    operation.oldTip,
  ];
  if (options?.verifyEachCommit === true) {
    // Run after each successfully replayed commit (including post-conflict continues).
    rebaseArgs.push("--exec", `node ${JSON.stringify(thisScriptPath())} verify-head`);
  }
  let result = run("git", rebaseArgs, {
    cwd: updated.repoDir,
    allowFailure: true,
    env: { GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true" },
    stateDir,
  });
  while (result.status !== 0 && rebaseInProgress(updated.repoDir)) {
    if (!applyConfiguredConflictResolutions(stateDir, updated, operation)) {
      throw conflictError(stateDir, updated, operation);
    }
    result = run("git", ["-c", "commit.gpgsign=false", "rebase", "--continue"], {
      cwd: updated.repoDir,
      allowFailure: true,
      env: { GIT_EDITOR: "true" },
      stateDir,
    });
  }
  if (result.status !== 0) {
    throw new GitCommandError(
      ["rebase", "--onto", operation.newBase, operation.oldBase, operation.oldTip],
      updated.repoDir,
      result,
      stateDir,
    );
  }
  updated = finishOperation(stateDir, updated, operation);
  return updated;
}

function continueOperations(
  stateDir: string,
  initialState: PersistedState,
  options?: { readonly verifyEachCommit?: boolean },
): PersistedState {
  let state = initialState;
  for (;;) {
    const operation = makeOperation(state);
    if (!operation) return state;
    state = startOperation(stateDir, state, operation, options);
  }
}

function validateAncestry(
  repoDir: string,
  parent: string,
  child: string,
  message: string,
  stateDir: string,
): void {
  const result = run("git", ["merge-base", "--is-ancestor", parent, child], {
    cwd: repoDir,
    allowFailure: true,
    stateDir,
  });
  if (result.status !== 0) throw new StackError(message, { stateDir });
}

function validateResult(stateDir: string, state: PersistedState): void {
  let parent = state.upstreamTip;
  for (const pullRequest of state.manifest.pullRequests) {
    const child = state.newTips[pullRequest.branch];
    if (!child)
      throw new StackError(`No rewritten tip exists for PR #${pullRequest.number}.`, { stateDir });
    validateAncestry(
      state.repoDir,
      parent,
      child,
      `PR #${pullRequest.number} does not contain its rewritten parent.`,
      stateDir,
    );
    const count = Number(
      git(state.repoDir, ["rev-list", "--count", `${parent}..${child}`], { stateDir }),
    );
    if (count < 1) {
      throw new StackError(
        `PR #${pullRequest.number} became empty after rebasing; its commits may already have landed upstream.`,
        { stateDir },
      );
    }
    const mergeCount = Number(
      git(state.repoDir, ["rev-list", "--count", "--merges", `${parent}..${child}`], { stateDir }),
    );
    if (mergeCount > 0) {
      throw new StackError(`PR #${pullRequest.number} contains a merge commit after rebasing.`, {
        stateDir,
      });
    }
    parent = child;
  }
  const integrationTip = state.newTips[state.manifest.integrationBranch];
  if (!integrationTip) throw new StackError("No rewritten integration tip exists.", { stateDir });
  validateAncestry(
    state.repoDir,
    parent,
    integrationTip,
    "The integration branch does not contain the rewritten top PR.",
    stateDir,
  );
}

function pushResult(stateDir: string, state: PersistedState): void {
  const branches = [
    state.manifest.upstreamBranch,
    ...state.manifest.pullRequests.map(({ branch }) => branch),
    state.manifest.integrationBranch,
  ];
  const tips: Record<string, string> = {
    ...state.newTips,
    [state.manifest.upstreamBranch]: state.upstreamTip,
  };
  const args = ["push", "--atomic", "origin"];
  for (const branch of branches) {
    const oldSha = state.snapshots[branch];
    if (!oldSha) throw new StackError(`No lease snapshot exists for ${branch}.`, { stateDir });
    args.push(`--force-with-lease=refs/heads/${branch}:${oldSha}`);
  }
  for (const branch of branches) {
    const tip = tips[branch];
    if (!tip) throw new StackError(`No push tip exists for ${branch}.`, { stateDir });
    args.push(`${tip}:refs/heads/${branch}`);
  }
  git(state.repoDir, args, { stateDir });
}

function cleanupState(stateDir: string): void {
  NodeFS.rmSync(stateDir, { recursive: true, force: true });
}

async function finishRun(
  stateDir: string,
  state: PersistedState,
  options: Pick<StackRunOptions, "push" | "preserveState" | "beforePush">,
): Promise<StackRunResult> {
  validateResult(stateDir, state);
  if (options.push) {
    await options.beforePush?.(state);
    pushResult(stateDir, state);
  }
  const result: StackRunResult = {
    stateDir,
    snapshots: state.snapshots,
    newTips: state.newTips,
    upstreamTip: state.upstreamTip,
    pushed: options.push,
  };
  if (!options.preserveState) cleanupState(stateDir);
  return result;
}

/**
 * Open PRs that should ride along when `fork/changes` is rewritten.
 * Excludes stack provenance branches (tim/candidates/changes) and other-repo heads.
 * Registered integration overlays are ordered first so a later ordinary-feature
 * push failure cannot block the compose step that depends on them.
 */
export function selectOpenFeaturePullRequests(input: {
  readonly openPulls: ReadonlyArray<{
    readonly number: number;
    readonly headBranch: string;
    readonly baseBranch: string;
    readonly headRepository?: string | null;
    readonly draft?: boolean;
  }>;
  readonly manifest: StackManifest;
  readonly expectedRepository: string;
}): ReadonlyArray<{ readonly number: number; readonly branch: string }> {
  return selectOpenFeaturePullRequestTree(input).map(({ number, branch }) => ({
    number,
    branch,
  }));
}

export interface OpenFeaturePullRequestTreeNode {
  readonly number: number;
  readonly branch: string;
  readonly baseBranch: string;
  readonly depth: number;
}

/**
 * Select the complete same-repository PR tree rooted at `fork/changes`.
 * Parents always precede children so rewritten heads can cascade through
 * overlay children and deeper dependent PRs.
 */
export function selectOpenFeaturePullRequestTree(input: {
  readonly openPulls: ReadonlyArray<{
    readonly number: number;
    readonly headBranch: string;
    readonly baseBranch: string;
    readonly headRepository?: string | null;
    readonly draft?: boolean;
  }>;
  readonly manifest: StackManifest;
  readonly expectedRepository: string;
}): ReadonlyArray<OpenFeaturePullRequestTreeNode> {
  const stackBranches = new Set([
    input.manifest.upstreamBranch,
    input.manifest.integrationBranch,
    ...input.manifest.pullRequests.map(({ branch }) => branch),
  ]);
  const overlayBranches = new Set(input.manifest.integrationOverlays.map(({ branch }) => branch));
  const eligible = input.openPulls.filter((pull) => {
    if (stackBranches.has(pull.headBranch)) return false;
    if (
      pull.headRepository !== undefined &&
      pull.headRepository !== null &&
      pull.headRepository !== input.expectedRepository
    ) {
      return false;
    }
    return true;
  });
  const byBase = new Map<string, Array<(typeof eligible)[number]>>();
  for (const pull of eligible) {
    const children = byBase.get(pull.baseBranch) ?? [];
    children.push(pull);
    byBase.set(pull.baseBranch, children);
  }
  const roots = byBase.get(input.manifest.forkChangesBranch) ?? [];
  const overlays = roots.filter((entry) => overlayBranches.has(entry.headBranch));
  const features = roots.filter((entry) => !overlayBranches.has(entry.headBranch));
  // Preserve manifest overlay order for deterministic composition inputs.
  overlays.sort((left, right) => {
    const leftIndex = input.manifest.integrationOverlays.findIndex(
      (overlay) => overlay.branch === left.headBranch,
    );
    const rightIndex = input.manifest.integrationOverlays.findIndex(
      (overlay) => overlay.branch === right.headBranch,
    );
    return leftIndex - rightIndex;
  });
  const selected: Array<OpenFeaturePullRequestTreeNode> = [];
  const visit = (pull: (typeof eligible)[number], depth: number): void => {
    selected.push({
      number: pull.number,
      branch: pull.headBranch,
      baseBranch: pull.baseBranch,
      depth,
    });
    const children = byBase.get(pull.headBranch) ?? [];
    for (const child of children) visit(child, depth + 1);
  };
  for (const root of [...overlays, ...features]) visit(root, 0);
  return selected;
}

export interface FeaturePullRequestRebaseResult {
  readonly updated: ReadonlyArray<{ readonly number: number; readonly branch: string }>;
  readonly conflicts: ReadonlyArray<{
    readonly number: number;
    readonly branch: string;
    readonly message: string;
  }>;
  readonly skipped: ReadonlyArray<{
    readonly number: number;
    readonly branch: string;
    readonly reason: string;
  }>;
}

/**
 * After `fork/changes` is rewritten, rebase every open feature PR that targets it
 * (including registered integration overlays). Uses `git rebase --onto newBase oldBase`
 * and force-with-lease pushes.
 *
 * Per-PR isolation: a conflict or stale lease on one branch is recorded and the
 * loop continues. That is required so a racing ordinary feature push cannot
 * strand integration overlays and fail the subsequent compose step.
 */
export async function rebaseOpenFeaturePullRequests(options: {
  readonly sourceRoot?: string;
  readonly manifest?: StackManifest;
  readonly push: boolean;
  readonly oldForkChangesTip: string;
  readonly newForkChangesTip: string;
  readonly openPulls?: ReadonlyArray<{
    readonly number: number;
    readonly headBranch: string;
    readonly baseBranch: string;
    readonly headRepository?: string | null;
  }>;
  readonly baseHistoryByBranch?: Readonly<Record<string, ReadonlyArray<string>>>;
}): Promise<FeaturePullRequestRebaseResult> {
  const sourceRoot = NodePath.resolve(options.sourceRoot ?? process.cwd());
  const manifest = options.manifest ?? readManifest(sourceRoot);
  const openPulls =
    options.openPulls ??
    (await fetchPullRequestSnapshots(manifest)).map((snapshot) => ({
      number: snapshot.number,
      headBranch: snapshot.headBranch,
      baseBranch: snapshot.baseBranch,
      headRepository: snapshot.headOwner.includes("/")
        ? snapshot.headOwner
        : `${snapshot.headOwner}/${EXPECTED_REPOSITORY.split("/")[1] ?? "t3code"}`,
    }));

  const features = selectOpenFeaturePullRequestTree({
    openPulls,
    manifest,
    expectedRepository: EXPECTED_REPOSITORY,
  });
  const baseHistoryByBranch =
    options.baseHistoryByBranch ??
    (options.openPulls === undefined ? await fetchBaseHistoryByBranch(openPulls, features) : {});

  const updated: Array<{ number: number; branch: string }> = [];
  const conflicts: Array<{ number: number; branch: string; message: string }> = [];
  const skipped: Array<{ number: number; branch: string; reason: string }> = [];

  if (features.length === 0) {
    return { updated, conflicts, skipped };
  }

  const workDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "rebase-feature-prs-"));
  const repoDir = NodePath.join(workDir, "repo");
  NodeFS.mkdirSync(repoDir, { recursive: true });
  const originUrl = resolveRemoteUrl(sourceRoot, "origin");
  git(repoDir, ["init", "--quiet"]);
  git(repoDir, ["config", "user.name", "T3 Code PR Stack"]);
  git(repoDir, ["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"]);
  git(repoDir, ["config", "commit.gpgsign", "false"]);
  git(repoDir, ["remote", "add", "origin", originUrl]);

  const branchesToFetch = [
    manifest.forkChangesBranch,
    ...new Set(features.flatMap(({ branch, baseBranch }) => [baseBranch, branch])),
  ];
  git(repoDir, [
    "fetch",
    "--quiet",
    "--no-tags",
    "origin",
    ...branchesToFetch.map((branch) => `+refs/heads/${branch}:refs/remotes/origin/${branch}`),
  ]);
  // Historical fork/changes tips for multi-generation recovery.
  run(
    "git",
    [
      "fetch",
      "--quiet",
      "origin",
      `${FORK_CHANGES_BASE_HISTORY_REF}:${FORK_CHANGES_BASE_HISTORY_REF}`,
    ],
    { cwd: repoDir, allowFailure: true },
  );
  const historyBlob = git(repoDir, ["show", FORK_CHANGES_BASE_HISTORY_REF], {
    allowFailure: true,
  });
  const baseHistoryTips = historyBlob ? parseBaseHistory(historyBlob) : [];

  // Prefer the post-sync origin tip; fall back to the in-memory rewritten tip if present.
  const fetchedForkTip = git(repoDir, [
    "rev-parse",
    `refs/remotes/origin/${manifest.forkChangesBranch}`,
  ]);
  const forkChangesBase =
    fetchedForkTip === options.newForkChangesTip ||
    run("git", ["cat-file", "-e", `${options.newForkChangesTip}^{commit}`], {
      cwd: repoDir,
      allowFailure: true,
    }).status !== 0
      ? fetchedForkTip
      : options.newForkChangesTip;

  const initialRemoteTips = new Map(
    branchesToFetch.map((branch) => [
      branch,
      git(repoDir, ["rev-parse", `refs/remotes/origin/${branch}`], { allowFailure: true }),
    ]),
  );
  const rewrittenTips = new Map<string, string>([[manifest.forkChangesBranch, forkChangesBase]]);
  const blockedBranches = new Set<string>();

  for (const feature of features) {
    try {
      if (blockedBranches.has(feature.baseBranch)) {
        skipped.push({
          number: feature.number,
          branch: feature.branch,
          reason: `parent branch ${feature.baseBranch} was not rebased`,
        });
        blockedBranches.add(feature.branch);
        continue;
      }
      const remoteTip = git(repoDir, ["rev-parse", `refs/remotes/origin/${feature.branch}`], {
        allowFailure: true,
      });
      if (!remoteTip) {
        skipped.push({
          number: feature.number,
          branch: feature.branch,
          reason: "missing remote branch",
        });
        blockedBranches.add(feature.branch);
        continue;
      }

      const newBase =
        rewrittenTips.get(feature.baseBranch) ?? initialRemoteTips.get(feature.baseBranch) ?? "";
      if (!newBase) {
        skipped.push({
          number: feature.number,
          branch: feature.branch,
          reason: `missing base branch ${feature.baseBranch}`,
        });
        blockedBranches.add(feature.branch);
        continue;
      }
      const hasNewBase = run("git", ["merge-base", "--is-ancestor", newBase, remoteTip], {
        cwd: repoDir,
        allowFailure: true,
      });
      if (hasNewBase.status === 0) {
        skipped.push({
          number: feature.number,
          branch: feature.branch,
          reason: `already based on ${feature.baseBranch}`,
        });
        rewrittenTips.set(feature.branch, remoteTip);
        continue;
      }

      // Recover the old tip of this PR's direct parent. For roots this is a
      // historical fork/changes tip. Descendants first try the parent's
      // pre-cascade remote tip, then recorded force-push history.
      const historicalTips =
        feature.baseBranch === manifest.forkChangesBranch
          ? appendBaseHistory(baseHistoryTips, [options.oldForkChangesTip, forkChangesBase])
          : appendBaseHistory(baseHistoryByBranch[feature.baseBranch] ?? [], [
              initialRemoteTips.get(feature.baseBranch) ?? "",
            ]);
      const recoveredOldBase = recoverOldBaseTip({
        historicalBaseTipsNewestFirst: historicalTips.filter(
          (tip) => tip.toLowerCase() !== newBase.toLowerCase(),
        ),
        isAncestorOfHead: (tip) =>
          run("git", ["merge-base", "--is-ancestor", tip, remoteTip], {
            cwd: repoDir,
            allowFailure: true,
          }).status === 0,
      });

      if (recoveredOldBase === null) {
        skipped.push({
          number: feature.number,
          branch: feature.branch,
          reason: `cannot recover old ${feature.baseBranch} tip (no known historical base tip is an ancestor of this head)`,
        });
        blockedBranches.add(feature.branch);
        continue;
      }

      git(repoDir, ["checkout", "--quiet", "--detach", remoteTip]);
      const rebaseResult = run(
        "git",
        ["-c", "commit.gpgsign=false", "rebase", "--onto", newBase, recoveredOldBase],
        {
          cwd: repoDir,
          allowFailure: true,
          env: { GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true" },
        },
      );
      if (rebaseResult.status !== 0) {
        if (rebaseInProgress(repoDir)) {
          run("git", ["rebase", "--abort"], { cwd: repoDir, allowFailure: true });
        }
        const conflictPaths = git(repoDir, ["diff", "--name-only", "--diff-filter=U"], {
          allowFailure: true,
        });
        conflicts.push({
          number: feature.number,
          branch: feature.branch,
          message: conflictPaths
            ? `conflict rebasing onto new base from ${recoveredOldBase.slice(0, 12)}: ${conflictPaths.split("\n").join(", ")}`
            : stripAnsi(rebaseResult.stderr || rebaseResult.stdout || "rebase --onto failed"),
        });
        blockedBranches.add(feature.branch);
        continue;
      }

      const newTip = git(repoDir, ["rev-parse", "HEAD"]);
      if (newTip === remoteTip) {
        skipped.push({
          number: feature.number,
          branch: feature.branch,
          reason: "rebase produced identical tip",
        });
        rewrittenTips.set(feature.branch, remoteTip);
        continue;
      }

      if (options.push) {
        const pushResult = run(
          "git",
          [
            "push",
            `--force-with-lease=refs/heads/${feature.branch}:${remoteTip}`,
            "origin",
            `${newTip}:refs/heads/${feature.branch}`,
          ],
          { cwd: repoDir, allowFailure: true },
        );
        if (pushResult.status !== 0) {
          // Concurrent automation may have already rebased this branch onto the
          // new base; re-fetch and treat that as success-equivalent rather than
          // aborting remaining PRs (especially registered overlays).
          git(repoDir, [
            "fetch",
            "--quiet",
            "origin",
            `+refs/heads/${feature.branch}:refs/remotes/origin/${feature.branch}`,
          ]);
          const latestRemote = git(
            repoDir,
            ["rev-parse", `refs/remotes/origin/${feature.branch}`],
            { allowFailure: true },
          );
          const alreadyBased =
            latestRemote !== "" &&
            run("git", ["merge-base", "--is-ancestor", newBase, latestRemote], {
              cwd: repoDir,
              allowFailure: true,
            }).status === 0;
          if (alreadyBased) {
            skipped.push({
              number: feature.number,
              branch: feature.branch,
              reason: `remote already based on ${feature.baseBranch} after concurrent update`,
            });
            rewrittenTips.set(feature.branch, latestRemote);
            continue;
          }
          conflicts.push({
            number: feature.number,
            branch: feature.branch,
            message: `push failed: ${stripAnsi(
              pushResult.stderr || pushResult.stdout || "force-with-lease rejected",
            )}`,
          });
          blockedBranches.add(feature.branch);
          continue;
        }
      }
      updated.push({ number: feature.number, branch: feature.branch });
      rewrittenTips.set(feature.branch, newTip);
    } catch (error) {
      if (rebaseInProgress(repoDir)) {
        run("git", ["rebase", "--abort"], { cwd: repoDir, allowFailure: true });
      }
      conflicts.push({
        number: feature.number,
        branch: feature.branch,
        message: error instanceof Error ? error.message : String(error),
      });
      blockedBranches.add(feature.branch);
    }
  }

  // Best-effort cleanup
  try {
    NodeFS.rmSync(workDir, { recursive: true, force: true });
  } catch {
    // ignore
  }

  return { updated, conflicts, skipped };
}

export async function syncStack(options: StackRunOptions): Promise<StackRunResult> {
  const sourceRoot = NodePath.resolve(options.sourceRoot ?? process.cwd());
  const manifest = readManifest(sourceRoot, options.manifestPath);
  if (options.validatePullRequests !== false) {
    await validatePullRequests(manifest, options.pullRequests);
  }
  const { stateDir, state } = initializeState(
    sourceRoot,
    manifest,
    options.initialBaseForAll === true,
  );
  const completed = continueOperations(stateDir, state, {
    verifyEachCommit: options.verifyEachCommit === true,
  });
  const result = await finishRun(stateDir, completed, options);

  // When fork/changes moves, record base-history and rebase open feature PRs onto the new tip.
  // Skipped in unit tests / environments without GitHub credentials.
  if (options.push && (process.env.GH_TOKEN || process.env.GITHUB_TOKEN)) {
    const oldTip = result.snapshots[manifest.forkChangesBranch];
    const newTip = result.newTips[manifest.forkChangesBranch];
    if (oldTip && newTip) {
      try {
        // A normal PR merge advances fork/changes before this workflow starts, so
        // snapshots already contain the new tip. Its first parent is the previous
        // fork/changes base that open feature PRs still contain.
        const firstParent = git(sourceRoot, ["rev-parse", `${newTip}^`], {
          allowFailure: true,
        });
        const previousBase = oldTip !== newTip ? oldTip : firstParent;
        pushForkChangesBaseHistory(sourceRoot, [newTip, previousBase, oldTip]);
        const featureResult = await rebaseOpenFeaturePullRequests({
          sourceRoot,
          manifest,
          push: true,
          oldForkChangesTip: previousBase,
          newForkChangesTip: newTip,
        });
        appendFeatureRebaseSummary(featureResult);
        console.log(
          `Feature PRs: updated=${featureResult.updated.length} conflicts=${featureResult.conflicts.length} skipped=${featureResult.skipped.length}`,
        );
        // Integration overlays must be based on the new tip for compose. Surface a
        // hard error when a registered overlay could not be rebased, instead of
        // failing later with a less actionable compose-time message.
        // "Already based" / identical-tip skips are success — see
        // isSuccessfulFeatureRebaseSkip (must match actual skip reason strings).
        if (manifest.integrationOverlays.length > 0) {
          const overlayBranches = new Set(manifest.integrationOverlays.map(({ branch }) => branch));
          const failedOverlays = featureResult.conflicts.filter((entry) =>
            overlayBranches.has(entry.branch),
          );
          const skippedOverlays = featureResult.skipped.filter(
            (entry) =>
              overlayBranches.has(entry.branch) &&
              !isSuccessfulFeatureRebaseSkip(entry.reason, manifest.forkChangesBranch),
          );
          if (failedOverlays.length > 0 || skippedOverlays.length > 0) {
            const details = [
              ...failedOverlays.map(
                (entry) => `#${entry.number} (${entry.branch}): ${entry.message}`,
              ),
              ...skippedOverlays.map(
                (entry) => `#${entry.number} (${entry.branch}): ${entry.reason}`,
              ),
            ].join("; ");
            throw new StackError(
              `Integration overlay auto-rebase incomplete after fork/changes advanced: ${details}`,
            );
          }
        }
      } catch (error) {
        // Stack layer refs are already pushed. Overlay incompleteness is fatal for
        // the job (compose cannot proceed); ordinary feature PR failures are not.
        if (
          error instanceof StackError &&
          error.message.startsWith("Integration overlay auto-rebase incomplete")
        ) {
          throw error;
        }
        console.error(
          `Feature PR auto-rebase failed (stack sync already pushed): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  return result;
}

/**
 * Skip reasons from {@link rebaseOpenFeaturePullRequests} that mean the branch
 * is already correctly based on its parent (no further work needed).
 *
 * Keep these strings in sync with the `skipped.push({ reason: ... })` sites in
 * that function. The post-sync overlay gate must treat them as success, not as
 * "incomplete" failures — otherwise a no-op cascade hard-fails when overlays
 * are already on the new tip and blocks compose/dispatch.
 */
export function isSuccessfulFeatureRebaseSkip(reason: string, baseBranch: string): boolean {
  return (
    reason === `already based on ${baseBranch}` ||
    reason === `remote already based on ${baseBranch} after concurrent update` ||
    reason === "rebase produced identical tip"
  );
}

/**
 * Append fork/changes tips to the durable base-history ref and push it.
 * Newest tips first so multi-generation recovery prefers the most recent base
 * still reachable from a feature head.
 */
export function baseHistoryPushArgs(remoteOid: string): ReadonlyArray<string> {
  return [
    "push",
    `--force-with-lease=${FORK_CHANGES_BASE_HISTORY_REF}:${remoteOid}`,
    "origin",
    `${FORK_CHANGES_BASE_HISTORY_REF}:${FORK_CHANGES_BASE_HISTORY_REF}`,
  ];
}

function pushForkChangesBaseHistory(
  sourceRoot: string,
  tipsNewestFirst: ReadonlyArray<string>,
): void {
  const repoDir = sourceRoot;
  const remoteLine = git(
    repoDir,
    ["ls-remote", "--refs", "origin", FORK_CHANGES_BASE_HISTORY_REF],
    { allowFailure: true },
  );
  const remoteOid = remoteLine.split(/\s+/u)[0] ?? "";
  run(
    "git",
    ["fetch", "origin", `${FORK_CHANGES_BASE_HISTORY_REF}:${FORK_CHANGES_BASE_HISTORY_REF}`],
    { cwd: repoDir, allowFailure: true },
  );
  const existingBlob = git(repoDir, ["show", FORK_CHANGES_BASE_HISTORY_REF], {
    allowFailure: true,
  });
  const existing = existingBlob ? parseBaseHistory(existingBlob) : [];
  const next = appendBaseHistory(existing, tipsNewestFirst);
  const body = `${next.join("\n")}\n`;
  const tmp = NodePath.join(NodeOS.tmpdir(), `fork-changes-base-history-${process.pid}.txt`);
  NodeFS.writeFileSync(tmp, body, "utf8");
  try {
    const blobOid = git(repoDir, ["hash-object", "-w", tmp]);
    git(repoDir, ["update-ref", FORK_CHANGES_BASE_HISTORY_REF, blobOid]);
    git(repoDir, baseHistoryPushArgs(remoteOid));
    console.log(
      `Updated ${FORK_CHANGES_BASE_HISTORY_REF} (${next.length} tip(s); newest ${next[0]?.slice(0, 12) ?? "none"}).`,
    );
  } finally {
    try {
      NodeFS.unlinkSync(tmp);
    } catch {
      // ignore
    }
  }
}

function appendFeatureRebaseSummary(result: FeaturePullRequestRebaseResult): void {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  const lines = [
    "## Open feature PR rebases",
    "",
    `- Updated: ${result.updated.length}`,
    `- Conflicts: ${result.conflicts.length}`,
    `- Skipped: ${result.skipped.length}`,
    "",
  ];
  if (result.updated.length > 0) {
    lines.push("### Updated", ...result.updated.map((p) => `- #${p.number} (\`${p.branch}\`)`), "");
  }
  if (result.conflicts.length > 0) {
    lines.push(
      "### Conflicts (manual fix needed)",
      ...result.conflicts.map((p) => `- #${p.number} (\`${p.branch}\`): ${p.message}`),
      "",
      "Fix with:",
      "```sh",
      "pnpm fork:stack update --push <pr-number>",
      "```",
      "",
    );
  }
  if (result.skipped.length > 0) {
    lines.push(
      "### Skipped",
      ...result.skipped.map((p) => `- #${p.number} (\`${p.branch}\`): ${p.reason}`),
      "",
    );
  }
  NodeFS.appendFileSync(summaryPath, `${lines.join("\n")}\n`, "utf8");
}

export async function resumeStack(
  stateDirInput: string,
  options: Pick<StackRunOptions, "push" | "preserveState" | "beforePush" | "verifyEachCommit">,
): Promise<StackRunResult> {
  const stateDir = NodePath.resolve(stateDirInput);
  let state = readState(stateDir);
  const operation = state.currentOperation;
  if (!operation) {
    throw new StackError(`No interrupted rebase exists in ${stateDir}.`, { stateDir });
  }
  if (rebaseInProgress(state.repoDir)) {
    const unresolvedOutput = git(state.repoDir, ["diff", "--name-only", "--diff-filter=U"], {
      stateDir,
    });
    if (unresolvedOutput) throw conflictError(stateDir, state, operation);
    const result = run("git", ["-c", "commit.gpgsign=false", "rebase", "--continue"], {
      cwd: state.repoDir,
      allowFailure: true,
      env: { GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true" },
      stateDir,
    });
    if (result.status !== 0) {
      if (rebaseInProgress(state.repoDir)) throw conflictError(stateDir, state, operation);
      throw new GitCommandError(["rebase", "--continue"], state.repoDir, result, stateDir);
    }
  }
  state = finishOperation(stateDir, state, operation);
  state = continueOperations(stateDir, state, {
    verifyEachCommit: options.verifyEachCommit === true,
  });
  return finishRun(stateDir, state, options);
}

function validateRemoteTopology(sourceRoot: string, manifest: StackManifest): void {
  const { stateDir, state } = initializeState(sourceRoot, manifest, false);
  try {
    const originMain = state.snapshots[manifest.upstreamBranch];
    if (!originMain) throw new StackError("The origin main snapshot is missing.", { stateDir });
    let parent = originMain;
    for (const pullRequest of manifest.pullRequests) {
      const child = state.snapshots[pullRequest.branch];
      if (!child)
        throw new StackError(`Missing remote branch ${pullRequest.branch}.`, { stateDir });
      validateAncestry(
        state.repoDir,
        parent,
        child,
        `PR #${pullRequest.number} does not contain ${expectedBase(manifest, manifest.pullRequests.indexOf(pullRequest))}.`,
        stateDir,
      );
      const count = Number(
        git(state.repoDir, ["rev-list", "--count", `${parent}..${child}`], { stateDir }),
      );
      if (count < 1) throw new StackError(`PR #${pullRequest.number} is empty.`, { stateDir });
      parent = child;
    }
    const integrationTip = state.snapshots[manifest.integrationBranch];
    if (!integrationTip) throw new StackError("The integration branch is missing.", { stateDir });
    validateAncestry(
      state.repoDir,
      parent,
      integrationTip,
      "The integration branch does not contain the top PR.",
      stateDir,
    );
  } finally {
    cleanupState(stateDir);
  }
}

export async function checkStack(
  options: {
    readonly sourceRoot?: string;
    readonly manifestPath?: string;
    readonly pullRequests?: ReadonlyArray<PullRequestSnapshot>;
    readonly validatePullRequests?: boolean;
  } = {},
): Promise<void> {
  const sourceRoot = NodePath.resolve(options.sourceRoot ?? process.cwd());
  const manifest = readManifest(sourceRoot, options.manifestPath);
  if (options.validatePullRequests !== false) {
    await validatePullRequests(manifest, options.pullRequests);
  }
  validateRemoteTopology(sourceRoot, manifest);
}

function conflictResolutionManifestSnippet(
  branch: string,
  commit: string,
  paths: ReadonlyArray<string>,
  strategy: "ours" | "theirs" = "theirs",
): string {
  const entries = paths.map(
    (path) => `    {
      "branch": ${JSON.stringify(branch)},
      "commit": "*",
      "path": ${JSON.stringify(path)},
      "strategy": ${JSON.stringify(strategy)}
    }`,
  );
  const exact = paths.map(
    (path) => `    {
      "branch": ${JSON.stringify(branch)},
      "commit": ${JSON.stringify(commit)},
      "path": ${JSON.stringify(path)},
      "strategy": ${JSON.stringify(strategy)}
    }`,
  );
  return `### Record in \`.github/pr-stack.json\` (required before the next stack sync)

Do **not** only resume once. Exact SHAs go stale after every successful layer rewrite.
Prefer durable \`commit: "*"\` path policies when the same file always takes the same side:

\`\`\`json
  "conflictResolutions": [
${entries.join(",\n")}
  ]
\`\`\`

One-shot resume for this exact replay only (optional, in addition):

\`\`\`json
  "conflictResolutions": [
${exact.join(",\n")}
  ]
\`\`\`

During rebase: \`theirs\` = commit being replayed, \`ours\` = new base. After editing the
manifest, merge that change to \`fork/changes\` so the next scheduled sync can auto-resolve.
`;
}

function appendConflictSummary(error: RebaseConflictError): void {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  const label =
    error.pullRequestNumber === undefined
      ? `integration branch \`${error.branch}\``
      : `PR #${error.pullRequestNumber} (\`${error.branch}\`)`;
  const paths =
    error.conflictingPaths.length === 0
      ? "- Git did not report a conflicted path."
      : error.conflictingPaths.map((path) => `- \`${path}\``).join("\n");
  const record =
    error.conflictingPaths.length === 0
      ? ""
      : `\n${conflictResolutionManifestSnippet(error.branch, error.commit, error.conflictingPaths)}\n`;
  NodeFS.appendFileSync(
    summaryPath,
    `## PR stack rebase conflict

- Failing item: ${label}
- Parent branch: \`${error.parentBranch}\`
- Commit being replayed: \`${error.commit}\` — ${error.commitSubject}

### Conflicting paths

${paths}
${record}
### Local reproduction

\`\`\`sh
node scripts/rebase-pr-stack.ts sync --push
# 1) Add conflictResolutions to .github/pr-stack.json (see above) and merge to fork/changes
# 2) Resolve and stage the reported files in the preserved state dir, then:
node scripts/rebase-pr-stack.ts resume --state ${error.stateDir ?? "<temporary-directory>"} --push
\`\`\`
`,
    "utf8",
  );
}

function usage(): string {
  return `Usage:
  node scripts/rebase-pr-stack.ts check
  node scripts/rebase-pr-stack.ts sync --push [--verify-each-commit]
  node scripts/rebase-pr-stack.ts sync --dry-run [--verify-each-commit]
  node scripts/rebase-pr-stack.ts resume --state <temporary-directory> --push
  node scripts/rebase-pr-stack.ts verify-head`;
}

async function main(args: ReadonlyArray<string>): Promise<void> {
  const [command, ...flags] = args;
  if (command === "check" && flags.length === 0) {
    await checkStack();
    console.log("PR stack manifest, pull requests, and remote topology are valid.");
    return;
  }
  if (command === "verify-head" && flags.length === 0) {
    verifyReplayHead(process.cwd());
    return;
  }
  if (command === "sync") {
    const push = flags.includes("--push");
    const dryRun = flags.includes("--dry-run");
    const verifyEachCommit = flags.includes("--verify-each-commit");
    const allowed = new Set(["--push", "--dry-run", "--verify-each-commit"]);
    if (push === dryRun || flags.some((flag) => !allowed.has(flag))) {
      throw new StackError(usage());
    }
    const result = await syncStack({ push, verifyEachCommit });
    console.log(
      push
        ? `Atomically updated ${Object.keys(result.newTips).length + 1} branches.`
        : `Dry run succeeded; ${Object.keys(result.newTips).length} branches would be rewritten.`,
    );
    return;
  }
  if (command === "resume") {
    const stateIndex = flags.indexOf("--state");
    const stateDir = stateIndex >= 0 ? flags[stateIndex + 1] : undefined;
    const push = flags.includes("--push");
    const valid =
      stateDir !== undefined &&
      push &&
      flags.length === 3 &&
      stateIndex >= 0 &&
      flags.every(
        (flag, index) => index === stateIndex + 1 || flag === "--state" || flag === "--push",
      );
    if (!valid) throw new StackError(usage());
    const result = await resumeStack(stateDir, { push: true });
    console.log(
      `Rebase resumed and atomically updated ${Object.keys(result.newTips).length + 1} branches.`,
    );
    return;
  }
  throw new StackError(usage());
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === NodeURL.pathToFileURL(NodePath.resolve(process.argv[1])).href;

if (isMain) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    if (error instanceof RebaseConflictError) appendConflictSummary(error);
    console.error(error instanceof Error ? error.message : String(error));
    if (error instanceof StackError && error.stateDir) {
      console.error(`Rebase workspace preserved at: ${error.stateDir}`);
    }
    process.exitCode = 1;
  });
}
