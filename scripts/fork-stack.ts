#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalConsole:off

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const FORK_REPOSITORY = process.env.T3CODE_FORK_REPOSITORY ?? "patroza/t3code";

import {
  readManifest,
  StackError,
  type StackManifest,
  type StackPullRequest,
} from "./rebase-pr-stack.ts";

const MANIFEST_PATH = NodePath.join(".github", "pr-stack.json");

interface PullRequestView {
  readonly number: number;
  readonly state: string;
  readonly headRefName: string;
  readonly baseRefName: string;
}

interface PullRequestCommitsView {
  readonly state: string;
  readonly baseRefName: string;
  readonly commits: ReadonlyArray<{ readonly oid: string }>;
}

function run(executable: string, args: ReadonlyArray<string>, cwd: string): string {
  const result = NodeChildProcess.spawnSync(executable, [...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.error) throw new StackError(`Unable to run ${executable}: ${result.error.message}`);
  if (result.status !== 0) {
    throw new StackError(
      `${executable} ${args.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  return result.stdout.trim();
}

export function stackParentBranch(manifest: StackManifest): string {
  return manifest.pullRequests.at(-1)?.branch ?? manifest.forkChangesBranch;
}

export function registerPullRequest(
  manifest: StackManifest,
  pullRequest: PullRequestView,
): StackManifest {
  if (pullRequest.state.toLowerCase() !== "open") {
    throw new StackError(`PR #${pullRequest.number} is not open.`);
  }
  if (manifest.pullRequests.some(({ number }) => number === pullRequest.number)) {
    throw new StackError(`PR #${pullRequest.number} is already registered.`);
  }
  if (manifest.pullRequests.some(({ branch }) => branch === pullRequest.headRefName)) {
    throw new StackError(`Branch ${pullRequest.headRefName} is already registered.`);
  }

  const expectedBranch =
    manifest.pullRequests.length === 0 ? manifest.forkChangesBranch : pullRequest.headRefName;
  if (manifest.pullRequests.length === 0 && pullRequest.headRefName !== expectedBranch) {
    throw new StackError(
      `The first PR must use ${manifest.forkChangesBranch}, got ${pullRequest.headRefName}.`,
    );
  }

  const expectedBase = manifest.pullRequests.at(-1)?.branch ?? manifest.upstreamBranch;
  if (pullRequest.baseRefName !== expectedBase) {
    throw new StackError(
      `PR #${pullRequest.number} is based on ${pullRequest.baseRefName}, expected ${expectedBase}.`,
    );
  }

  return {
    ...manifest,
    pullRequests: [
      ...manifest.pullRequests,
      { number: pullRequest.number, branch: pullRequest.headRefName },
    ],
  };
}

export function unregisterTopPullRequest(manifest: StackManifest, number: number): StackManifest {
  const top = manifest.pullRequests.at(-1);
  if (!top || top.number !== number) {
    throw new StackError(
      `Only the top PR can be unregistered; expected #${top?.number ?? "none"}, got #${number}.`,
    );
  }
  return { ...manifest, pullRequests: manifest.pullRequests.slice(0, -1) };
}

function writeManifest(sourceRoot: string, manifest: StackManifest): void {
  NodeFS.writeFileSync(
    NodePath.join(sourceRoot, MANIFEST_PATH),
    `${JSON.stringify(manifest, undefined, 2)}\n`,
    "utf8",
  );
}

function readPullRequest(sourceRoot: string, number: number): PullRequestView {
  const output = run(
    "gh",
    [
      "pr",
      "view",
      String(number),
      "--repo",
      FORK_REPOSITORY,
      "--json",
      "number,state,headRefName,baseRefName",
    ],
    sourceRoot,
  );
  const value = JSON.parse(output) as PullRequestView;
  return value;
}

function ensureClean(sourceRoot: string): void {
  if (run("git", ["status", "--porcelain"], sourceRoot) !== "") {
    throw new StackError("The working tree must be clean before starting a stack branch.");
  }
}

function usage(): string {
  return `Usage:
  node scripts/fork-stack.ts start <branch>
  node scripts/fork-stack.ts start-upstream <branch>
  node scripts/fork-stack.ts promote <private-pr-number> <upstream-branch>
  node scripts/fork-stack.ts adopt <upstream-branch> <private-branch>
  node scripts/fork-stack.ts demote <upstream-pr-number> <private-pr-number>
  node scripts/fork-stack.ts register <pr-number>
  node scripts/fork-stack.ts unregister <pr-number>
  node scripts/fork-stack.ts find <query>
  node scripts/fork-stack.ts find-upstream <query>
  node scripts/fork-stack.ts status`;
}

async function main(args: ReadonlyArray<string>): Promise<void> {
  const sourceRoot = process.cwd();
  const manifest = readManifest(sourceRoot);
  const [command, value, ...extra] = args;

  if (command === "start" && value && extra.length === 0) {
    ensureClean(sourceRoot);
    const parent = stackParentBranch(manifest);
    run("git", ["fetch", "origin", parent], sourceRoot);
    run("git", ["switch", "-c", value, `origin/${parent}`], sourceRoot);
    console.log(`Created ${value} from ${parent}. Open its PR against ${parent}.`);
    return;
  }

  if (command === "start-upstream" && value && extra.length === 0) {
    ensureClean(sourceRoot);
    run(
      "git",
      [
        "fetch",
        manifest.upstreamRemote,
        `+refs/heads/${manifest.upstreamBranch}:refs/remotes/${manifest.upstreamRemote}/${manifest.upstreamBranch}`,
      ],
      sourceRoot,
    );
    run(
      "git",
      ["switch", "-c", value, `${manifest.upstreamRemote}/${manifest.upstreamBranch}`],
      sourceRoot,
    );
    console.log(
      `Created ${value} from ${manifest.upstreamRemote}/${manifest.upstreamBranch}. Open it to pingdotgg/t3code:${manifest.upstreamBranch}.`,
    );
    return;
  }

  if (command === "promote" && value && extra.length === 1) {
    const number = Number(value);
    const upstreamBranch = extra[0]!;
    if (!Number.isSafeInteger(number) || number <= 0) throw new StackError(usage());
    ensureClean(sourceRoot);
    const pullRequest = JSON.parse(
      run(
        "gh",
        [
          "pr",
          "view",
          String(number),
          "--repo",
          FORK_REPOSITORY,
          "--json",
          "state,baseRefName,commits",
        ],
        sourceRoot,
      ),
    ) as PullRequestCommitsView;
    if (
      pullRequest.state.toLowerCase() !== "merged" ||
      pullRequest.baseRefName !== manifest.forkChangesBranch ||
      pullRequest.commits.length === 0
    ) {
      throw new StackError(
        `Private PR #${number} must be merged into ${manifest.forkChangesBranch} before promotion.`,
      );
    }
    run(
      "git",
      ["fetch", "origin", `+refs/pull/${number}/head:refs/remotes/origin/pr/${number}`],
      sourceRoot,
    );
    run(
      "git",
      [
        "fetch",
        manifest.upstreamRemote,
        `+refs/heads/${manifest.upstreamBranch}:refs/remotes/${manifest.upstreamRemote}/${manifest.upstreamBranch}`,
      ],
      sourceRoot,
    );
    run(
      "git",
      ["switch", "-c", upstreamBranch, `${manifest.upstreamRemote}/${manifest.upstreamBranch}`],
      sourceRoot,
    );
    run(
      "git",
      ["cherry-pick", "--no-commit", ...pullRequest.commits.map(({ oid }) => oid)],
      sourceRoot,
    );
    console.log(
      `Extracted private PR #${number} onto ${upstreamBranch}. Remove private assumptions, test, commit, and open it to pingdotgg/t3code:${manifest.upstreamBranch}.`,
    );
    return;
  }

  if (command === "adopt" && value && extra.length === 1) {
    const upstreamBranch = value;
    const privateBranch = extra[0]!;
    ensureClean(sourceRoot);
    run(
      "git",
      [
        "fetch",
        manifest.upstreamRemote,
        `+refs/heads/${manifest.upstreamBranch}:refs/remotes/${manifest.upstreamRemote}/${manifest.upstreamBranch}`,
      ],
      sourceRoot,
    );
    run(
      "git",
      ["fetch", "origin", `+refs/heads/${upstreamBranch}:refs/remotes/origin/${upstreamBranch}`],
      sourceRoot,
    );
    run("git", ["fetch", "origin", manifest.forkChangesBranch], sourceRoot);
    const commits = run(
      "git",
      [
        "rev-list",
        "--reverse",
        "--no-merges",
        `${manifest.upstreamRemote}/${manifest.upstreamBranch}..origin/${upstreamBranch}`,
      ],
      sourceRoot,
    )
      .split("\n")
      .filter(Boolean);
    if (commits.length === 0) {
      throw new StackError(`No portable commits found on origin/${upstreamBranch}.`);
    }
    run("git", ["switch", "-c", privateBranch, `origin/${manifest.forkChangesBranch}`], sourceRoot);
    run("git", ["cherry-pick", ...commits], sourceRoot);
    console.log(
      `Adopted ${upstreamBranch} as ${privateBranch}. Open it against ${manifest.forkChangesBranch}.`,
    );
    return;
  }

  if (command === "demote" && value && extra.length === 1) {
    const upstreamNumber = Number(value);
    const privateNumber = Number(extra[0]);
    if (
      !Number.isSafeInteger(upstreamNumber) ||
      upstreamNumber <= 0 ||
      !Number.isSafeInteger(privateNumber) ||
      privateNumber <= 0
    ) {
      throw new StackError(usage());
    }
    run(
      "gh",
      [
        "pr",
        "close",
        String(upstreamNumber),
        "--repo",
        "pingdotgg/t3code",
        "--comment",
        `Keeping this implementation private in ${FORK_REPOSITORY}#${privateNumber}.`,
      ],
      sourceRoot,
    );
    run(
      "gh",
      [
        "pr",
        "comment",
        String(privateNumber),
        "--repo",
        FORK_REPOSITORY,
        "--body",
        `Upstream projection pingdotgg/t3code#${upstreamNumber} was closed; this private implementation remains canonical.`,
      ],
      sourceRoot,
    );
    console.log(
      `Demoted pingdotgg/t3code#${upstreamNumber}; private PR #${privateNumber} remains canonical.`,
    );
    return;
  }

  if (command === "register" && value && extra.length === 0) {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number <= 0) throw new StackError(usage());
    const next = registerPullRequest(manifest, readPullRequest(sourceRoot, number));
    writeManifest(sourceRoot, next);
    console.log(`Registered PR #${number}. Commit the manifest change into fork/changes.`);
    return;
  }

  if (command === "unregister" && value && extra.length === 0) {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number <= 0) throw new StackError(usage());
    writeManifest(sourceRoot, unregisterTopPullRequest(manifest, number));
    console.log(`Unregistered PR #${number}. Commit the manifest change into fork/changes.`);
    return;
  }

  if ((command === "find" || command === "find-upstream") && value && extra.length === 0) {
    const repository = command === "find-upstream" ? "pingdotgg/t3code" : FORK_REPOSITORY;
    const output = run(
      "gh",
      [
        "pr",
        "list",
        "--repo",
        repository,
        "--state",
        "all",
        "--search",
        value,
        "--limit",
        "30",
        "--json",
        "number,title,state,headRefName,baseRefName,url",
      ],
      sourceRoot,
    );
    console.log(output);
    return;
  }

  if (command === "status" && value === undefined && extra.length === 0) {
    const rows: ReadonlyArray<StackPullRequest> = manifest.pullRequests;
    console.log(
      JSON.stringify(
        {
          upstream: `${manifest.upstreamRemote}/${manifest.upstreamBranch}`,
          forkChangesBranch: manifest.forkChangesBranch,
          integrationBranch: manifest.integrationBranch,
          nextBaseBranch: stackParentBranch(manifest),
          pullRequests: rows,
        },
        undefined,
        2,
      ),
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
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
