import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { assert, describe, it } from "@effect/vitest";

import { CI_PARITY_STEPS, TEST_STEPS } from "./agent-pre-push.mjs";
import { postLocalProof, postLocalProofAfterPush, pushesHead } from "./lib/agent-local-proof.mjs";
import {
  LOCAL_PROOF_CONTEXT,
  LOCAL_PROOF_VERSION,
  formatLocalProof,
  localProofDecision,
  parseLocalProof,
  trustedActors,
} from "./lib/fork-ci-local-proof.mjs";
import {
  FORK_CI_WORKFLOW,
  REQUIRED_FORK_CI_JOBS,
  formatTreeEvidence,
  mobileStaticAnalysisRequired,
  shortCircuitReason,
} from "./lib/fork-ci-tree-evidence.mjs";

const TREE = "d77ff0e87b5b9335cd2008b27f19b78ac1fa2295";
const OTHER_TREE = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BLOB = "9145e9bd028d6a07302c8f7a99d02cc33f528229";
const OTHER_BLOB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SHA = "27069e6cd29b922ac193f810deca35bf1157c349";

const trusted = trustedActors("patroza", "t3-agent[bot]");

const status = (patch = {}) => ({
  context: LOCAL_PROOF_CONTEXT,
  state: "success",
  description: formatLocalProof({ tree: TREE, workflowBlob: BLOB, machine: "devbox" }),
  creator: { login: "patroza" },
  ...patch,
});

const decide = (statuses, patch = {}) =>
  localProofDecision({ statuses, tree: TREE, workflowBlob: BLOB, trusted, ...patch });

describe("local proof", () => {
  it("round-trips tree, workflow blob, version, and a sanitized machine name", () => {
    const description = formatLocalProof({
      tree: TREE,
      workflowBlob: BLOB,
      machine: "pat's box",
    });
    assert.isAtMost(description.length, 140);
    assert.deepStrictEqual(parseLocalProof(description), {
      version: LOCAL_PROOF_VERSION,
      tree: TREE,
      workflowBlob: BLOB,
      machine: "pat-s-box",
    });
    assert.equal(parseLocalProof(`tree ${TREE} workflow ${BLOB}`), null);
  });

  it("skips only for a trusted proof of this tree, workflow, and format", () => {
    assert.equal(decide([status()]).proven, true);
    assert.equal(decide([status({ creator: { login: "T3-Agent[bot]" } })]).proven, true);
    assert.deepStrictEqual(decide([status()], { tree: OTHER_TREE }), {
      proven: false,
      reason: "local proof is for another tree",
    });
    assert.deepStrictEqual(decide([status()], { workflowBlob: OTHER_BLOB }), {
      proven: false,
      reason: "local proof is for another fork-ci.yml",
    });
    const oldFormat = status({ description: `v0 tree ${TREE} workflow ${BLOB}` });
    assert.equal(decide([oldFormat]).proven, false);
    assert.deepStrictEqual(decide([]), { proven: false, reason: "no local proof" });
    assert.deepStrictEqual(decide([{ ...status(), context: "fork-ci/tree" }]), {
      proven: false,
      reason: "no local proof",
    });
  });

  it("ignores untrusted creators, including the workflow token's bot", () => {
    assert.deepStrictEqual(decide([status({ creator: { login: "mallory" } })]), {
      proven: false,
      reason: "local proof only from untrusted mallory",
    });
    const actionsTrusted = trustedActors("patroza", "github-actions[bot], t3-agent[bot]");
    assert.equal(actionsTrusted.has("github-actions[bot]"), false);
    assert.equal(
      decide([status({ creator: { login: "github-actions[bot]" } })], { trusted: actionsTrusted })
        .proven,
      false,
    );
    // An untrusted status cannot shadow, or revoke, the trusted one beneath it.
    const untrustedFailure = status({ state: "failure", creator: { login: "mallory" } });
    assert.equal(decide([untrustedFailure, status()]).proven, true);
  });

  it("lets a trusted creator revoke a proof by posting a newer failure", () => {
    assert.deepStrictEqual(decide([status({ state: "failure" }), status()]), {
      proven: false,
      reason: "latest local proof is failure",
    });
  });
});

describe("mobile static analysis path filter", () => {
  it("runs only for diffs that touch what it lints", () => {
    assert.equal(mobileStaticAnalysisRequired(["apps/web/src/a.ts", "docs/x.md"]), false);
    assert.equal(mobileStaticAnalysisRequired([]), false);
    for (const path of [
      "apps/mobile/modules/foo/ios/Foo.swift",
      "apps/mobile/Brewfile",
      "scripts/mobile-native-static-check.ts",
      FORK_CI_WORKFLOW,
      "package.json",
      "pnpm-lock.yaml",
    ]) {
      assert.equal(mobileStaticAnalysisRequired([path]), true, path);
    }
    assert.equal(mobileStaticAnalysisRequired(null), true);
  });

  it("lets a push reuse tree evidence from a run that skipped mobile only when the push skips it too", () => {
    const jobs = REQUIRED_FORK_CI_JOBS.map((name) => ({
      name,
      conclusion: name === "Mobile Native Static Analysis" ? "skipped" : "success",
      run_attempt: 1,
    }));
    const input = {
      pushTree: TREE,
      pushWorkflowBlob: BLOB,
      parentSha: SHA,
      evidence: {
        state: "success",
        description: formatTreeEvidence(TREE, BLOB),
        targetUrl: "https://github.com/patroza/t3code/actions/runs/1",
      },
      run: {
        id: 1,
        conclusion: "success",
        event: "pull_request",
        path: FORK_CI_WORKFLOW,
        headSha: SHA,
        jobs,
      },
    };
    assert.equal(shortCircuitReason({ ...input, mobileRequired: false }), null);
    assert.equal(
      shortCircuitReason({ ...input, mobileRequired: true }),
      "job Mobile Native Static Analysis was skipped",
    );
    assert.equal(shortCircuitReason(input), "job Mobile Native Static Analysis was skipped");
  });
});

