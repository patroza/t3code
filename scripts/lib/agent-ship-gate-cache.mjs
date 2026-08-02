/**
 * Persist the last HEAD SHA that passed the agent ship gate.
 * pre-push and `pnpm pr:ready` share this so the same commit is never double-paid.
 *
 * Path: `.run/agent-ship-gate.json` (under gitignored `.run/`).
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

/**
 * @param {string} [root]
 * @param {{ readFileSync?: typeof NodeFS.readFileSync }} [opts]
 * @returns {{ sha: string, validatedAt?: string } | null}
 */
export const readShipGateCache = (root = NodeProcess.cwd(), opts = {}) => {
  const readFileSync = opts.readFileSync ?? NodeFS.readFileSync;
  const file = shipGateCachePath(root);
  try {
    const raw = readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    const sha = typeof parsed?.sha === "string" ? parsed.sha.trim().toLowerCase() : "";
    if (!/^[0-9a-f]{40}$/i.test(sha)) return null;
    return {
      sha,
      validatedAt: typeof parsed.validatedAt === "string" ? parsed.validatedAt : undefined,
    };
  } catch {
    return null;
  }
};

/**
 * @param {string} root
 * @param {string} sha
 * @param {{ writeFileSync?: typeof NodeFS.writeFileSync, mkdirSync?: typeof NodeFS.mkdirSync, now?: () => Date }} [opts]
 */
export const writeShipGateCache = (root, sha, opts = {}) => {
  const writeFileSync = opts.writeFileSync ?? NodeFS.writeFileSync;
  const mkdirSync = opts.mkdirSync ?? NodeFS.mkdirSync;
  const now = opts.now ?? (() => new Date());
  const normalized = String(sha).trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/i.test(normalized)) {
    throw new Error(`writeShipGateCache: invalid sha ${sha}`);
  }
  const file = shipGateCachePath(root);
  mkdirSync(NodePath.dirname(file), { recursive: true });
  writeFileSync(
    file,
    `${JSON.stringify({ sha: normalized, validatedAt: now().toISOString() }, null, 2)}\n`,
    "utf8",
  );
};

/**
 * @param {string | null | undefined} headSha
 * @param {{ sha: string } | null | undefined} cache
 */
export const isShipGateShaCached = (headSha, cache) => {
  if (!headSha || !cache?.sha) return false;
  return headSha.toLowerCase() === cache.sha.toLowerCase();
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
