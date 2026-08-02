import { assert, it } from "@effect/vitest";
import { isCodingAgent } from "./agent-pre-push.mjs";
import { requiresShipGate, stripGhGlobalFlags } from "./lib/agent-gh-policy.mjs";
import {
  classifyPrPayload,
  parseRepoSlug,
  resolveOpenPrState,
  shipGateScopeForPush,
  shouldRunShipGateOnPush,
} from "./lib/agent-pr-state.mjs";
import {
  isShipGateForce,
  isShipGateShaCached,
  isShipGateStaticCached,
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

it("full ship gate on push: only ready + unknown", () => {
  assert.equal(shouldRunShipGateOnPush("none"), false);
  assert.equal(shouldRunShipGateOnPush("draft"), false);
  assert.equal(shouldRunShipGateOnPush("ready"), true);
  assert.equal(shouldRunShipGateOnPush("unknown"), true);
});

it("push scope: draft/none = static, ready/unknown = full", () => {
  assert.equal(shipGateScopeForPush("none"), "static");
  assert.equal(shipGateScopeForPush("draft"), "static");
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

it("ship-gate cache: match / miss / force", () => {
  const sha = "a".repeat(40);
  const other = "b".repeat(40);
  assert.equal(isShipGateShaCached(sha, { sha }), true);
  assert.equal(isShipGateShaCached(sha.toUpperCase(), { sha }), true);
  assert.equal(isShipGateShaCached(other, { sha }), false);
  assert.equal(isShipGateShaCached(null, { sha }), false);
  assert.equal(isShipGateShaCached(sha, null), false);
  assert.equal(isShipGateStaticCached(sha, { staticSha: sha }), true);
  assert.equal(isShipGateStaticCached(sha, { sha }), true);
  assert.equal(isShipGateStaticCached(sha, { staticSha: other }), false);
  assert.equal(isShipGateForce({}), false);
  assert.equal(isShipGateForce({ AGENT_SHIP_GATE_FORCE: "1" }), true);
  assert.equal(isShipGateForce({ AGENT_SHIP_GATE_FORCE: "0" }), false);
});

it("ship-gate cache: write + read roundtrip (complete)", () => {
  const files = new Map();
  const root = "/tmp/agent-ship-gate-test-root";
  const sha = "c".repeat(40);
  writeShipGateCache(root, sha, {
    stage: "complete",
    mkdirSync: () => {},
    writeFileSync: (file, data) => {
      files.set(file, data);
    },
    readFileSync: (file) => {
      if (!files.has(file)) throw new Error("ENOENT");
      return files.get(file);
    },
    now: () => new Date("2026-08-02T00:00:00.000Z"),
  });
  assert.equal(files.size, 1);
  const written = [...files.values()][0];
  assert.match(written, new RegExp(sha));
  const cache = readShipGateCache(root, {
    readFileSync: (file) => {
      if (!files.has(file)) throw new Error("ENOENT");
      return files.get(file);
    },
  });
  assert.equal(cache?.sha, sha);
  assert.equal(cache?.staticSha, sha);
  assert.equal(isShipGateShaCached(sha, cache), true);
  assert.equal(isShipGateStaticCached(sha, cache), true);
});

it("ship-gate cache: static does not demote complete", () => {
  const files = new Map();
  const root = "/tmp/agent-ship-gate-static-test";
  const sha = "d".repeat(40);
  const io = {
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
  writeShipGateCache(root, sha, { ...io, stage: "complete" });
  writeShipGateCache(root, sha, { ...io, stage: "static" });
  const cache = readShipGateCache(root, io);
  assert.equal(cache?.sha, sha);
  assert.equal(isShipGateShaCached(sha, cache), true);
});
