/**
 * Record Fork CI tree evidence, or decide which jobs a run may skip. Verify exits 0 and runs
 * everything when it cannot decide.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeProcess from "node:process";

import { isTrustedActor, localProofDecision, trustedActors } from "./lib/fork-ci-local-proof.mjs";
import {
  FORK_CI_WORKFLOW,
  TREE_EVIDENCE_CONTEXT,
  formatTreeEvidence,
  mobileStaticAnalysisRequired,
  shortCircuitReason,
} from "./lib/fork-ci-tree-evidence.mjs";

/** A ready-PR agent push posts its proof once the push lands, racing this job. */
const PROOF_WAIT_ATTEMPTS = 3;
const PROOF_WAIT_MS = 10_000;

const git = (args) => {
  const result = NodeChildProcess.spawnSync("git", args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error((result.stderr || `git ${args.join(" ")} failed`).trim());
  }
  return result.stdout.trim();
};

const tryGit = (args) => {
  const result = NodeChildProcess.spawnSync("git", args, { encoding: "utf8" });
  if (result.status !== 0) return null;
  const value = result.stdout.trim();
  return value.length > 0 ? value : null;
};

/**
 * @param {string} path
 * @param {{ method?: string, body?: unknown }} [options]
 */
const github = async (path, options = {}) => {
  const token = NodeProcess.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is missing");
  const api = NodeProcess.env.GITHUB_API_URL ?? "https://api.github.com";
  const response = await fetch(`${api}${path}`, {
    method: options.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (!response.ok) {
    throw new Error(`GitHub ${options.method ?? "GET"} ${path} failed (${response.status})`);
  }
  return response.json();
};

/** @param {Record<string, string>} outputs */
const writeOutputs = (outputs) => {
  const lines = Object.entries(outputs)
    .map(([key, value]) => `${key}=${value}\n`)
    .join("");
  const file = NodeProcess.env.GITHUB_OUTPUT;
  if (file) NodeFS.appendFileSync(file, lines);
  else NodeProcess.stdout.write(lines);
};

const RUN_EVERYTHING = { short_circuit: "false", local_proof: "false", mobile: "true" };

const writeSummary = (text) => {
  const file = NodeProcess.env.GITHUB_STEP_SUMMARY;
  if (file) NodeFS.appendFileSync(file, `${text}\n`);
  else NodeProcess.stderr.write(`${text}\n`);
};

const record = async () => {
  if (NodeProcess.env.GITHUB_EVENT_NAME !== "pull_request") {
    throw new Error("tree evidence is recorded only for pull requests");
  }
  const headSha = NodeProcess.env.PR_HEAD_SHA;
  const repository = NodeProcess.env.GITHUB_REPOSITORY;
  const runId = NodeProcess.env.GITHUB_RUN_ID;
  const server = NodeProcess.env.GITHUB_SERVER_URL ?? "https://github.com";
  if (!headSha || !repository || !runId) {
    throw new Error("PR_HEAD_SHA, GITHUB_REPOSITORY, and GITHUB_RUN_ID are required");
  }
  const tree = git(["rev-parse", "HEAD^{tree}"]);
  const workflowBlob = git(["rev-parse", `HEAD:${FORK_CI_WORKFLOW}`]);
  await github(`/repos/${repository}/statuses/${headSha}`, {
    method: "POST",
    body: {
      state: "success",
      context: TREE_EVIDENCE_CONTEXT,
      description: formatTreeEvidence(tree, workflowBlob),
      target_url: `${server}/${repository}/actions/runs/${runId}`,
    },
  });
  writeSummary(
    `Recorded tree \`${tree}\` for \`${headSha}\` from run ${runId}. A fork/dev push of this same tree can reuse this run.`,
  );
};

/** @returns {string[] | null} paths changed against the first parent, null when unknown */
const changedPaths = () => {
  const parent = tryGit(["rev-parse", "--verify", "HEAD^1"]);
  if (!parent) return null;
  const result = NodeChildProcess.spawnSync("git", ["diff", "--name-only", "-z", parent, "HEAD"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) return null;
  return result.stdout.split("\0").filter(Boolean);
};

/** @returns {Promise<string | null>} why the checks must run, or null on a matching push */
const treeEvidenceReason = async (repository, mobileRequired) => {
  const parentSha = tryGit(["rev-parse", "--verify", "HEAD^2"]) ?? git(["rev-parse", "HEAD"]);
  const pushTree = git(["rev-parse", "HEAD^{tree}"]);
  const pushWorkflowBlob = git(["rev-parse", `HEAD:${FORK_CI_WORKFLOW}`]);
  const status = await github(`/repos/${repository}/commits/${parentSha}/status`);
  const evidenceStatus = (status.statuses ?? []).find(
    (item) => item.context === TREE_EVIDENCE_CONTEXT,
  );
  const evidence = evidenceStatus
    ? {
        state: evidenceStatus.state,
        description: evidenceStatus.description,
        targetUrl: evidenceStatus.target_url,
      }
    : null;
  const runId = evidence?.targetUrl?.match(/\/actions\/runs\/(\d+)/)?.[1];
  let run = null;
  if (runId) {
    const payload = await github(`/repos/${repository}/actions/runs/${runId}`);
    const jobs = await github(`/repos/${repository}/actions/runs/${runId}/jobs?per_page=100`);
    run = {
      id: payload.id,
      conclusion: payload.conclusion,
      event: payload.event,
      path: payload.path,
      headSha: payload.head_sha,
      jobs: jobs.jobs ?? [],
      jobsTruncated: Number(jobs.total_count ?? 0) > (jobs.jobs ?? []).length,
    };
  }
  return shortCircuitReason({
    pushTree,
    pushWorkflowBlob,
    evidence,
    run,
    parentSha,
    mobileRequired,
  });
};

/** Pull requests only. A local proof never skips a fork/dev push; that run stays the backstop. */
const localProof = async (repository) => {
  const env = NodeProcess.env;
  const headSha = env.PR_HEAD_SHA;
  if (!headSha) throw new Error("PR_HEAD_SHA is required");
  // HEAD is the merge commit this run tests. It has the PR head's tree only while the PR
  // contains the latest base, which is exactly when the local gate tested the same thing.
  const tree = git(["rev-parse", "HEAD^{tree}"]);
  const workflowBlob = git(["rev-parse", `HEAD:${FORK_CI_WORKFLOW}`]);
  const trusted = trustedActors(env.GITHUB_REPOSITORY_OWNER, env.LOCAL_PROOF_TRUSTED_ACTORS);
  const decide = async () =>
    localProofDecision({
      statuses: await github(`/repos/${repository}/commits/${headSha}/statuses?per_page=100`),
      tree,
      workflowBlob,
      trusted,
    });
  let decision = await decide();
  const mayStillArrive =
    env.PR_ACTION === "synchronize" &&
    env.PR_DRAFT !== "true" &&
    isTrustedActor(env.GITHUB_ACTOR, trusted);
  if (!mayStillArrive) return decision;
  for (let attempt = 0; attempt < PROOF_WAIT_ATTEMPTS; attempt++) {
    if (decision.proven || decision.reason !== "no local proof") break;
    await new Promise((resolve) => setTimeout(resolve, PROOF_WAIT_MS));
    decision = await decide();
  }
  return decision;
};

const verify = async () => {
  const event = NodeProcess.env.GITHUB_EVENT_NAME;
  const repository = NodeProcess.env.GITHUB_REPOSITORY;
  if (!repository) throw new Error("GITHUB_REPOSITORY is required");
  const outputs = { ...RUN_EVERYTHING };
  const summary = [];

  // A dispatch tests checkout_ref, which this job does not check out.
  const mobileRequired =
    event === "workflow_dispatch" || mobileStaticAnalysisRequired(changedPaths());
  outputs.mobile = String(mobileRequired);
  summary.push(
    mobileRequired
      ? "Mobile Native Static Analysis runs."
      : "Mobile Native Static Analysis skips: this diff touches nothing it lints.",
  );

  if (event === "push") {
    const reason = await treeEvidenceReason(repository, mobileRequired);
    outputs.short_circuit = String(reason === null);
    summary.push(
      reason === null
        ? "Short circuit. A pull request run already tested this tree and workflow."
        : `Running the checks. ${reason}.`,
    );
  } else if (event === "pull_request") {
    const decision = await localProof(repository);
    outputs.local_proof = String(decision.proven);
    summary.push(
      decision.proven
        ? `Local proof by ${decision.creator} on ${decision.proof.machine ?? "an unnamed machine"} covers tree \`${decision.proof.tree}\`: Check, Test Packages, Test Server, and Test Web skip. The fork/dev push still runs them.`
        : `Running the checks. ${decision.reason}${decision.reason === "local proof is for another tree" ? " (is the PR behind its base?)" : ""}.`,
    );
  } else {
    summary.push("Running the checks.");
  }

  writeOutputs(outputs);
  writeSummary(summary.join("\n\n"));
};

const command = NodeProcess.argv[2];
const action = command === "record" ? record : command === "verify" ? verify : null;

if (!action) {
  NodeProcess.stderr.write("usage: fork-ci-tree-evidence.mjs <record|verify>\n");
  NodeProcess.exit(2);
}

try {
  await action();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (command === "verify") {
    writeOutputs(RUN_EVERYTHING);
    writeSummary(`Running every check. ${message}.`);
    NodeProcess.exit(0);
  }
  NodeProcess.stderr.write(`${message}\n`);
  NodeProcess.exit(1);
}
