import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { assert, describe, it } from "@effect/vitest";

import {
  FORK_CI_WORKFLOW,
  REQUIRED_FORK_CI_JOBS,
  formatTreeEvidence,
  latestJobConclusions,
  parseTreeEvidence,
  runIdFromEvidenceUrl,
  shortCircuitReason,
} from "./lib/fork-ci-tree-evidence.mjs";

const TREE = "d77ff0e87b5b9335cd2008b27f19b78ac1fa2295";
const OTHER_TREE = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BLOB = "9145e9bd028d6a07302c8f7a99d02cc33f528229";
const OTHER_BLOB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const PARENT = "27069e6cd29b922ac193f810deca35bf1157c349";

const succeededJobs = () =>
  REQUIRED_FORK_CI_JOBS.map((name) => ({ name, conclusion: "success", run_attempt: 1 }));

const matching = (patch = {}) => ({
  pushTree: TREE,
  pushWorkflowBlob: BLOB,
  parentSha: PARENT,
  evidence: {
    state: "success",
    description: formatTreeEvidence(TREE, BLOB),
    targetUrl: "https://github.com/patroza/t3code/actions/runs/44857914138",
  },
  run: {
    id: 44857914138,
    conclusion: "success",
    event: "pull_request",
    path: FORK_CI_WORKFLOW,
    headSha: PARENT,
    jobs: succeededJobs(),
  },
  ...patch,
});

describe("fork CI tree evidence", () => {
  it("parses only the two recorded ids", () => {
    assert.deepStrictEqual(parseTreeEvidence(formatTreeEvidence(TREE, BLOB)), {
      tree: TREE,
      workflowBlob: BLOB,
    });
    assert.equal(parseTreeEvidence(`${TREE} ${BLOB} extra`), null);
    assert.equal(parseTreeEvidence(TREE), null);
    assert.equal(runIdFromEvidenceUrl(matching().evidence.targetUrl), "44857914138");
    assert.equal(runIdFromEvidenceUrl("https://github.com/patroza/t3code/commit/abc"), null);
  });

  it("reuses a pull request run whose required jobs succeeded on this tree", () => {
    assert.equal(shortCircuitReason(matching()), null);
  });

  it("rejects a different tree, workflow file, or missing record", () => {
    assert.equal(
      shortCircuitReason(matching({ pushTree: OTHER_TREE })),
      "tree evidence does not match this push",
    );
    assert.equal(
      shortCircuitReason(matching({ pushWorkflowBlob: OTHER_BLOB })),
      "tree evidence does not match this push",
    );
    assert.equal(
      shortCircuitReason(matching({ evidence: null })),
      "pull request recorded no tree evidence",
    );
  });

  it("rejects a run that did not execute the checks", () => {
    assert.match(
      shortCircuitReason(
        matching({
          run: { ...matching().run, event: "push" },
        }),
      ) ?? "",
      /not a pull request/,
    );
    const jobs = succeededJobs().map((job) =>
      job.name === "Test Web" ? { ...job, conclusion: "skipped" } : job,
    );
    assert.equal(
      shortCircuitReason(matching({ run: { ...matching().run, jobs } })),
      "job Test Web was skipped",
    );
    assert.equal(
      shortCircuitReason(matching({ run: { ...matching().run, jobsTruncated: true } })),
      "job list was truncated",
    );
  });

  it("uses the latest attempt when a job was rerun", () => {
    const jobs = [
      ...succeededJobs(),
      { name: "Test Web", conclusion: "failure", run_attempt: 1 },
      { name: "Test Web", conclusion: "success", run_attempt: 2 },
    ];
    assert.equal(latestJobConclusions(jobs).get("Test Web")?.conclusion, "success");
    assert.equal(shortCircuitReason(matching({ run: { ...matching().run, jobs } })), null);
    const failedLatest = [
      { name: "Check", conclusion: "success", run_attempt: 1 },
      { name: "Check", conclusion: "failure", run_attempt: 2 },
    ];
    assert.equal(latestJobConclusions(failedLatest).get("Check")?.conclusion, "failure");
  });

  it("names the same required jobs the workflow runs", () => {
    const workflow = NodeFS.readFileSync(
      NodePath.join(
        NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
        "../.github/workflows/fork-ci.yml",
      ),
      "utf8",
    );
    for (const name of [
      "Check",
      "Test Packages",
      "Test Web",
      "Test",
      "Mobile Native Static Analysis",
      "Release Smoke",
    ]) {
      assert.equal(workflow.includes(`name: ${name}`), true, name);
    }
    assert.equal(workflow.includes("name: Test Server ${{ matrix.shard }}"), true);
    assert.equal(workflow.includes("shard: [1, 2, 3, 4, 5, 6]"), true);
    assert.equal(workflow.includes("name: Verify tree evidence"), true);
    assert.equal(workflow.includes("name: Record tree evidence"), true);
    assert.equal(workflow.includes("short_circuit != 'true'"), true);
  });
});
