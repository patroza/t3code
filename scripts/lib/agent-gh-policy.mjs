/**
 * Agent policy for `gh`: recognise the invocations that publish a pull request
 * (undraft / ready-for-review side channels) so the shim can run the ship gate
 * before letting them through. Publishing is gated, never refused — only a
 * failing gate stops it. `pnpm pr:ready` sets AGENT_PR_SHIP=1 so its own undraft
 * call does not re-run the gate it just passed.
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
 * Does this `gh` invocation publish a pull request, and therefore have to pass
 * the ship gate first?
 *
 * Publishing is not refused — it is gated. The shim runs the same gate
 * `pnpm pr:ready` runs and then lets the command through; only a failing gate
 * stops it. Refusing outright just moved the work to a command the agent had to
 * remember, and left repositories without a `pr:ready` equivalent with no route
 * at all.
 *
 * @param {string[]} argv  args after the gh binary name
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ required: boolean, reason?: string }}
 */
export const requiresShipGate = (argv, env = NodeProcess.env) => {
  // Already gated: `pnpm pr:ready` sets this for its own undraft call, so the
  // gate runs once rather than twice.
  if (isAgentPrShipAllowed(env)) return { required: false };

  const args = stripGhGlobalFlags(argv);
  if (args.length === 0) return { required: false };

  // gh pr ready [number]
  if (args[0] === "pr" && args[1] === "ready") {
    return {
      required: true,
      reason: "`gh pr ready` publishes this PR — running the ship gate first",
    };
  }

  // REST / GraphQL undraft side channels via `gh api`
  if (args[0] === "api") {
    const joined = args.join(" ");
    if (/ready_for_review/i.test(joined) || /markPullRequestReadyForReview/i.test(joined)) {
      return {
        required: true,
        reason: "this `gh api` call publishes a PR — running the ship gate first",
      };
    }
  }

  return { required: false };
};

/**
 * Resolve the real `gh` binary, skipping this policy shim when it is on PATH.
 * @param {{ env?: NodeJS.ProcessEnv, selfPath?: string }} [opts]
 * @returns {string | null}
 */
export const findRealGh = (opts = {}) => {
  const env = opts.env ?? NodeProcess.env;
  // Set by this shim for its own child, so honour it first.
  if (env["AGENT_GH_REAL"] && NodeFS.existsSync(env["AGENT_GH_REAL"])) {
    return env["AGENT_GH_REAL"];
  }

  // NOT T3_GITHUB_REAL_GH here: that names the *unauthenticated* binary the
  // GitHub App wrapper execs after it mints an installation token, and hosts
  // export it precisely so a child that reorders PATH keeps minting config.
  // Delegating straight to it skips minting, so every `gh` call the shim
  // fronts fails with "gh auth login" — which is how server-side PR lookups
  // silently lost their badges. Prefer whatever PATH resolves (the App-aware
  // `gh`), and fall back to the raw binary only when nothing else exists.

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

  // Only now consider the raw binary the App wrapper execs: better an
  // unauthenticated `gh` than none, but never in preference to the wrapper.
  if (env["T3_GITHUB_REAL_GH"] && NodeFS.existsSync(env["T3_GITHUB_REAL_GH"])) {
    return env["T3_GITHUB_REAL_GH"];
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
