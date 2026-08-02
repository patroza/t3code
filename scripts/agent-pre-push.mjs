#!/usr/bin/env node
/**
 * Husky pre-push entry for coding agents only.
 *
 * Humans: no-op (exit 0) — self-responsible; not forced by the hook.
 *
 * Agents:
 *   - Draft PR or no open PR: free push (GitHub Diff UI / early share).
 *   - Ready-for-review PR (or unknown PR state): ship gate below.
 *   - Publish path is `pnpm pr:ready` (not raw `gh pr ready`) — same gate,
 *     then undraft. See scripts/agent-pr-ready.mjs + scripts/agent-gh.mjs.
 *
 * Ship gate (when enforced) mirrors the CI JS quality path:
 *   1. `vp check` — format + lint
 *   2. `vpr typecheck` — workspace TypeScript
 *   3. `vp run test` — unit tests
 *
 * Detection: GROK_AGENT / T3_AGENT / AI_AGENT / Claude / Cursor / Codex env.
 * Humans only: SKIP_AGENT_PREPUSH=1 git push
 * Agents must never set that flag or use git push --no-verify.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";
import { isCodingAgent } from "./lib/agent-env.mjs";
import { resolveOpenPrState, shouldRunShipGateOnPush } from "./lib/agent-pr-state.mjs";
import {
  isShipGateForce,
  isShipGateShaCached,
  readHeadSha,
  readShipGateCache,
  writeShipGateCache,
} from "./lib/agent-ship-gate-cache.mjs";

export { isCodingAgent };

const run = (label, args, opts = {}) => {
  console.error(`agent ship-gate: ${label}`);
  const result = NodeChildProcess.spawnSync(args[0], args.slice(1), {
    stdio: "inherit",
    shell: true,
    cwd: opts.cwd ?? NodeProcess.cwd(),
    env: opts.env ?? NodeProcess.env,
  });
  const status = result.status === null ? 1 : result.status;
  if (status !== 0) {
    console.error(`agent ship-gate: failed: ${label} (exit ${status})`);
    NodeProcess.exit(status);
  }
};

/**
 * Full agent ship gate: check + typecheck + unit tests.
 * Shared by pre-push (ready PRs) and `pnpm pr:ready`.
 * Caches HEAD SHA under `.run/agent-ship-gate.json` so push + ready never
 * double-run for an already-validated commit. Force: AGENT_SHIP_GATE_FORCE=1.
 *
 * @param {{ root?: string, force?: boolean, env?: NodeJS.ProcessEnv }} [opts]
 * @returns {Promise<{ status: "cached" | "ok", sha: string | null }>}
 */
export const runAgentShipGate = async (opts = {}) => {
  const root = opts.root ?? NodeProcess.cwd();
  const env = opts.env ?? NodeProcess.env;
  const force = opts.force === true || isShipGateForce(env);
  const headSha = readHeadSha(root);

  if (!force && headSha && isShipGateShaCached(headSha, readShipGateCache(root))) {
    console.error(
      `agent ship-gate: skip — ${headSha.slice(0, 12)} already validated (cache .run/agent-ship-gate.json; force with AGENT_SHIP_GATE_FORCE=1)`,
    );
    return { status: "cached", sha: headSha };
  }

  // Mirror CI check + test jobs (JS path). Cargo/mobile/desktop builds stay CI-only.
  run("vp check", ["vp", "check"], { cwd: root, env });
  run("vpr typecheck", ["vpr", "typecheck"], { cwd: root, env });
  run("vp run test", ["vp", "run", "test"], { cwd: root, env });

  if (headSha) {
    try {
      writeShipGateCache(root, headSha);
      console.error(`agent ship-gate: cached ${headSha.slice(0, 12)} (.run/agent-ship-gate.json)`);
    } catch (error) {
      console.error(`agent ship-gate: could not write cache: ${error?.message ?? error}`);
    }
  }

  console.error("agent ship-gate: ok");
  return { status: "ok", sha: headSha };
};

const thisFile = NodeURL.fileURLToPath(import.meta.url);
const invokedAs = NodeProcess.argv[1] ? NodePath.resolve(NodeProcess.argv[1]) : "";

if (invokedAs === thisFile) {
  if (!isCodingAgent()) {
    NodeProcess.exit(0);
  }

  const root = NodeProcess.cwd();
  const prState = resolveOpenPrState({ cwd: root });

  if (!shouldRunShipGateOnPush(prState.mode)) {
    const why =
      prState.mode === "draft"
        ? `draft PR${prState.pr?.number != null ? ` #${prState.pr.number}` : ""} — free push (ship gate runs on publish via pnpm pr:ready)`
        : "no open PR — free push (open a draft to share; ship gate on ready PRs / pnpm pr:ready)";
    console.error(`agent pre-push: skip ship gate (${why})`);
    NodeProcess.exit(0);
  }

  if (prState.mode === "unknown") {
    console.error(
      `agent pre-push: PR state unknown (${prState.detail ?? "gh failed"}) — fail closed, running ship gate`,
    );
  } else {
    console.error(
      `agent pre-push: ready PR${prState.pr?.number != null ? ` #${prState.pr.number}` : ""} — running ship gate`,
    );
  }

  await runAgentShipGate({ root });
  NodeProcess.exit(0);
}
