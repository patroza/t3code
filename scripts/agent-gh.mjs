#!/usr/bin/env node
/**
 * Agent-facing `gh` policy shim.
 *
 * Installed at `.tools/bin/gh` by `scripts/install-git-hooks.mjs`.
 *
 * When coding-agent env markers are set and the command would publish a PR
 * (`gh pr ready`, the ready_for_review APIs), the ship gate runs first and the
 * command then proceeds. Only a failing gate stops it — publishing is gated, not
 * forbidden. `pnpm pr:ready` remains the explicit path and is unchanged; it sets
 * AGENT_PR_SHIP=1 so the gate runs once, not twice.
 *
 * Humans / non-agents: transparent pass-through to the next `gh` on PATH.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";
import { isCodingAgent } from "./lib/agent-env.mjs";
import { findRealGh, requiresShipGate } from "./lib/agent-gh-policy.mjs";

const selfPath = NodeURL.fileURLToPath(import.meta.url);
const argv = NodeProcess.argv.slice(2);

let shipping = false;

if (isCodingAgent()) {
  const gate = requiresShipGate(argv);
  if (gate.required) {
    console.error(`agent gh: ${gate.reason}`);
    // Imported here rather than at module scope: `gh` is on the hot path for
    // ordinary commands and must not pay for the gate's dependencies to run
    // `gh pr view`.
    const { runAgentShipGate } = await import("./agent-pre-push.mjs");
    // Exits non-zero itself if any check fails, so a red gate stops the publish
    // and a green one falls through to the real `gh` below.
    await runAgentShipGate({ root: NodeProcess.cwd() });
    shipping = true;
  }
}

const realGh = findRealGh({ selfPath });
if (!realGh) {
  console.error("agent gh: could not resolve real `gh` binary (set AGENT_GH_REAL)");
  NodeProcess.exit(127);
}

// Avoid re-entering this shim if PATH still prefers us.
const env = { ...NodeProcess.env };
const toolsBin = NodePath.resolve(NodePath.dirname(selfPath), "..", ".tools", "bin");
const pathParts = (env["PATH"] ?? "").split(NodePath.delimiter).filter(Boolean);
env["PATH"] = pathParts.filter((p) => NodePath.resolve(p) !== toolsBin).join(NodePath.delimiter);
env["AGENT_GH_REAL"] = realGh;
// The gate passed, so anything this command spawns is already cleared to ship.
if (shipping) env["AGENT_PR_SHIP"] = "1";

const result = NodeChildProcess.spawnSync(realGh, argv, {
  stdio: "inherit",
  env,
  shell: false,
});
NodeProcess.exit(result.status === null ? 1 : result.status);
