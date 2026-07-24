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

export interface StackPullRequest {
  readonly number: number;
  readonly branch: string;
}

export interface StackManifest {
  readonly upstreamRemote: string;
  readonly upstreamBranch: string;
  readonly forkChangesBranch: string;
  readonly integrationBranch: string;
  readonly pullRequests: ReadonlyArray<StackPullRequest>;
}

export interface PullRequestSnapshot {
  readonly number: number;
  readonly state: string;
  readonly headBranch: string;
  readonly headOwner: string;
  readonly baseBranch: string;
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
  readonly beforePush?: (state: Readonly<PersistedState>) => void | Promise<void>;
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
  const result = NodeChildProcess.spawnSync(executable, [...args], {
    cwd: options.cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      ...options.env,
    },
  });
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
  const { upstreamRemote, upstreamBranch, forkChangesBranch, integrationBranch, pullRequests } =
    value;
  if (
    typeof upstreamRemote !== "string" ||
    upstreamRemote.length === 0 ||
    typeof upstreamBranch !== "string" ||
    upstreamBranch.length === 0 ||
    typeof forkChangesBranch !== "string" ||
    forkChangesBranch.length === 0 ||
    typeof integrationBranch !== "string" ||
    integrationBranch.length === 0 ||
    !Array.isArray(pullRequests)
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

  const numbers = new Set(parsedPullRequests.map(({ number }) => number));
  const branches = new Set(parsedPullRequests.map(({ branch }) => branch));
  if (numbers.size !== parsedPullRequests.length || branches.size !== parsedPullRequests.length) {
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
  for (const { number } of manifest.pullRequests) {
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
    if (
      typeof number !== "number" ||
      typeof state !== "string" ||
      typeof headBranch !== "string" ||
      typeof headOwner !== "string" ||
      typeof baseBranch !== "string"
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
      };
    }
    return { number, state, headBranch, headOwner, baseBranch };
  });
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
    const oldBaseBranch =
      nextIndex === 0 || initialBaseForAll ? manifest.upstreamBranch : parentBranch;
    const oldBase = snapshots[oldBaseBranch];
    const oldTip = snapshots[pullRequest.branch];
    const newBase = nextIndex === 0 ? state.upstreamTip : newTips[parentBranch];
    if (!oldBase || !oldTip || !newBase) {
      throw new StackError(`Missing snapshot while preparing PR #${pullRequest.number}.`);
    }
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
    const oldBase = snapshots[top.branch];
    const oldTip = snapshots[manifest.integrationBranch];
    const newBase = newTips[top.branch];
    if (!oldBase || !oldTip || !newBase) {
      throw new StackError("Missing snapshot while preparing the integration branch.");
    }
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
  return new RebaseConflictError(
    operation,
    stateDir,
    commit,
    commitSubject || "unknown commit",
    conflictingPaths,
  );
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
): PersistedState {
  let updated = updateState(stateDir, state, { currentOperation: operation });
  if (operation.commits.length === 0) {
    git(updated.repoDir, ["checkout", "--quiet", "--detach", operation.newBase], { stateDir });
    return finishOperation(stateDir, updated, operation);
  }
  if (operation.oldBase === operation.newBase) {
    git(updated.repoDir, ["checkout", "--quiet", "--detach", operation.oldTip], { stateDir });
    return finishOperation(stateDir, updated, operation);
  }
  git(updated.repoDir, ["checkout", "--quiet", "--detach", operation.oldTip], { stateDir });
  const result = run(
    "git",
    [
      "-c",
      "commit.gpgsign=false",
      "rebase",
      "--onto",
      operation.newBase,
      operation.oldBase,
      operation.oldTip,
    ],
    {
      cwd: updated.repoDir,
      allowFailure: true,
      env: { GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true" },
      stateDir,
    },
  );
  if (result.status !== 0) {
    if (rebaseInProgress(updated.repoDir)) {
      throw conflictError(stateDir, updated, operation);
    }
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

function continueOperations(stateDir: string, initialState: PersistedState): PersistedState {
  let state = initialState;
  for (;;) {
    const operation = makeOperation(state);
    if (!operation) return state;
    state = startOperation(stateDir, state, operation);
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
  const completed = continueOperations(stateDir, state);
  return finishRun(stateDir, completed, options);
}

export async function resumeStack(
  stateDirInput: string,
  options: Pick<StackRunOptions, "push" | "preserveState" | "beforePush">,
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
  state = continueOperations(stateDir, state);
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
  NodeFS.appendFileSync(
    summaryPath,
    `## PR stack rebase conflict

- Failing item: ${label}
- Parent branch: \`${error.parentBranch}\`
- Commit being replayed: \`${error.commit}\` — ${error.commitSubject}

### Conflicting paths

${paths}

### Local reproduction

\`\`\`sh
node scripts/rebase-pr-stack.ts sync --push
# Resolve and stage the reported files, then:
node scripts/rebase-pr-stack.ts resume --state ${error.stateDir ?? "<temporary-directory>"} --push
\`\`\`
`,
    "utf8",
  );
}

function usage(): string {
  return `Usage:
  node scripts/rebase-pr-stack.ts check
  node scripts/rebase-pr-stack.ts sync --push
  node scripts/rebase-pr-stack.ts sync --dry-run
  node scripts/rebase-pr-stack.ts resume --state <temporary-directory> --push`;
}

async function main(args: ReadonlyArray<string>): Promise<void> {
  const [command, ...flags] = args;
  if (command === "check" && flags.length === 0) {
    await checkStack();
    console.log("PR stack manifest, pull requests, and remote topology are valid.");
    return;
  }
  if (command === "sync") {
    const push = flags.includes("--push");
    const dryRun = flags.includes("--dry-run");
    if (push === dryRun || flags.some((flag) => flag !== "--push" && flag !== "--dry-run")) {
      throw new StackError(usage());
    }
    const result = await syncStack({ push });
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
