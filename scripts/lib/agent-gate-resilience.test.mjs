import { assert, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { failedTestFiles, runWithFlakyRerun, shouldDetachGate } from "./agent-gate-resilience.mjs";

const resilienceModule = new URL("./agent-gate-resilience.mjs", import.meta.url).href;

// A stand-in for `vp test run`: each call appends its file arguments to calls.json, writes a JSON
// report when asked for one, and exits with the next code from the plan.
const FAKE_VITEST = `
const fs = require("node:fs");
const [state, ...args] = process.argv.slice(2);
const plan = JSON.parse(fs.readFileSync(state + ".plan", "utf8"));
const calls = fs.existsSync(state) ? JSON.parse(fs.readFileSync(state, "utf8")) : [];
const step = plan[calls.length];
calls.push(args.filter((arg) => !arg.startsWith("--")));
fs.writeFileSync(state, JSON.stringify(calls));
const output = args.find((arg) => arg.startsWith("--outputFile.json="));
if (output && step.report) fs.writeFileSync(output.slice(18), JSON.stringify(step.report));
process.exit(step.code);
`;

const fakeStep = (plan) => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-gate-rerun-"));
  const script = NodePath.join(dir, "fake-vitest.cjs");
  const state = NodePath.join(dir, "calls.json");
  NodeFS.writeFileSync(script, FAKE_VITEST);
  NodeFS.writeFileSync(`${state}.plan`, JSON.stringify(plan));
  const status = runWithFlakyRerun({
    label: "test web browser",
    args: [process.execPath, script, state],
    cwd: dir,
    env: process.env,
    reportPath: NodePath.join(dir, "report.json"),
  });
  const calls = JSON.parse(NodeFS.readFileSync(state, "utf8"));
  NodeFS.rmSync(dir, { recursive: true, force: true });
  return { status, calls, dir };
};

it("names failed and unimportable files from a Vitest JSON report", () => {
  assert.deepStrictEqual(
    failedTestFiles({
      testResults: [
        { name: "/w/a.browser.test.tsx", status: "passed" },
        { name: "/w/b.browser.test.tsx", status: "failed" },
        { name: "/w/c.browser.test.tsx", status: "failed" },
      ],
    }),
    ["/w/b.browser.test.tsx", "/w/c.browser.test.tsx"],
  );
  assert.deepStrictEqual(failedTestFiles(null), []);
});

it("reruns only the failed files once and passes when they pass", () => {
  const { status, calls, dir } = fakeStep([
    { code: 1, report: { testResults: [{ name: "/w/b.browser.test.tsx", status: "failed" }] } },
    { code: 0 },
  ]);
  assert.strictEqual(status, 0);
  assert.deepStrictEqual(calls, [[], [NodePath.relative(dir, "/w/b.browser.test.tsx")]]);
});

it("fails when every rerun fails", () => {
  const failing = {
    code: 1,
    report: { testResults: [{ name: "/w/b.browser.test.tsx", status: "failed" }] },
  };
  const { status, calls } = fakeStep([failing, failing, failing]);
  assert.strictEqual(status, 1);
  assert.strictEqual(calls.length, 3);
});

it("after a crash, reruns the whole step and then only the file that run failed", () => {
  const { status, calls, dir } = fakeStep([
    { code: 1 },
    { code: 1, report: { testResults: [{ name: "/w/u.browser.test.tsx", status: "failed" }] } },
    { code: 0 },
  ]);
  assert.strictEqual(status, 0);
  assert.deepStrictEqual(calls, [[], [], [NodePath.relative(dir, "/w/u.browser.test.tsx")]]);
});

it("never detaches in CI, when opted out, inside a detached gate, or off Linux", () => {
  assert.strictEqual(shouldDetachGate({ CI: "true" }, "linux"), false);
  assert.strictEqual(shouldDetachGate({ AGENT_SHIP_GATE_INLINE: "1" }, "linux"), false);
  assert.strictEqual(shouldDetachGate({ AGENT_SHIP_GATE_DETACHED: "1" }, "linux"), false);
  assert.strictEqual(shouldDetachGate({}, "darwin"), false);
});

it("a detached gate records its exit code and result for the caller", () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-gate-detached-"));
  const envPath = NodePath.join(dir, "env.json");
  const resultPath = NodePath.join(dir, "result.json");
  NodeFS.writeFileSync(envPath, JSON.stringify({ MARKER: "kept" }));
  const child = NodeChildProcess.spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const { enterDetachedGate } = await import(${JSON.stringify(resilienceModule)});
       const { env, recordGate } = enterDetachedGate({ envPath: ${JSON.stringify(envPath)}, resultPath: ${JSON.stringify(resultPath)} });
       recordGate({ marker: env.MARKER });
       process.exit(3);`,
    ],
    { encoding: "utf8" },
  );
  assert.strictEqual(child.status, 3, child.stderr);
  assert.deepStrictEqual(JSON.parse(NodeFS.readFileSync(resultPath, "utf8")), {
    code: 3,
    gate: { marker: "kept" },
  });
  assert.strictEqual(NodeFS.existsSync(envPath), false);
  NodeFS.rmSync(dir, { recursive: true, force: true });
});
