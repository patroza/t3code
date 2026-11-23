import { assert, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { isCodingAgent, testEnv } from "./agent-pre-push.mjs";
import {
  findRealGh,
  isInsideCheckout,
  requiresShipGate,
  stripGhGlobalFlags,
} from "./lib/agent-gh-policy.mjs";
import {
  assertUpToDateWithForkDev,
  filesForChangedShipCheck,
  listChangedFilesAgainstForkDev,
  resolveForkDevRef,
} from "./lib/agent-fork-dev.mjs";
import {
  classifyPrPayload,
  parseRepoSlug,
  resolveOpenPrState,
  shipGateScopeForPush,
  shouldRunShipGateOnPush,
} from "./lib/agent-pr-state.mjs";
import {
  isShipGateForce,
  isShipGateStaticCached,
  isShipGateTreeCached,
  readShipGateCache,
  writeShipGateCache,
} from "./lib/agent-ship-gate-cache.mjs";

it("humans: empty env is not an agent", () => {
  assert.equal(isCodingAgent({}), false);
});

it("humans: SKIP_AGENT_PREPUSH wins even if GROK_AGENT is set", () => {
  assert.equal(isCodingAgent({ GROK_AGENT: "1", SKIP_AGENT_PREPUSH: "1" }), false);
});

it("agents: GROK_AGENT / T3_AGENT / AI_AGENT", () => {
  assert.equal(isCodingAgent({ GROK_AGENT: "1" }), true);
  assert.equal(isCodingAgent({ T3_AGENT: "1" }), true);
  assert.equal(isCodingAgent({ AI_AGENT: "1" }), true);
});

it("agents: Claude / Cursor / Codex markers", () => {
  assert.equal(isCodingAgent({ CLAUDECODE: "1" }), true);
  assert.equal(isCodingAgent({ CURSOR_AGENT: "1" }), true);
  assert.equal(isCodingAgent({ CODEX_CI: "1" }), true);
});

it("truthy: 0 / false / no are not agents", () => {
  assert.equal(isCodingAgent({ GROK_AGENT: "0" }), false);
  assert.equal(isCodingAgent({ GROK_AGENT: "false" }), false);
});

it("PR payload: draft / ready / closed", () => {
  assert.equal(classifyPrPayload(null), "none");
  assert.equal(classifyPrPayload({ isDraft: true, state: "OPEN" }), "draft");
  assert.equal(classifyPrPayload({ isDraft: false, state: "OPEN" }), "ready");
  assert.equal(classifyPrPayload({ isDraft: false, state: "MERGED" }), "none");
  assert.equal(classifyPrPayload({ isDraft: true, state: "CLOSED" }), "none");
});

it("resolveForkDevRef: prefers origin/fork/dev", () => {
  const seen = [];
  const ref = resolveForkDevRef({
    cwd: "/repo",
    runGit: (args) => {
      seen.push(args);
      if (args.includes("origin/fork/dev")) return { status: 0, stdout: "abc\n" };
      return { status: 1, stdout: "" };
    },
  });
  assert.equal(ref, "origin/fork/dev");
  assert.equal(seen[0]?.includes("origin/fork/dev"), true);
});

it("listChangedFilesAgainstForkDev: diffs merge-base..HEAD", () => {
  const files = listChangedFilesAgainstForkDev({
    cwd: "/repo",
    runGit: (args) => {
      if (args.includes("rev-parse")) return { status: 0, stdout: "abc\n" };
      if (args[0] === "merge-base" && args[1] === "HEAD") return { status: 0, stdout: "base123\n" };
      if (args[0] === "diff") return { status: 0, stdout: "AGENTS.md\nscripts/x.mjs\n" };
      return { status: 1, stdout: "" };
    },
  });
  assert.deepEqual(files, ["AGENTS.md", "scripts/x.mjs"]);
});

it("filesForChangedShipCheck: drops .repos vendor trees", () => {
  const files = filesForChangedShipCheck({
    cwd: "/repo",
    runGit: (args) => {
      if (args.includes("rev-parse")) return { status: 0, stdout: "abc\n" };
      if (args[0] === "merge-base" && args[1] === "HEAD") return { status: 0, stdout: "base123\n" };
      if (args[0] === "diff") {
        return {
          status: 0,
          stdout: "AGENTS.md\n.repos/effect-smol/x.ts\n.repos/alchemy-effect/y.ts\n",
        };
      }
      return { status: 1, stdout: "" };
    },
  });
  assert.deepEqual(files, ["AGENTS.md"]);
});

it("assertUpToDateWithForkDev: fails when fork/dev is not an ancestor", () => {
  const result = assertUpToDateWithForkDev({
    cwd: "/repo",
    fetch: false,
    runGit: (args) => {
      if (args.includes("rev-parse")) return { status: 0, stdout: "abc\n" };
      if (args.includes("--is-ancestor")) return { status: 1, stdout: "" };
      return { status: 0, stdout: "" };
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.detail ?? "", /not up to date/);
});

it("assertUpToDateWithForkDev: ok when fork/dev is an ancestor", () => {
  const result = assertUpToDateWithForkDev({
    cwd: "/repo",
    fetch: false,
    runGit: (args) => {
      if (args.includes("rev-parse")) return { status: 0, stdout: "abc\n" };
      if (args.includes("--is-ancestor")) return { status: 0, stdout: "" };
      return { status: 0, stdout: "" };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.ref, "origin/fork/dev");
});

it("full ship gate on push: only ready + unknown", () => {
  assert.equal(shouldRunShipGateOnPush("none"), false);
  assert.equal(shouldRunShipGateOnPush("draft"), false);
  assert.equal(shouldRunShipGateOnPush("ready"), true);
  assert.equal(shouldRunShipGateOnPush("unknown"), true);
});

it("push scope: draft/none = changed, ready/unknown = full", () => {
  assert.equal(shipGateScopeForPush("none"), "changed");
  assert.equal(shipGateScopeForPush("draft"), "changed");
  assert.equal(shipGateScopeForPush("ready"), "full");
  assert.equal(shipGateScopeForPush("unknown"), "full");
});

const pinned = (runGh) => ({ branch: "feature", repoSlug: "owner/repo", runGh });

it("parseRepoSlug: ssh / https / trailing .git", () => {
  assert.equal(parseRepoSlug("git@github.com:patroza/t3code.git"), "patroza/t3code");
  assert.equal(parseRepoSlug("https://github.com/patroza/t3code.git"), "patroza/t3code");
  assert.equal(parseRepoSlug("https://github.com/patroza/t3code"), "patroza/t3code");
  assert.equal(parseRepoSlug("ssh://git@github.com/patroza/t3code.git"), "patroza/t3code");
  assert.equal(parseRepoSlug(""), null);
  assert.equal(parseRepoSlug(null), null);
});

it("resolveOpenPrState: empty list → none", () => {
  const state = resolveOpenPrState(pinned(() => ({ status: 0, stdout: "[]", stderr: "" })));
  assert.equal(state.mode, "none");
});

it("resolveOpenPrState: draft list → draft", () => {
  const state = resolveOpenPrState(
    pinned(() => ({
      status: 0,
      stdout: JSON.stringify([
        { number: 42, url: "https://example/42", isDraft: true, state: "OPEN" },
      ]),
      stderr: "",
    })),
  );
  assert.equal(state.mode, "draft");
  assert.equal(state.pr?.number, 42);
});

it("resolveOpenPrState: strips ANSI and shell noise and disables forced color", () => {
  let seenEnv;
  const state = resolveOpenPrState({
    ...pinned(() => ({ status: 0, stdout: "[]", stderr: "" })),
    env: { FORCE_COLOR: "1", CLICOLOR_FORCE: "1" },
    runGh: (_args, opts) => {
      seenEnv = opts.env;
      return {
        status: 0,
        stdout: `direnv: loading\n\u001b[32m${JSON.stringify([
          { number: 42, isDraft: true, state: "OPEN" },
        ])}\u001b[0m\n`,
        stderr: "",
      };
    },
  });
  assert.equal(state.mode, "draft");
  assert.equal(seenEnv.FORCE_COLOR, undefined);
  assert.equal(seenEnv.CLICOLOR_FORCE, undefined);
  assert.equal(seenEnv.NO_COLOR, "1");
  assert.equal(seenEnv.GH_FORCE_TTY, "0");
});

it("resolveOpenPrState: ready list → ready", () => {
  const state = resolveOpenPrState(
    pinned(() => ({
      status: 0,
      stdout: JSON.stringify([{ number: 7, isDraft: false, state: "OPEN" }]),
      stderr: "",
    })),
  );
  assert.equal(state.mode, "ready");
});

it("resolveOpenPrState: gh crash → unknown (fail closed)", () => {
  const state = resolveOpenPrState(pinned(() => ({ status: 2, stdout: "", stderr: "HTTP 401" })));
  assert.equal(state.mode, "unknown");
});

it("resolveOpenPrState: uses --head branch + --repo origin", () => {
  let seen = null;
  resolveOpenPrState(
    pinned((args) => {
      seen = args;
      return { status: 0, stdout: "[]", stderr: "" };
    }),
  );
  assert.isOk(seen.includes("list"));
  assert.equal(seen[seen.indexOf("--head") + 1], "feature");
  assert.equal(seen[seen.indexOf("--repo") + 1], "owner/repo");
});

it("resolveOpenPrState: T3CODE_FORK_REPOSITORY overrides origin", () => {
  let seen = null;
  resolveOpenPrState({
    branch: "feature",
    env: { T3CODE_FORK_REPOSITORY: "acme/repo" },
    runGit: () => {
      throw new Error("git must not be called when the fork repo is set");
    },
    runGh: (args) => {
      seen = args;
      return { status: 0, stdout: "[]", stderr: "" };
    },
  });
  assert.equal(seen[seen.indexOf("--repo") + 1], "acme/repo");
});

it("resolveOpenPrState: detached HEAD → unknown (fail closed)", () => {
  const state = resolveOpenPrState({
    branch: "HEAD",
    repoSlug: "owner/repo",
    runGh: () => {
      throw new Error("gh must not be called without a branch");
    },
  });
  assert.equal(state.mode, "unknown");
});

it("resolveOpenPrState: no origin repo → unknown (fail closed)", () => {
  const state = resolveOpenPrState({
    branch: "feature",
    repoSlug: null,
    runGh: () => {
      throw new Error("gh must not be called without a repo");
    },
  });
  assert.equal(state.mode, "unknown");
});

it("gh policy: pr ready needs the ship gate unless AGENT_PR_SHIP", () => {
  assert.equal(requiresShipGate(["pr", "ready"], {}).required, true);
  assert.equal(requiresShipGate(["pr", "ready", "12"], {}).required, true);
  assert.equal(requiresShipGate(["pr", "ready"], { AGENT_PR_SHIP: "1" }).required, false);
  assert.equal(requiresShipGate(["pr", "view"], {}).required, false);
  assert.equal(requiresShipGate(["pr", "ready", "12", "--undo"], {}).required, false);
  assert.equal(requiresShipGate(["pr", "create", "--draft"], {}).required, false);
});

it("gh policy: says the gate is running, not that the command is refused", () => {
  const reason = requiresShipGate(["pr", "ready"], {}).reason ?? "";
  assert.equal(reason.includes("ship gate"), true);
  assert.equal(/must not|blocked|forbidden/i.test(reason), false);
});

it("gh policy: strips -R before matching pr ready", () => {
  assert.deepEqual(stripGhGlobalFlags(["-R", "o/r", "pr", "ready"]), ["pr", "ready"]);
  assert.equal(requiresShipGate(["-R", "pingdotgg/t3code", "pr", "ready"], {}).required, true);
});

it("gh policy: ready_for_review api paths need the ship gate", () => {
  assert.equal(
    requiresShipGate(["api", "repos/o/r/pulls/1/ready_for_review", "-X", "POST"], {}).required,
    true,
  );
  assert.equal(
    requiresShipGate(
      [
        "api",
        "graphql",
        "-f",
        "query=mutation { markPullRequestReadyForReview(input: {}) { clientMutationId } }",
      ],
      {},
    ).required,
    true,
  );
});

const memoryFs = () => {
  const files = new Map();
  return {
    files,
    mkdirSync: () => {},
    writeFileSync: (file, data) => {
      files.set(file, data);
    },
    readFileSync: (file) => {
      if (!files.has(file)) throw new Error("ENOENT");
      return files.get(file);
    },
    now: () => new Date("2026-08-02T00:00:00.000Z"),
  };
};

it("ship-gate cache: match / miss / force", () => {
  const tree = "a".repeat(40);
  const other = "b".repeat(40);
  assert.equal(isShipGateTreeCached(tree, { tree }), true);
  assert.equal(isShipGateTreeCached(tree.toUpperCase(), { tree }), true);
  assert.equal(isShipGateTreeCached(other, { tree }), false);
  assert.equal(isShipGateTreeCached(null, { tree }), false);
  assert.equal(isShipGateTreeCached(tree, null), false);
  assert.equal(isShipGateTreeCached(tree, { staticTree: tree }), false);
  assert.equal(isShipGateStaticCached(tree, { staticTree: tree }), true);
  assert.equal(isShipGateStaticCached(tree, { tree }), true);
  assert.equal(isShipGateStaticCached(tree, { staticTree: other }), false);
  assert.equal(isShipGateForce({}), false);
  assert.equal(isShipGateForce({ AGENT_SHIP_GATE_FORCE: "1" }), true);
  assert.equal(isShipGateForce({ AGENT_SHIP_GATE_FORCE: "0" }), false);
});

it("ship-gate cache: write + read roundtrip by tree; commit-keyed caches are ignored", () => {
  const io = memoryFs();
  const root = "/tmp/agent-ship-gate-test-root";
  const tree = "c".repeat(40);
  writeShipGateCache(root, tree, { ...io, stage: "complete" });
  const cache = readShipGateCache(root, io);
  assert.equal(cache?.tree, tree);
  assert.equal(isShipGateTreeCached(tree, cache), true);
  assert.equal(isShipGateStaticCached(tree, cache), true);

  // A cache from before the tree key named a commit; reusing it would skip an untested tree.
  const legacy = memoryFs();
  legacy.files.set(`${root}/.run/agent-ship-gate.json`, JSON.stringify({ sha: tree }));
  assert.equal(readShipGateCache(root, legacy), null);
});

it("ship-gate cache: static does not demote complete", () => {
  const io = memoryFs();
  const root = "/tmp/agent-ship-gate-static-test";
  const tree = "d".repeat(40);
  writeShipGateCache(root, tree, { ...io, stage: "complete" });
  writeShipGateCache(root, tree, { ...io, stage: "static" });
  assert.equal(isShipGateTreeCached(tree, readShipGateCache(root, io)), true);
});

// The raw gh binary bypasses App installation-token minting; the shim must prefer the wrapper.
it("findRealGh prefers the App-aware gh on PATH over the raw T3_GITHUB_REAL_GH binary", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "agent-gh-real-"));
  const wrapperDir = NodePath.join(root, "wrapper");
  const rawDir = NodePath.join(root, "raw");
  NodeFS.mkdirSync(wrapperDir);
  NodeFS.mkdirSync(rawDir);
  const wrapper = NodePath.join(wrapperDir, "gh");
  const raw = NodePath.join(rawDir, "gh");
  for (const file of [wrapper, raw]) {
    NodeFS.writeFileSync(file, "#!/bin/sh\nexit 0\n");
    NodeFS.chmodSync(file, 0o755);
  }

  assert.equal(
    findRealGh({
      env: { PATH: wrapperDir, T3_GITHUB_REAL_GH: raw },
      selfPath: NodePath.join(root, "agent-gh.mjs"),
    }),
    wrapper,
  );

  // Still usable as a last resort when PATH offers no gh at all.
  assert.equal(
    findRealGh({
      env: { PATH: NodePath.join(root, "empty"), T3_GITHUB_REAL_GH: raw },
      selfPath: NodePath.join(root, "agent-gh.mjs"),
    }),
    raw,
  );

  // An explicit override still wins over both.
  assert.equal(
    findRealGh({
      env: { PATH: wrapperDir, AGENT_GH_REAL: raw, T3_GITHUB_REAL_GH: raw },
      selfPath: NodePath.join(root, "agent-gh.mjs"),
    }),
    raw,
  );

  NodeFS.rmSync(root, { recursive: true, force: true });
});

it("runs the gate's tests without the fork's GH_REPO, a dot-directory TMPDIR, or the developer's config", () => {
  const env = testEnv(
    { GH_REPO: "patroza/t3code", TMPDIR: "/home/u/.cache/tmp", PATH: "/bin" },
    { xdgRoot: "/tmp/t3-gate-xdg-x", platform: "linux" },
  );
  assert.isUndefined(env.GH_REPO);
  assert.strictEqual(env.PATH, "/bin");
  assert.strictEqual(env.TMPDIR, "/tmp");
  assert.strictEqual(env.XDG_CONFIG_HOME, NodePath.join("/tmp/t3-gate-xdg-x", "config"));
  assert.strictEqual(env.XDG_DATA_HOME, NodePath.join("/tmp/t3-gate-xdg-x", "data"));
  assert.strictEqual(env.VITEST_CHROMIUM_GC_DISK_THRESHOLD_GB, "Infinity");
  assert.strictEqual(env.VITEST_MAX_WORKERS, "2");
  assert.strictEqual(env.GIT_CONFIG_GLOBAL, "/dev/null");
  assert.strictEqual(testEnv({ VITEST_MAX_WORKERS: "6" }).VITEST_MAX_WORKERS, "6");
  assert.strictEqual(testEnv({ TMPDIR: "/var/tmp" }, { platform: "linux" }).TMPDIR, "/var/tmp");
});

it("keeps the gh shim inert outside the checkout that installed it", () => {
  assert.equal(isInsideCheckout("/repo", "/repo"), true);
  assert.equal(isInsideCheckout("/repo/apps/web", "/repo"), true);
  assert.equal(isInsideCheckout("/other-project", "/repo"), false);
  assert.equal(isInsideCheckout("/repo-sibling", "/repo"), false);
});
