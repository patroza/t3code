/** A fork/dev push may reuse a pull request run only when this returns null. */

export const TREE_EVIDENCE_CONTEXT = "fork-ci/tree";
export const FORK_CI_WORKFLOW = ".github/workflows/fork-ci.yml";

/** Job names Fork CI must have run, not skipped, before a later push can reuse them. */
export const REQUIRED_FORK_CI_JOBS = Object.freeze([
  "Check",
  "Test Packages",
  "Test Server 1",
  "Test Server 2",
  "Test Server 3",
  "Test Server 4",
  "Test Server 5",
  "Test Server 6",
  "Test Web",
  "Test",
  "Mobile Native Static Analysis",
  "Release Smoke",
]);

/**
 * @param {string} tree
 * @param {string} workflowBlob
 */
export const formatTreeEvidence = (tree, workflowBlob) => `${tree} ${workflowBlob}`;

/**
 * @param {string | null | undefined} description
 * @returns {{ tree: string, workflowBlob: string } | null}
 */
export const parseTreeEvidence = (description) => {
  const match = /^([0-9a-f]{40}) ([0-9a-f]{40})$/.exec(description ?? "");
  if (!match) return null;
  return { tree: match[1], workflowBlob: match[2] };
};

/**
 * @param {string | null | undefined} url
 * @returns {string | null}
 */
export const runIdFromEvidenceUrl = (url) => {
  const match = /\/actions\/runs\/(\d+)(?:\b|\/|$)/.exec(url ?? "");
  return match?.[1] ?? null;
};

/**
 * A rerun lists more than one attempt. Only the highest attempt counts.
 * @param {ReadonlyArray<{ name?: string, conclusion?: string, run_attempt?: number, runAttempt?: number }>} jobs
 */
export const latestJobConclusions = (jobs) => {
  /** @type {Map<string, { attempt: number, conclusion: string }>} */
  const byName = new Map();
  for (const job of jobs) {
    const name = job?.name;
    if (typeof name !== "string" || name.length === 0) continue;
    const attempt = Number(job.run_attempt ?? job.runAttempt ?? 0);
    const previous = byName.get(name);
    if (!previous || attempt >= previous.attempt) {
      byName.set(name, { attempt, conclusion: job.conclusion ?? "" });
    }
  }
  return byName;
};

/** @returns {string | null} Why the checks must run, or null when the push may skip them. */
export const shortCircuitReason = (input) => {
  const parsed = input.evidence ? parseTreeEvidence(input.evidence.description) : null;
  if (!input.evidence || input.evidence.state !== "success" || !parsed) {
    return "pull request recorded no tree evidence";
  }
  if (parsed.tree !== input.pushTree || parsed.workflowBlob !== input.pushWorkflowBlob) {
    return "tree evidence does not match this push";
  }
  const evidenceRunId = runIdFromEvidenceUrl(input.evidence.targetUrl);
  if (!input.run || evidenceRunId == null || String(input.run.id) !== evidenceRunId) {
    return "tree evidence does not name the successful run";
  }
  if (input.run.headSha !== input.parentSha) {
    return "evidence run is for a different commit";
  }
  if (input.run.conclusion !== "success") return "evidence run did not succeed";
  if (input.run.event !== "pull_request") return "evidence run was not a pull request";
  if (input.run.path !== FORK_CI_WORKFLOW) return "evidence run used a different workflow";
  if (input.run.jobsTruncated) return "job list was truncated";
  const conclusions = latestJobConclusions(input.run.jobs);
  for (const name of REQUIRED_FORK_CI_JOBS) {
    const conclusion = conclusions.get(name)?.conclusion;
    if (conclusion !== "success") {
      return `job ${name} was ${conclusion ?? "missing"}`;
    }
  }
  return null;
};
