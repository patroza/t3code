#!/usr/bin/env node
/**
 * Husky pre-push entry for coding agents only.
 *
 * Humans: no-op (exit 0) — self-responsible; not forced by the hook.
 *
 * Agents:
 *   - Draft PR or no open PR: changed-file `vp check` only (fmt + lint of
 *     files changed against fork/dev). Commits already pay lint-staged.
 *   - Ready-for-review PR (or unknown PR state): full ship gate (1–3).
 *   - Publish path is `pnpm pr:ready` (not raw `gh pr ready`) — catch up to
 *     fork/dev, run the full gate, then undraft.
 *     See scripts/agent-pr-ready.mjs + scripts/agent-gh.mjs.
 *
 * Ship gate mirrors the CI JS quality path:
 *   1. `vp check` — format + lint (changed files on draft; workspace on full)
 *   2. `vpr typecheck` — workspace TypeScript (full / publish only)
 *   3. `vp run test` — unit tests (full / publish only)
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
import { listChangedFilesAgainstForkDev } from "./lib/agent-fork-dev.mjs";
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
 * The gate shells out to `vp` / `vpr`, which live in the repository's
 * `node_modules/.bin`. pnpm and husky both put that on PATH, so every historical
 * caller happened to work and the dependency stayed invisible — until the `gh`
 * shim started running the gate from a bare process, where `vpr typecheck` died
 * with "command not found". Make the gate supply its own PATH so it does not
 * depend on how it was invoked.
 *
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
 * Agent ship gate. Shared by pre-push and `pnpm pr:ready`.
 *
 * `scope: "changed"` — `vp check` on files changed against fork/dev (draft / no-PR).
 * `scope: "full"` (default) — workspace `vp check` + `vpr typecheck` + `vp run test`.
 *
 * Caches HEAD SHA under `.run/agent-ship-gate.json` so a full run is never
 * double-paid for the same commit. Changed-file runs are not cached as full.
 * Force: AGENT_SHIP_GATE_FORCE=1.
 *
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
    const files = listChangedFilesAgainstForkDev({ cwd: root });
    if (files.length === 0) {
      console.error("agent ship-gate: no files changed against fork/dev — skip");
      return { status: "ok", sha: headSha, scope };
    }
    run("vp check (changed)", ["vp", "check", "--no-error-on-unmatched-pattern", ...files], {
      cwd: root,
      env,
    });
    console.error(
      `agent ship-gate: changed ok — ${files.length} file${files.length === 1 ? "" : "s"}; full gate on publish`,
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
      `agent pre-push: ${why} — changed-file check only (full gate on publish via pnpm pr:ready)`,
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
