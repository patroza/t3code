#!/usr/bin/env node
/**
 * Agent (and human) publish path: run the ship gate, then mark the PR ready.
 *
 *   pnpm pr:ready
 *
 * Agents must not call `gh pr ready` directly — the agent gh shim blocks it
 * unless AGENT_PR_SHIP=1 (set only here for the undraft step).
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
