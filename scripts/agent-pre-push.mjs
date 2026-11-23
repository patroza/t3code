#!/usr/bin/env node
/**
 * Agent pushes enforce changed or full validation by PR state; humans pass through unchanged.
 * A green full gate on a clean tree is cached by tree and posted as a "Local proof" status that
 * lets Fork CI's pull_request run skip what it covered. `--prove` does that for a pushed HEAD;
 * `--no-cache` (or AGENT_SHIP_GATE_FORCE=1) re-runs a cached tree.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";
import { isCodingAgent } from "./lib/agent-env.mjs";
import { postLocalProof, postLocalProofAfterPush, pushesHead } from "./lib/agent-local-proof.mjs";
import { filesForChangedShipCheck } from "./lib/agent-fork-dev.mjs";
import {
  enterDetachedGate,
  runGateDetached,
  runWithFlakyRerun,
  shouldDetachGate,
} from "./lib/agent-gate-resilience.mjs";
import { resolveOpenPrState, shipGateScopeForPush } from "./lib/agent-pr-state.mjs";
import {
  isShipGateForce,
  isShipGateStaticCached,
  isShipGateTreeCached,
  isWorktreeClean,
  readHeadSha,
  readHeadTree,
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

/**
 * What Fork CI's Check and Test Packages jobs run beyond vp check, typecheck, and the test
 * suites. A local proof skips those jobs, so keep this in step with fork-ci.yml (the test
 * enforces it) and bump LOCAL_PROOF_VERSION when the gate stops covering them.
 */
/**
 * Fork CI's test jobs, run one after another (without --shard). Running the whole workspace at
 * once makes web browser tests compete with every other suite; on a loaded machine a test that
 * takes ~1s alone then misses its 15s timeout. The test keeps these in step with fork-ci.yml.
 */
export const TEST_STEPS = Object.freeze([
  [
    "test packages",
    [
      ["vp", "run", "--parallel", "--concurrency-limit", "4", "--filter", "!t3"],
      ["--filter", "!@t3tools/monorepo", "--filter", "!@t3tools/web", "test"],
    ].flat(),
    ".",
  ],
  ["test server", ["vp", "run", "--filter", "t3", "test"], "."],
  ["test web unit", ["vp", "test", "run", "--passWithNoTests", "--project", "unit"], "apps/web"],
  [
    "test web browser",
    ["vp", "test", "run", "--passWithNoTests", "--project", "browser"],
    "apps/web",
    // Under load a browser file sometimes fails to load a module or its worker; rerun those once.
    { rerunFlaky: true },
  ],
]);

export const CI_PARITY_STEPS = Object.freeze([
  ["ensure electron", ["vp", "run", "--filter", "@t3tools/desktop", "ensure:electron"]],
  ["knip", ["vp", "run", "knip:check"]],
  [
    "GitHub GraphQL codegen",
    ["vp", "run", "--filter", "@t3tools/source-control-github", "generate", "--check"],
  ],
  ["Expo GraphQL codegen", ["vp", "run", "--filter", "t3", "generate", "--check"]],
  [
    "Linear GraphQL codegen",
    ["vp", "run", "--filter", "@t3tools/issue-tracker-linear", "generate", "--check"],
  ],
  ["i18n catalogs", ["vp", "run", "i18n:check"]],
  ["build desktop pipeline", ["vp", "run", "--cache", "build:desktop"]],
  ["verify preload bundle", ["node", "apps/desktop/scripts/verify-preload-bundle.mjs"]],
  [
    "preview artifact validation",
    ["python3", "-B", ".github/scripts/stage-preview-bundle.test.py"],
  ],
  [
    "release checks",
    [
      "node",
      "--test",
      ".github/scripts/check-nightly-release.test.cjs",
      ".github/scripts/vercel-deployment-output.test.cjs",
      ".github/scripts/mobile-preview-comment.test.cjs",
      ".github/scripts/mobile-ios-preview-record.test.cjs",
      ".github/scripts/test-delta.test.cjs",
    ],
  ],
]);

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

/** Fork CI's Check job fails on committed PR evidence; the local proof has to as well. */
const rejectCommittedPrAssets = (root) => {
  const result = NodeChildProcess.spawnSync("git", ["ls-files", ".github/pr-assets"], {
    cwd: root,
    encoding: "utf8",
  });
  const files = (result.stdout ?? "").trim();
  if (result.status !== 0 || files.length > 0) {
    console.error(
      `agent ship-gate: PR evidence must be uploaded to GitHub, not committed:\n${files}`,
    );
    NodeProcess.exit(1);
  }
};

