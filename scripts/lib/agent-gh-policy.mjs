/**
 * Agent policy for `gh`: block undraft / ready-for-review side channels.
 * Publish must go through `pnpm pr:ready` (sets AGENT_PR_SHIP=1).
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";

const truthy = (v) => {
  if (v == null || v === "") return false;
  const s = String(v).toLowerCase();
  return s !== "0" && s !== "false" && s !== "no" && s !== "off";
};

/** @param {NodeJS.ProcessEnv} [env] */
export const isAgentPrShipAllowed = (env = NodeProcess.env) => truthy(env["AGENT_PR_SHIP"]);

/**
 * Strip leading global `gh` flags so subcommands are at the front.
 * @param {string[]} argv
 */
export const stripGhGlobalFlags = (argv) => {
  const args = [...argv];
  const skipValue = new Set(["-R", "--repo", "-h", "--hostname", "-p", "--path", "--config-dir"]);
  while (args.length > 0) {
    const a = args[0];
    if (a === "--") {
      args.shift();
      break;
    }
    if (!a.startsWith("-")) break;
    if (
      a.includes("=") &&
      (a.startsWith("-R=") || a.startsWith("--repo=") || a.startsWith("--hostname="))
    ) {
      args.shift();
      continue;
    }
    if (skipValue.has(a)) {
      args.shift();
      if (args.length > 0) args.shift();
      continue;
    }
    // Unknown global flag with possible value — stop rather than mis-parse.
    if (a.startsWith("-") && args.length > 1 && !args[1].startsWith("-") && !a.includes("=")) {
      // boolean globals like --help stay; leave them for gh
      break;
    }
    args.shift();
  }
  return args;
};

/**
 * @param {string[]} argv  args after the gh binary name
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ blocked: boolean, reason?: string }}
 */
export const inspectAgentGhCommand = (argv, env = NodeProcess.env) => {
  if (isAgentPrShipAllowed(env)) return { blocked: false };

  const args = stripGhGlobalFlags(argv);
  if (args.length === 0) return { blocked: false };

  // gh pr ready [number]
  if (args[0] === "pr" && args[1] === "ready") {
    return {
      blocked: true,
      reason:
        "agents must not undraft with `gh pr ready` — use `pnpm pr:ready` (runs the ship gate, then marks ready)",
    };
  }

  // REST / GraphQL undraft side channels via `gh api`
  if (args[0] === "api") {
    const joined = args.join(" ");
    if (/ready_for_review/i.test(joined) || /markPullRequestReadyForReview/i.test(joined)) {
      return {
        blocked: true,
        reason: "agents must not mark a PR ready via `gh api` — use `pnpm pr:ready`",
      };
    }
  }

  return { blocked: false };
};

/**
 * Resolve the real `gh` binary, skipping this policy shim when it is on PATH.
 * @param {{ env?: NodeJS.ProcessEnv, selfPath?: string }} [opts]
 * @returns {string | null}
 */
export const findRealGh = (opts = {}) => {
  const env = opts.env ?? NodeProcess.env;
  if (env["AGENT_GH_REAL"] && NodeFS.existsSync(env["AGENT_GH_REAL"])) {
    return env["AGENT_GH_REAL"];
  }
  if (env["T3_GITHUB_REAL_GH"] && NodeFS.existsSync(env["T3_GITHUB_REAL_GH"])) {
    return env["T3_GITHUB_REAL_GH"];
  }

  const selfPath = opts.selfPath
    ? NodePath.resolve(opts.selfPath)
    : NodeURL.fileURLToPath(import.meta.url);

  const pathEnv = env["PATH"] ?? "";
  for (const dir of pathEnv.split(NodePath.delimiter).filter(Boolean)) {
    for (const name of ["gh", "gh.real"]) {
      const candidate = NodePath.join(dir, name);
      try {
        if (!NodeFS.existsSync(candidate)) continue;
        const resolved = NodeFS.realpathSync(candidate);
        // Skip our shim (scripts/agent-gh.mjs launched via .tools/bin/gh).
        if (resolved === selfPath) continue;
        if (resolved.endsWith(`${NodePath.sep}agent-gh.mjs`)) continue;
        if (resolved.includes(`${NodePath.sep}.tools${NodePath.sep}bin${NodePath.sep}gh`)) continue;
        // Prefer executables; on Windows skip the check.
        try {
          NodeFS.accessSync(candidate, NodeFS.constants.X_OK);
        } catch {
          continue;
        }
        return candidate;
      } catch {
        // try next
      }
    }
  }

  // Last resort: ask the shell (may return us — caller must detect loops).
  const which = NodeChildProcess.spawnSync("bash", ["-lc", "command -v gh"], {
    encoding: "utf8",
    env,
    shell: false,
  });
  if (which.status === 0) {
    const p = which.stdout.trim();
    if (
      p &&
      !p.endsWith("agent-gh.mjs") &&
      !p.includes(`${NodePath.sep}.tools${NodePath.sep}bin${NodePath.sep}gh`)
    ) {
      return p;
    }
  }
  return null;
};
