/**
 * Cache validation of HEAD's tree in .run: static covers check/types; complete additionally
 * covers tests. Keyed by tree, not commit, so a rebase or merge that lands on the same tree
 * reuses the result; a dirty worktree is never cached.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";

export const SHIP_GATE_CACHE_REL = NodePath.join(".run", "agent-ship-gate.json");

/** @param {string} [root] */
export const shipGateCachePath = (root = NodeProcess.cwd()) =>
  NodePath.join(root, SHIP_GATE_CACHE_REL);

const defaultRunGit = (args, runOpts) => {
  const result = NodeChildProcess.spawnSync("git", args, {
    encoding: "utf8",
    cwd: runOpts.cwd,
    shell: false,
  });
  return { status: result.status, stdout: result.stdout ?? "" };
};

/**
 * @typedef {{ runGit?: (args: string[], opts: { cwd: string }) => { status: number | null, stdout: string } }} GitOpts
 */

/**
 * @param {string} root
 * @param {string} rev
 * @param {GitOpts} [opts]
 * @returns {string | null} full object id or null
 */
const revParse = (root, rev, opts = {}) => {
  const result = (opts.runGit ?? defaultRunGit)(["rev-parse", "--verify", "--quiet", rev], {
    cwd: root,
  });
  if (result.status !== 0) return null;
  const sha = String(result.stdout).trim();
  return /^[0-9a-f]{40}$/i.test(sha) ? sha.toLowerCase() : null;
};

/** @param {string} [root] @param {GitOpts} [opts] */
export const readHeadSha = (root = NodeProcess.cwd(), opts = {}) => revParse(root, "HEAD", opts);

/** @param {string} [root] @param {GitOpts} [opts] */
export const readHeadTree = (root = NodeProcess.cwd(), opts = {}) =>
  revParse(root, "HEAD^{tree}", opts);

/**
 * Untracked files count: a source file the gate imported but HEAD lacks would fail CI.
 * Ignored files (.run, node_modules, build output) do not.
 * @param {string} [root]
 * @param {GitOpts} [opts]
 */
export const isWorktreeClean = (root = NodeProcess.cwd(), opts = {}) => {
  const result = (opts.runGit ?? defaultRunGit)(["status", "--porcelain"], { cwd: root });
  return result.status === 0 && String(result.stdout).trim() === "";
};

/** Cache files written before the tree key (commit `sha`) are ignored. */
export const SHIP_GATE_CACHE_VERSION = 2;

export const SHIP_GATE_STAGES = ["static", "complete"];

const readObjectId = (value) => {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return /^[0-9a-f]{40}$/.test(normalized) ? normalized : undefined;
};

/**
 * @param {string} [root]
 * @param {{ readFileSync?: typeof NodeFS.readFileSync }} [opts]
 * @returns {{ tree?: string, validatedAt?: string, staticTree?: string, staticAt?: string } | null}
 */
export const readShipGateCache = (root = NodeProcess.cwd(), opts = {}) => {
  const readFileSync = opts.readFileSync ?? NodeFS.readFileSync;
  try {
    const parsed = JSON.parse(readFileSync(shipGateCachePath(root), "utf8"));
    if (parsed?.version !== SHIP_GATE_CACHE_VERSION) return null;
    const tree = readObjectId(parsed.tree);
    const staticTree = readObjectId(parsed.staticTree) ?? tree;
    if (!tree && !staticTree) return null;
    return {
      tree,
      validatedAt: typeof parsed.validatedAt === "string" ? parsed.validatedAt : undefined,
      staticTree,
      staticAt: typeof parsed.staticAt === "string" ? parsed.staticAt : undefined,
    };
  } catch {
    return null;
  }
};

/**
 * Highest checkpoint the cache records for `tree`, as an index into SHIP_GATE_STAGES; -1 when
 * the cache describes another tree.
 * @param {string | null | undefined} tree
 * @param {{ tree?: string, staticTree?: string } | null | undefined} cache
 */
export const cachedStage = (tree, cache) => {
  if (!tree || !cache) return -1;
  const t = tree.toLowerCase();
  if (cache.tree === t) return SHIP_GATE_STAGES.indexOf("complete");
  if (cache.staticTree === t) return SHIP_GATE_STAGES.indexOf("static");
  return -1;
};

/**
 * @param {string} root
 * @param {string} tree
 * @param {{ stage?: "static" | "complete"; writeFileSync?: typeof NodeFS.writeFileSync; mkdirSync?: typeof NodeFS.mkdirSync; readFileSync?: typeof NodeFS.readFileSync; now?: () => Date }} [opts]
 */
export const writeShipGateCache = (root, tree, opts = {}) => {
  const writeFileSync = opts.writeFileSync ?? NodeFS.writeFileSync;
  const mkdirSync = opts.mkdirSync ?? NodeFS.mkdirSync;
  const now = opts.now ?? (() => new Date());
  const stage = opts.stage ?? "complete";
  const normalized = readObjectId(tree);
  if (!normalized) throw new Error(`writeShipGateCache: invalid tree ${tree}`);
  const existing = readShipGateCache(root, opts);
  // Never demote the same tree: a static run landing after a full run would otherwise make the
  // next publish re-pay tests it already passed.
  if (SHIP_GATE_STAGES.indexOf(stage) < cachedStage(normalized, existing)) return;
  const at = now().toISOString();
  const value =
    stage === "static"
      ? { ...existing, version: SHIP_GATE_CACHE_VERSION, staticTree: normalized, staticAt: at }
      : {
          version: SHIP_GATE_CACHE_VERSION,
          tree: normalized,
          validatedAt: at,
          staticTree: normalized,
          staticAt: existing?.staticTree === normalized ? (existing.staticAt ?? at) : at,
        };
  const file = shipGateCachePath(root);
  mkdirSync(NodePath.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

/**
 * Full gate (check + typecheck + CI parity + test) already passed on this tree.
 * @param {string | null | undefined} tree
 * @param {{ tree?: string } | null | undefined} cache
 */
export const isShipGateTreeCached = (tree, cache) =>
  cachedStage(tree, cache) === SHIP_GATE_STAGES.indexOf("complete");

/**
 * Static gate (check + typecheck) already passed on this tree. Full cache also satisfies static.
 * @param {string | null | undefined} tree
 * @param {{ tree?: string, staticTree?: string } | null | undefined} cache
 */
export const isShipGateStaticCached = (tree, cache) => cachedStage(tree, cache) >= 0;

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