/**
 * Cache full validation by HEAD's tree; changed-file checks never count as a full gate. Force with
 * AGENT_SHIP_GATE_FORCE. `proven` is true when a full gate passed on HEAD's committed tree.
 * @param {{ root?: string, scope?: "full" | "changed", force?: boolean, env?: NodeJS.ProcessEnv, detach?: boolean }} [opts]
 * @returns {Promise<{ status: "cached" | "ok", sha: string | null, tree: string | null, scope: "full" | "changed", proven: boolean }>}
 */
export const runAgentShipGate = async (opts = {}) => {
  const root = opts.root ?? NodeProcess.cwd();
  const env = withRepoBin(root, opts.env ?? NodeProcess.env);
  const force = opts.force === true || isShipGateForce(env);
  const scope = opts.scope === "changed" || opts.scope === "static" ? "changed" : "full";
  const headSha = readHeadSha(root);
  const tree = readHeadTree(root);
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
    return { status: "ok", sha: headSha, tree, scope, proven: false };
  }

  if (!force && isShipGateTreeCached(tree, cache)) {
    console.error(
      `agent ship-gate: skip — tree ${tree?.slice(0, 12)} already validated (cache .run/agent-ship-gate.json; force with AGENT_SHIP_GATE_FORCE=1 or --no-cache)`,
    );
    return { status: "cached", sha: headSha, tree, scope, proven: true };
  }

  if (opts.detach !== false && tree && shouldDetachGate(env)) {
    const result = await runGateDetached({ root, tree, entry: thisFile, env, force });
    if (result.code !== 0) NodeProcess.exit(result.code);
    return /** @type {Awaited<ReturnType<typeof runAgentShipGate>>} */ (result.gate);
  }

  // Uncommitted or untracked files make the run test something other than HEAD's tree.
  const cleanAtStart = isWorktreeClean(root);

  if (!force && isShipGateStaticCached(tree, cache)) {
    console.error(
      `agent ship-gate: skip check/typecheck — tree ${tree?.slice(0, 12)} already passed static`,
    );
  } else {
    run("vp check", ["vp", "check"], { cwd: root, env });
    run("vpr typecheck", ["vpr", "typecheck"], { cwd: root, env });
  }

  rejectCommittedPrAssets(root);
  for (const [label, args] of CI_PARITY_STEPS) {
    run(label, args, { cwd: root, env, shell: false });
  }

  const xdgRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-gate-xdg-"));
  try {
    const testEnvironment = testEnv(env, { xdgRoot });
    for (const [label, args, cwd, options] of TEST_STEPS) {
      if (options?.rerunFlaky) {
        const status = runWithFlakyRerun({
          label,
          args,
          cwd: NodePath.join(root, cwd),
          env: testEnvironment,
          reportPath: NodePath.join(xdgRoot, "vitest-report.json"),
        });
        if (status !== 0) {
          console.error(`agent ship-gate: failed: ${label} (exit ${status})`);
          NodeProcess.exit(status);
        }
        continue;
      }
      run(label, args, { cwd: NodePath.join(root, cwd), env: testEnvironment, shell: false });
    }
  } finally {
    NodeFS.rmSync(xdgRoot, { recursive: true, force: true });
  }

  const proven =
    Boolean(tree) && cleanAtStart && isWorktreeClean(root) && readHeadTree(root) === tree;
  if (proven && tree) {
    try {
      writeShipGateCache(root, tree, { stage: "complete" });
      console.error(
        `agent ship-gate: cached tree ${tree.slice(0, 12)} (.run/agent-ship-gate.json)`,
      );
    } catch (error) {
      console.error(`agent ship-gate: could not write cache: ${error?.message ?? error}`);
    }
  } else {
    console.error(
      "agent ship-gate: worktree has uncommitted or untracked files (or HEAD moved) — not cached, no local proof",
    );
  }

  console.error("agent ship-gate: ok");
  return { status: "ok", sha: headSha, tree, scope, proven };
};

/**
 * Post the local proof for a green full gate on HEAD, which must already be on GitHub.
 * @param {string} root
 * @param {Awaited<ReturnType<typeof runAgentShipGate>>} gate
 */
