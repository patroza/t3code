/** Record or verify Fork CI tree evidence. Verify exits 0 when it cannot reuse a run. */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeProcess from "node:process";

import {
  FORK_CI_WORKFLOW,
  TREE_EVIDENCE_CONTEXT,
  formatTreeEvidence,
  shortCircuitReason,
} from "./lib/fork-ci-tree-evidence.mjs";

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

const writeOutput = (key, value) => {
  const line = `${key}=${value}\n`;
  const file = NodeProcess.env.GITHUB_OUTPUT;
  if (file) NodeFS.appendFileSync(file, line);
  else NodeProcess.stdout.write(line);
};

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

const verify = async () => {
  if (NodeProcess.env.GITHUB_EVENT_NAME !== "push") {
    writeOutput("short_circuit", "false");
    writeSummary("Running the checks. Tree evidence is only reused on a fork/dev push.");
    return;
  }
  const repository = NodeProcess.env.GITHUB_REPOSITORY;
  if (!repository) throw new Error("GITHUB_REPOSITORY is required");
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
  const reason = shortCircuitReason({
    pushTree,
    pushWorkflowBlob,
    evidence,
    run,
    parentSha,
  });
  writeOutput("short_circuit", reason === null ? "true" : "false");
  writeSummary(
    reason === null
      ? `Short circuit. This push is tree \`${pushTree}\`, already tested by pull request run ${run?.id}.`
      : `Running the checks. ${reason}.`,
  );
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
    writeOutput("short_circuit", "false");
    writeSummary(`Running the checks. ${message}.`);
    NodeProcess.exit(0);
  }
  NodeProcess.stderr.write(`${message}\n`);
  NodeProcess.exit(1);
}
