#!/usr/bin/env node
/**
 * Agent (and human) publish path: run the ship gate, then mark the PR ready.
 *
 *   pnpm pr:ready
 *
 * This is the explicit path, not the only one: raw `gh pr ready` also runs the
 * gate, because the shim runs it before passing the command through. What this
 * adds is PR-state handling — a clear error when there is no open PR, and gate-
 * only behaviour when the PR is already ready. AGENT_PR_SHIP=1 below marks the
 * gate as already passed so the shim does not run it a second time.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeProcess from "node:process";
import { runAgentShipGate } from "./agent-pre-push.mjs";
import { resolveOpenPrState } from "./lib/agent-pr-state.mjs";

const root = NodeProcess.cwd();
const prState = resolveOpenPrState({ cwd: root });

if (prState.mode === "none") {
  console.error(
    "agent pr:ready: no open PR for this branch — open a draft first (`gh pr create --draft`)",
  );
  NodeProcess.exit(1);
}

if (prState.mode === "unknown") {
  console.error(`agent pr:ready: cannot resolve PR state (${prState.detail ?? "gh failed"})`);
  NodeProcess.exit(1);
}

if (prState.mode === "ready") {
  console.error(
    `agent pr:ready: PR${prState.pr?.number != null ? ` #${prState.pr.number}` : ""} is already ready — running ship gate only`,
  );
  await runAgentShipGate({ root });
  NodeProcess.exit(0);
}

// draft → gate then undraft
console.error(
  `agent pr:ready: ship gate then ready PR${prState.pr?.number != null ? ` #${prState.pr.number}` : ""}`,
);
await runAgentShipGate({ root });

const env = { ...NodeProcess.env, AGENT_PR_SHIP: "1" };
const readyArgs =
  prState.pr?.number != null ? ["pr", "ready", String(prState.pr.number)] : ["pr", "ready"];

console.error("agent pr:ready: marking PR ready for review");
const result = NodeChildProcess.spawnSync("gh", readyArgs, {
  stdio: "inherit",
  cwd: root,
  env,
  shell: false,
});
const status = result.status === null ? 1 : result.status;
if (status !== 0) {
  console.error(`agent pr:ready: gh pr ready failed (exit ${status})`);
  NodeProcess.exit(status);
}

console.error("agent pr:ready: ok — PR is ready; CI will run the full suite");
NodeProcess.exit(0);
