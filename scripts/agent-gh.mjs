#!/usr/bin/env node
/**
 * Agent-facing `gh` policy shim.
 *
 * Installed at `.tools/bin/gh` by `scripts/install-git-hooks.mjs`.
 * When coding-agent env markers are set, blocks undraft side channels
 * (`gh pr ready`, ready_for_review API). Use `pnpm pr:ready` instead
 * (sets AGENT_PR_SHIP=1 for the real call).
 *
 * Humans / non-agents: transparent pass-through to the next `gh` on PATH.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";
import { isCodingAgent } from "./lib/agent-env.mjs";
import { findRealGh, inspectAgentGhCommand } from "./lib/agent-gh-policy.mjs";

const selfPath = NodeURL.fileURLToPath(import.meta.url);
const argv = NodeProcess.argv.slice(2);

if (isCodingAgent()) {
  const decision = inspectAgentGhCommand(argv);
  if (decision.blocked) {
    console.error(`agent gh: blocked: ${decision.reason}`);
    NodeProcess.exit(1);
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

const result = NodeChildProcess.spawnSync(realGh, argv, {
  stdio: "inherit",
  env,
  shell: false,
});
NodeProcess.exit(result.status === null ? 1 : result.status);
