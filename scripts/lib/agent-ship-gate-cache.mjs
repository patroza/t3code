/**
 * Persist the last HEAD SHA that passed the agent ship gate.
 * pre-push and `pnpm pr:ready` share this so the same commit is never double-paid.
 *
 * Path: `.run/agent-ship-gate.json` (under gitignored `.run/`).
 *
 * Checkpoints, cheapest first — each implies the ones before it:
 *   static   — `vp check` + `vpr typecheck` (what a draft / no-PR push pays)
 *   complete — plus `vp run test` (ready PR / publish)
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";

export const SHIP_GATE_CACHE_REL = NodePath.join(".run", "agent-ship-gate.json");

/** @param {string} [root] */
export const shipGateCachePath = (root = NodeProcess.cwd()) =>
  NodePath.join(root, SHIP_GATE_CACHE_REL);

/**
 * @param {string} [root]
 * @param {{ runGit?: (args: string[], opts: { cwd: string }) => { status: number | null, stdout: string } }} [opts]
 * @returns {string | null} full SHA or null
 */
export const readHeadSha = (root = NodeProcess.cwd(), opts = {}) => {
  const runGit =
    opts.runGit ??
    ((args, runOpts) => {
      const result = NodeChildProcess.spawnSync("git", args, {
        encoding: "utf8",
        cwd: runOpts.cwd,
        shell: false,
      });
      return { status: result.status, stdout: result.stdout ?? "" };
    });
  const result = runGit(["rev-parse", "HEAD"], { cwd: root });
  if (result.status !== 0) return null;
  const sha = String(result.stdout).trim();
  return /^[0-9a-f]{40}$/i.test(sha) ? sha.toLowerCase() : null;
};

export const SHIP_GATE_STAGES = ["static", "complete"];

/**
 * @param {string} [root]
 * @param {{ readFileSync?: typeof NodeFS.readFileSync }} [opts]
 * @returns {{ sha?: string, validatedAt?: string, staticSha?: string, staticAt?: string } | null}
 */
export const readShipGateCache = (root = NodeProcess.cwd(), opts = {}) => {
  const readFileSync = opts.readFileSync ?? NodeFS.readFileSync;
  const file = shipGateCachePath(root);
  const readSha = (value) => {
    const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
    return /^[0-9a-f]{40}$/i.test(normalized) ? normalized : undefined;
  };
  try {
    const raw = readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    const sha = readSha(parsed?.sha);
    // Legacy caches only had `sha` meaning full complete; treat as both stages.
    const staticSha = readSha(parsed?.staticSha) ?? sha;
    if (!sha && !staticSha) return null;
    return {
      sha,
      validatedAt: typeof parsed.validatedAt === "string" ? parsed.validatedAt : undefined,
      staticSha,
      staticAt:
        typeof parsed.staticAt === "string"
          ? parsed.staticAt
          : typeof parsed.validatedAt === "string"
            ? parsed.validatedAt
            : undefined,
    };
  } catch {
    return null;
  }
};

/**
 * Highest checkpoint the cache records for `headSha`, as an index into
 * SHIP_GATE_STAGES; -1 when the cache describes another commit.
 * @param {string | null | undefined} headSha
 * @param {{ sha?: string, staticSha?: string } | null | undefined} cache
 */
export const cachedStage = (headSha, cache) => {
  if (!headSha || !cache) return -1;
  const h = headSha.toLowerCase();
  if (cache.sha && cache.sha.toLowerCase() === h) return SHIP_GATE_STAGES.indexOf("complete");
  if (cache.staticSha && cache.staticSha.toLowerCase() === h)
    return SHIP_GATE_STAGES.indexOf("static");
  return -1;
};

/**
 * @param {string} root
 * @param {string} sha
 * @param {{
 *   stage?: "static" | "complete"
 *   writeFileSync?: typeof NodeFS.writeFileSync
 *   mkdirSync?: typeof NodeFS.mkdirSync
 *   readFileSync?: typeof NodeFS.readFileSync
 *   now?: () => Date
 * }} [opts]
 */
export const writeShipGateCache = (root, sha, opts = {}) => {
  const writeFileSync = opts.writeFileSync ?? NodeFS.writeFileSync;
  const mkdirSync = opts.mkdirSync ?? NodeFS.mkdirSync;
  const now = opts.now ?? (() => new Date());
  const stage = opts.stage ?? "complete";
  const normalized = String(sha).trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/i.test(normalized)) {
    throw new Error(`writeShipGateCache: invalid sha ${sha}`);
  }
  // Never demote the same commit: a draft push (static) landing after a full
  // run would otherwise make the next publish re-pay tests it already passed.
  if (SHIP_GATE_STAGES.indexOf(stage) < cachedStage(normalized, readShipGateCache(root, opts))) {
    return;
  }
  const file = shipGateCachePath(root);
  const at = now().toISOString();
  const existing = readShipGateCache(root, opts) ?? {};
  const value =
    stage === "static"
      ? {
          ...existing,
          staticSha: normalized,
          staticAt: at,
        }
      : {
          sha: normalized,
          validatedAt: at,
          staticSha: normalized,
          staticAt: existing.staticAt ?? at,
        };
  mkdirSync(NodePath.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

/**
 * Full gate (check + typecheck + test) already passed for this SHA.
 * @param {string | null | undefined} headSha
 * @param {{ sha?: string } | null | undefined} cache
 */
export const isShipGateShaCached = (headSha, cache) => {
  if (!headSha || !cache?.sha) return false;
  return headSha.toLowerCase() === cache.sha.toLowerCase();
};

/**
 * Static gate (check + typecheck) already passed for this SHA.
 * Full cache also satisfies static.
 * @param {string | null | undefined} headSha
 * @param {{ sha?: string, staticSha?: string } | null | undefined} cache
 */
export const isShipGateStaticCached = (headSha, cache) => {
  if (!headSha || !cache) return false;
  const h = headSha.toLowerCase();
  if (cache.sha && cache.sha.toLowerCase() === h) return true;
  if (cache.staticSha && cache.staticSha.toLowerCase() === h) return true;
  return false;
};

/**
 * Force re-run even when SHA is cached.
 * @param {NodeJS.ProcessEnv} [env]
 */
export const isShipGateForce = (env = NodeProcess.env) => {
  const v = env["AGENT_SHIP_GATE_FORCE"];
  if (v == null || v === "") return false;
  const s = String(v).toLowerCase();
  return s !== "0" && s !== "false" && s !== "no" && s !== "off";
};