describe("posting a local proof", () => {
  const runGit = (args) => {
    const key = args.join(" ");
    if (key === "remote get-url origin")
      return { status: 0, stdout: "git@github.com:patroza/t3code.git\n" };
    if (key === `rev-parse ${SHA}^{tree}`) return { status: 0, stdout: `${TREE}\n` };
    if (key === `rev-parse ${SHA}:${FORK_CI_WORKFLOW}`) return { status: 0, stdout: `${BLOB}\n` };
    return { status: 1, stdout: "" };
  };
  const fakeGh = ({ landsAfter = 0 } = {}) => {
    const calls = [];
    let lookups = 0;
    const runGh = (args) => {
      calls.push(args);
      if (args.includes("POST")) return { status: 0, stdout: "" };
      lookups += 1;
      return { status: lookups > landsAfter ? 0 : 1, stdout: "" };
    };
    return { calls, runGh };
  };

  it("posts a success status on the pushed commit with tree and workflow", () => {
    const gh = fakeGh();
    const result = postLocalProof({
      root: "/r",
      sha: SHA,
      env: {},
      machine: "devbox",
      runGit,
      runGh: gh.runGh,
    });
    assert.equal(result.posted, true);
    const post = gh.calls.find((args) => args.includes("POST"));
    assert.include(post, `repos/patroza/t3code/statuses/${SHA}`);
    assert.include(post, "state=success");
    assert.include(post, `context=${LOCAL_PROOF_CONTEXT}`);
    assert.include(
      post,
      `description=${formatLocalProof({ tree: TREE, workflowBlob: BLOB, machine: "devbox" })}`,
    );
  });

  it("does not post on a commit GitHub does not have, and waits for a push to land", async () => {
    const missing = fakeGh({ landsAfter: Infinity });
    const result = postLocalProof({ root: "/r", sha: SHA, env: {}, runGit, runGh: missing.runGh });
    assert.equal(result.posted, false);
    assert.equal(
      missing.calls.some((args) => args.includes("POST")),
      false,
    );

    const landing = fakeGh({ landsAfter: 2 });
    const waited = await postLocalProofAfterPush({
      root: "/r",
      sha: SHA,
      env: {},
      runGit,
      runGh: landing.runGh,
      sleep: async () => {},
    });
    assert.equal(waited.posted, true);
  });

  it("recognizes the hook stdin line that pushes HEAD", () => {
    const zero = "0".repeat(40);
    assert.equal(pushesHead(`refs/heads/x ${SHA} refs/heads/x ${zero}\n`, SHA), true);
    assert.equal(pushesHead(`refs/heads/x ${OTHER_TREE} refs/heads/x ${zero}\n`, SHA), false);
    assert.equal(pushesHead("", SHA), false);
  });
});

// A local proof skips Check and Test Packages, so every command they run must be one the full
// gate runs too. When this fails, add the step to CI_PARITY_STEPS and bump LOCAL_PROOF_VERSION.
describe("local gate covers the jobs a proof skips", () => {
  const workflow = NodeFS.readFileSync(
    NodePath.join(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..", FORK_CI_WORKFLOW),
    "utf8",
  );
  const jobRuns = (jobId) => {
    const start = workflow.indexOf(`\n  ${jobId}:\n`);
    assert.notEqual(start, -1, jobId);
    const next = workflow.slice(start + 1).search(/\n {2}[a-z_]+:\n/);
    const body = next === -1 ? workflow.slice(start) : workflow.slice(start, start + 1 + next);
    return [...body.matchAll(/\n {8}run: (?!\|)(.+)/g)].map((match) => match[1].trim());
  };
  // Covered by the gate's own vp check / vpr typecheck / TEST_STEPS, its committed PR asset
  // check, or machine setup a developer box already has.
  const coveredElsewhere = [
    "vp check",
    "vp run -r --cache --log labeled typecheck",
    "sudo apt-get update && sudo apt-get install -y libsecret-1-dev pkg-config",
  ];
  const quote = (arg) => (arg.startsWith("!") ? `'${arg}'` : arg);
  const parity = new Set(
    [...CI_PARITY_STEPS, ...TEST_STEPS].map(([, args]) => args.map(quote).join(" ")),
  );

  it.each(["check", "test_packages"])("mirrors every %s step", (jobId) => {
    const runs = jobRuns(jobId);
    assert.isAbove(runs.length, 0);
    for (const command of runs) {
      assert.ok(
        parity.has(command) || coveredElsewhere.includes(command),
        `${jobId} runs "${command}", which the local gate does not`,
      );
    }
  });

  it.each(["test_server", "test_web"])("runs every %s suite unsharded", (jobId) => {
    const suites = jobRuns(jobId)
      .filter((command) => command.startsWith("vp "))
      .map((command) => command.replace(/ --shard .*$/, ""));
    assert.isAbove(suites.length, 0);
    for (const command of suites) {
      assert.ok(parity.has(command), `${jobId} runs "${command}", which the local gate does not`);
    }
  });

  it("skips exactly the locally provable jobs on a local proof", () => {
    const gated = [
      ...workflow.matchAll(
        /\n {2}([a-z_]+):\n(?:(?!\n {2}[a-z_]+:\n)[\s\S])*?local_proof != 'true'/g,
      ),
    ].map((match) => match[1]);
    assert.deepStrictEqual(gated, ["check", "test_packages", "test_server", "test_web"]);
  });
});
