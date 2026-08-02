#!/usr/bin/env node
/**
 * Husky pre-push entry for coding agents only.
 *
 * Humans: no-op (exit 0) — self-responsible; not forced by the hook.
 *
 * Agents:
 *   - Draft PR or no open PR: static gate only — steps 1–2 below.
 *     A push that does not lint/typecheck helps nobody, draft or not; what
 *     draft buys is skipping the unit suite, not skipping correctness.
 *   - Ready-for-review PR (or unknown PR state): full ship gate (1–3).
 *   - Publish path is `pnpm pr:ready` (not raw `gh pr ready`) — same full gate,
 *     then undraft. See scripts/agent-pr-ready.mjs + scripts/agent-gh.mjs.
 *
 * Ship gate mirrors the CI JS quality path:
 *   1. `vp check` — format + lint
 *   2. `vpr typecheck` — workspace TypeScript
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
 * Agent ship gate: static (check + typecheck) and optionally full (+ unit tests).
 * Shared by pre-push (every agent push) and `pnpm pr:ready`.
 *
 * `scope: "static"` stops after typecheck — draft / no-PR pushes.
 * `scope: "full"` (default) adds `vp run test` — ready PRs and publish.
 *
 * Caches HEAD SHA under `.run/agent-ship-gate.json` so push + ready never
 * double-run for an already-validated commit. Force: AGENT_SHIP_GATE_FORCE=1.
 *
 * @param {{ root?: string, scope?: "full" | "static", force?: boolean, env?: NodeJS.ProcessEnv }} [opts]
 * @returns {Promise<{ status: "cached" | "ok", sha: string | null, scope: "full" | "static" }>}
 */
export const runAgentShipGate = async (opts = {}) => {
  const root = opts.root ?? NodeProcess.cwd();
  const env = withRepoBin(root, opts.env ?? NodeProcess.env);
  const force = opts.force === true || isShipGateForce(env);
  const scope = opts.scope === "static" ? "static" : "full";
  const headSha = readHeadSha(root);
  const cache = readShipGateCache(root);

  const alreadyCached =
    scope === "static"
      ? !force && headSha && isShipGateStaticCached(headSha, cache)
      : !force && headSha && isShipGateShaCached(headSha, cache);

  if (alreadyCached) {
    console.error(
      `agent ship-gate: skip — ${headSha.slice(0, 12)} already validated${
        scope === "static" ? " (static)" : ""
      } (cache .run/agent-ship-gate.json; force with AGENT_SHIP_GATE_FORCE=1)`,
    );
    return { status: "cached", sha: headSha, scope };
  }

  const staticCached = !force && headSha && isShipGateStaticCached(headSha, cache);

  // Mirror CI check + typecheck (always). Unit tests only on full scope.
  if (staticCached) {
    console.error(
      `agent ship-gate: skip check/typecheck — ${headSha.slice(0, 12)} already passed static`,
    );
  } else {
    run("vp check", ["vp", "check"], { cwd: root, env });
    run("vpr typecheck", ["vpr", "typecheck"], { cwd: root, env });
  }

  if (scope === "static") {
    if (headSha) {
      try {
        writeShipGateCache(root, headSha, { stage: "static" });
        console.error(
          `agent ship-gate: cached static ${headSha.slice(0, 12)} (.run/agent-ship-gate.json)`,
        );
      } catch (error) {
        console.error(`agent ship-gate: could not write static cache: ${error?.message ?? error}`);
      }
    }
    console.error(
      "agent ship-gate: static ok — unit tests run on ready / publish (`pnpm pr:ready`)",
    );
    return { status: "ok", sha: headSha, scope };
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

  if (scope === "static") {
    const why =
      prState.mode === "draft"
        ? `draft PR${prState.pr?.number != null ? ` #${prState.pr.number}` : ""}`
        : "no open PR";
    console.error(
      `agent pre-push: ${why} — static gate only (check + typecheck; unit tests on publish via pnpm pr:ready)`,
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