export const reportLocalProof = (root, gate) => {
  if (!gate.proven || !gate.sha) return;
  const result = postLocalProof({ root, sha: gate.sha });
  console.error(
    result.posted
      ? `agent ship-gate: posted Local proof on ${gate.sha.slice(0, 12)} (${result.description})`
      : `agent ship-gate: no Local proof posted: ${result.reason}`,
  );
};

/** stdin of a pre-push hook; empty when run by hand. */
const readHookStdin = () => {
  if (NodeProcess.stdin.isTTY) return "";
  try {
    return NodeFS.readFileSync(0, "utf8");
  } catch {
    return "";
  }
};

/**
 * Pre-push runs before GitHub has the commit, so a short-lived child waits for the push to land
 * and then posts. Its output goes to .run/local-proof.log.
 * @param {string} root
 * @param {string} sha
 */
const deferLocalProof = (root, sha) => {
  const logDir = NodePath.join(root, ".run");
  NodeFS.mkdirSync(logDir, { recursive: true });
  const log = NodeFS.openSync(NodePath.join(logDir, "local-proof.log"), "a");
  const child = NodeChildProcess.spawn(
    NodeProcess.execPath,
    [thisFile, "--post-proof-after-push", sha],
    { cwd: root, detached: true, stdio: ["ignore", log, log], env: NodeProcess.env },
  );
  child.unref();
  console.error(
    `agent pre-push: Local proof for ${sha.slice(0, 12)} posts once the push lands (.run/local-proof.log)`,
  );
};

const thisFile = NodeURL.fileURLToPath(import.meta.url);
const invokedAs = NodeProcess.argv[1] ? NodePath.resolve(NodeProcess.argv[1]) : "";

const main = async () => {
  const args = NodeProcess.argv.slice(2);
  const root = NodeProcess.cwd();

  const postIndex = args.indexOf("--post-proof-after-push");
  if (postIndex !== -1) {
    const sha = args[postIndex + 1] ?? "";
    const result = await postLocalProofAfterPush({ root, sha });
    console.error(
      `${new Date().toISOString()} ${sha.slice(0, 12)}: ${result.posted ? `posted ${result.description}` : `not posted: ${result.reason}`}`,
    );
    return;
  }

  const force = args.includes("--no-cache");
  const detachedIndex = args.indexOf("--detached-gate");
  if (detachedIndex !== -1) {
    const { env, recordGate } = enterDetachedGate({
      envPath: args[detachedIndex + 1] ?? "",
      resultPath: args[detachedIndex + 2] ?? "",
    });
    recordGate(await runAgentShipGate({ root, scope: "full", force, env, detach: false }));
    return;
  }

  if (args.includes("--prove")) {
    const gate = await runAgentShipGate({ root, scope: "full", force });
    reportLocalProof(root, gate);
    return;
  }

  if (!isCodingAgent()) return;

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

  const gate = await runAgentShipGate({ root, scope, force });
  if (
    prState.mode === "ready" &&
    gate.proven &&
    gate.sha &&
    pushesHead(readHookStdin(), gate.sha)
  ) {
    deferLocalProof(root, gate.sha);
  }
};

if (invokedAs === thisFile) {
  await main();
  NodeProcess.exit(0);
}

// Tests run as CI does: no .envrc GH_REPO, no global git config (remote.pushDefault changes
// remote picks), a TMPDIR asar accepts (no dot-directory), empty XDG config and data, Fork CI's
// Chromium collection, and a CI runner's two workers per suite on a busy developer machine.
export function testEnv(env, { xdgRoot, platform = NodeProcess.platform } = {}) {
  const next = { ...env };
  delete next.GH_REPO;
  next.GIT_CONFIG_GLOBAL ??= platform === "win32" ? "NUL" : "/dev/null";
  next.VITEST_CHROMIUM_GC_DISK_THRESHOLD_GB ??= "Infinity";
  next.VITEST_MAX_WORKERS ??= "2";
  if (next.TMPDIR && /(^|[/\\])\./.test(next.TMPDIR) && platform !== "win32") {
    next.TMPDIR = "/tmp";
  }
  if (xdgRoot) {
    next.XDG_CONFIG_HOME = NodePath.join(xdgRoot, "config");
    next.XDG_DATA_HOME = NodePath.join(xdgRoot, "data");
  }
  return next;
}
