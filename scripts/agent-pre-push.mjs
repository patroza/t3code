#!/usr/bin/env node
/**
 * Agent pushes enforce changed or full validation by PR state; humans pass through unchanged.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";
import { isCodingAgent } from "./lib/agent-env.mjs";
import { filesForChangedShipCheck } from "./lib/agent-fork-dev.mjs";
import { resolveOpenPrState, shipGateScopeForPush } from "./lib/agent-pr-state.mjs";
import {
  isShipGateForce,
  isShipGateShaCached,
  isShipGateStaticCached,
  readHeadSha,
  readShipGateCache,
  writeShipGateCache,
} from "./lib/agent-ship-gate-cache.mjs";

export { isCodingAgent };

/**
 * Supply node_modules/.bin on PATH so direct shim calls can run vp and vpr.
 * @param {string} root
 * @param {NodeJS.ProcessEnv} env
 * @returns {NodeJS.ProcessEnv}
 */
const withRepoBin = (root, env) => {
  const repoBin = NodePath.join(root, "node_modules", ".bin");
  const current = (env["PATH"] ?? "").split(NodePath.delimiter).filter(Boolean);
  if (current.some((entry) => NodePath.resolve(entry) === repoBin)) return env;
  return { ...env, PATH: [repoBin, ...current].join(NodePath.delimiter) };
};

const run = (label, args, opts = {}) => {
  console.error(`agent ship-gate: ${label}`);
  const result = NodeChildProcess.spawnSync(args[0], args.slice(1), {
    stdio: "inherit",
    // File lists must not go through `sh -c` concatenation: a sync merge's
    // changed-file argv is large enough to E2BIG even after dropping `.repos/`.
    shell: opts.shell ?? true,
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
 * Cache full validation by HEAD; changed-file checks never count as a full gate. Force with AGENT_SHIP_GATE_FORCE.
 * @param {{ root?: string, scope?: "full" | "changed", force?: boolean, env?: NodeJS.ProcessEnv }} [opts]
 * @returns {Promise<{ status: "cached" | "ok", sha: string | null, scope: "full" | "changed" }>}
 */
export const runAgentShipGate = async (opts = {}) => {
  const root = opts.root ?? NodeProcess.cwd();
  const env = withRepoBin(root, opts.env ?? NodeProcess.env);
  const force = opts.force === true || isShipGateForce(env);
  const scope = opts.scope === "changed" || opts.scope === "static" ? "changed" : "full";
  const headSha = readHeadSha(root);
  const cache = readShipGateCache(root);

  if (scope === "changed") {
    const files = filesForChangedShipCheck({ cwd: root });
    if (files.length === 0) {
      console.error("agent ship-gate: no files changed against fork/dev — skip fmt/lint");
    } else {
      run("vp check (changed)", ["vp", "check", "--no-error-on-unmatched-pattern", ...files], {
        cwd: root,
        env,
        shell: false,
      });
    }
    run("vpr typecheck", ["vpr", "typecheck"], { cwd: root, env });
    console.error(
      `agent ship-gate: changed ok — ${files.length} file${files.length === 1 ? "" : "s"} + typecheck; full gate on publish`,
    );
    return { status: "ok", sha: headSha, scope };
  }

  const alreadyCached = !force && headSha && isShipGateShaCached(headSha, cache);

  if (alreadyCached) {
    console.error(
      `agent ship-gate: skip — ${headSha.slice(0, 12)} already validated (cache .run/agent-ship-gate.json; force with AGENT_SHIP_GATE_FORCE=1)`,
    );
    return { status: "cached", sha: headSha, scope };
  }

  const staticCached = !force && headSha && isShipGateStaticCached(headSha, cache);

  if (staticCached) {
    console.error(
      `agent ship-gate: skip check/typecheck — ${headSha.slice(0, 12)} already passed static`,
    );
  } else {
    run("vp check", ["vp", "check"], { cwd: root, env });
    run("vpr typecheck", ["vpr", "typecheck"], { cwd: root, env });
  }

  run("vp run test", ["vp", "run", "test"], { cwd: root, env });

  if (headSha) {
    try {
      writeShipGateCache(root, headSha, { stage: "complete" });
      console.error(`agent ship-gate: cached ${headSha.slice(0, 12)} (.run/agent-ship-gate.json)`);
    } catch (error) {
      console.error(`agent ship-gate: could not write cache: ${error?.message ?? error}`);
    }
  }

  console.error("agent ship-gate: ok");
  return { status: "ok", sha: headSha, scope };
};

const thisFile = NodeURL.fileURLToPath(import.meta.url);
const invokedAs = NodeProcess.argv[1] ? NodePath.resolve(NodeProcess.argv[1]) : "";

if (invokedAs === thisFile) {
  if (!isCodingAgent()) {
    NodeProcess.exit(0);
  }

  const root = NodeProcess.cwd();
  const prState = resolveOpenPrState({ cwd: root });
  const scope = shipGateScopeForPush(prState.mode);

  if (scope === "changed") {
    const why =
      prState.mode === "draft"
        ? `draft PR${prState.pr?.number != null ? ` #${prState.pr.number}` : ""}`
        : "no open PR";
    console.error(
      `agent pre-push: ${why} — changed-file check + typecheck (full gate on publish via pnpm pr:ready)`,
    );
  } else if (prState.mode === "unknown") {
    console.error(
      `agent pre-push: PR state unknown (${prState.detail ?? "gh failed"}) — fail closed, running full ship gate`,
    );
  } else {
    console.error(
      `agent pre-push: ready PR${prState.pr?.number != null ? ` #${prState.pr.number}` : ""} — running full ship gate`,
    );
  }

  await runAgentShipGate({ root, scope });
  NodeProcess.exit(0);
}
