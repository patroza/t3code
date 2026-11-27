// @effect-diagnostics nodeBuiltinImport:off - Test fixture setup reads source and creates temp dirs.
import { assert, describe, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import { paceOf, paceRemainingPercent, remainingPercent } from "@t3tools/shared/usageLimits";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSettings from "../serverSettings.ts";
import * as NodePtyAdapter from "../terminal/NodePtyAdapter.ts";
import {
  ANTIGRAVITY_LIMITS_MIN_REFRESH_MS,
  MinimalVtScreen,
  captureAgyUsageScreen,
  detectUnexpectedAgyPrompt,
  makeAntigravityUsageLimitsProbe,
  parseAgyUsageScreen,
  parseRelativeDurationSeconds,
  resolveAntigravityLimitsRefreshMs,
} from "./antigravityUsageLimitsFork.ts";

const FIXED_NOW_MS = Date.parse("2026-11-27T12:00:00.000Z");

const SAMPLE_BANNER = [
  "Antigravity CLI 1.5.18",
  "u@example.invalid (Google AI Ultra)",
  "Gemini 4 Neon (High)",
  "/tmp/agy-cwd",
  "? for shortcuts",
].join("\n");

const SAMPLE_BOTH_GROUPS_SCREEN = [
  "└ Models & Quota",
  "",
  "  Account: u@example.invalid",
  "",
  "GEMINI MODELS",
  "  Models within this group: Gemini 4 Neon, Gemini 4 Carbon",
  "",
  "  Weekly Limit Remaining",
  "    [███████████████████████████████████░░░░░░░░░░░░░░░] 70.84%",
  "    Refreshes in 5d 19h 33m",
  "",
  "  Five Hour Limit Remaining",
  "    [█████████████████████████████████████████████░░░░░] 89.30%",
  "    Refreshes in 3h 47m",
  "",
  "CLAUDE AND GPT MODELS",
  "  Models within this group: Claude Opus 5.5, Claude Sonnet 5.5, GPT-OSS 120B",
  "",
  "  Weekly Limit Remaining",
  "    [█████████████████████████████████░░░░░░░░░░░░░░░░░] 65.81%",
  "    Refreshes in 4d 21h 23m",
  "",
  "  Five Hour Limit Remaining",
  "    [██████████████████████████████████████████████████] 100.00%",
  "    Quota available",
].join("\n");

class FakePtyProcess implements PtyAdapter.PtyProcess {
  readonly pid = 999999;
  readonly writes: string[] = [];
  readonly kills: Array<string | undefined> = [];
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: PtyAdapter.PtyExitEvent) => void>();
  private exited = false;
  private readonly onWriteHandler: ((data: string, proc: FakePtyProcess) => void) | undefined;

  constructor(onWriteHandler?: (data: string, proc: FakePtyProcess) => void) {
    this.onWriteHandler = onWriteHandler;
  }

  emitData(data: string): void {
    for (const listener of this.dataListeners) listener(data);
  }

  emitExit(exitCode = 0, signal: number | null = null): void {
    if (this.exited) return;
    this.exited = true;
    for (const listener of this.exitListeners) listener({ exitCode, signal });
  }

  write(data: string | Buffer): void {
    const text = typeof data === "string" ? data : data.toString("utf8");
    this.writes.push(text);
    this.onWriteHandler?.(text, this);
  }

  resize(): void {}

  kill(signal?: string): void {
    this.kills.push(signal);
    this.emitExit(0, 15);
  }

  onData(callback: (data: string) => void): () => void {
    this.dataListeners.add(callback);
    return () => this.dataListeners.delete(callback);
  }

  onExit(callback: (event: PtyAdapter.PtyExitEvent) => void): () => void {
    this.exitListeners.add(callback);
    return () => this.exitListeners.delete(callback);
  }
}

const makeTempProfile = Effect.acquireRelease(
  Effect.promise(async () => {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-agy-limits-test-"));
    const acpDir = NodePath.join(dir, "antigravity-acp");
    await NodeFSP.mkdir(acpDir, { recursive: true, mode: 0o700 });
    await NodeFSP.writeFile(NodePath.join(acpDir, "antigravity-oauth-token"), "{}", {
      mode: 0o600,
    });
    return dir;
  }),
  (dir) =>
    Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
);

describe("antigravityUsageLimitsFork parser & VT emulator", () => {
  it("parses both Gemini and Claude/GPT groups with remaining%, resets, and pace compatibility", () => {
    const parsed = parseAgyUsageScreen(SAMPLE_BOTH_GROUPS_SCREEN, {
      bannerText: SAMPLE_BANNER,
      nowMs: FIXED_NOW_MS,
    });
    assert.strictEqual(parsed.ok, true);
    assert.strictEqual(parsed.plan, "Google AI Ultra");
    assert.strictEqual(parsed.windows.length, 4);

    const byId = new Map(parsed.windows.map((w) => [w.id, w] as const));
    const gemini5h = byId.get("5h");
    const geminiWeekly = byId.get("weekly");
    const claude5h = byId.get("5h_claude_gpt");
    const claudeWeekly = byId.get("weekly_claude_gpt");

    assert.isDefined(gemini5h);
    assert.strictEqual(gemini5h.kind, "session");
    assert.strictEqual(gemini5h.label, "5-hour");
    assert.strictEqual(gemini5h.windowDurationMins, 300);
    assert.strictEqual(gemini5h.usedPercent, 10.7);
    assert.strictEqual(remainingPercent(gemini5h), 89);
    assert.strictEqual(
      gemini5h.resetsAt,
      DateTime.formatIso(DateTime.makeUnsafe(FIXED_NOW_MS + (3 * 3600 + 47 * 60) * 1_000)),
    );
    assert.isNumber(paceRemainingPercent(gemini5h, FIXED_NOW_MS));
    assert.strictEqual(paceOf(gemini5h, FIXED_NOW_MS), "under");

    assert.isDefined(geminiWeekly);
    assert.strictEqual(geminiWeekly.kind, "weekly");
    assert.strictEqual(geminiWeekly.label, "Weekly");
    assert.strictEqual(geminiWeekly.windowDurationMins, 10080);
    assert.strictEqual(geminiWeekly.usedPercent, 29.2);
    assert.strictEqual(remainingPercent(geminiWeekly), 71);
    assert.strictEqual(
      geminiWeekly.resetsAt,
      DateTime.formatIso(
        DateTime.makeUnsafe(FIXED_NOW_MS + (5 * 86400 + 19 * 3600 + 33 * 60) * 1_000),
      ),
    );
    assert.strictEqual(paceOf(geminiWeekly, FIXED_NOW_MS), "ahead");

    assert.isDefined(claude5h);
    assert.strictEqual(claude5h.kind, "session");
    assert.strictEqual(claude5h.label, "5-hour · Claude/GPT");
    assert.strictEqual(claude5h.usedPercent, 0);
    assert.strictEqual(remainingPercent(claude5h), 100);
    assert.isUndefined(claude5h.resetsAt);
    assert.isNull(paceOf(claude5h, FIXED_NOW_MS));

    assert.isDefined(claudeWeekly);
    assert.strictEqual(claudeWeekly.kind, "weekly");
    assert.strictEqual(claudeWeekly.label, "Weekly · Claude/GPT");
    assert.strictEqual(claudeWeekly.usedPercent, 34.2);
    assert.strictEqual(remainingPercent(claudeWeekly), 66);
    assert.strictEqual(
      claudeWeekly.resetsAt,
      DateTime.formatIso(
        DateTime.makeUnsafe(FIXED_NOW_MS + (4 * 86400 + 21 * 3600 + 23 * 60) * 1_000),
      ),
    );
  });

  it("parses a screen with only one group present", () => {
    const geminiOnly = [
      "GEMINI MODELS",
      "  Weekly Limit Remaining",
      "    [████████████████████░░░░░░░░░░] 50.00%",
      "    Resets in 2d 4h",
      "  Five Hour Limit Remaining",
      "    [░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░] 0.00%",
      "    Refreshes in < 1m",
    ].join("\n");
    const parsed = parseAgyUsageScreen(geminiOnly, { nowMs: FIXED_NOW_MS });
    assert.strictEqual(parsed.ok, true);
    assert.strictEqual(parsed.windows.length, 2);
    const byId = new Map(parsed.windows.map((w) => [w.id, w] as const));
    assert.strictEqual(byId.get("weekly")?.usedPercent, 50);
    assert.strictEqual(byId.get("5h")?.usedPercent, 100);
    assert.strictEqual(
      byId.get("5h")?.resetsAt,
      DateTime.formatIso(DateTime.makeUnsafe(FIXED_NOW_MS + 30_000)),
    );
  });

  it("handles a 100% window with no reset line at all", () => {
    const noReset = [
      "CLAUDE AND GPT MODELS",
      "  Five Hour Limit Remaining",
      "    [██████████████████████████████] 100%",
    ].join("\n");
    const parsed = parseAgyUsageScreen(noReset, { nowMs: FIXED_NOW_MS });
    assert.strictEqual(parsed.ok, true);
    assert.strictEqual(parsed.windows.length, 1);
    assert.strictEqual(parsed.windows[0]?.id, "5h_claude_gpt");
    assert.strictEqual(parsed.windows[0]?.usedPercent, 0);
    assert.isUndefined(parsed.windows[0]?.resetsAt);
  });

  it("parses relative duration strings", () => {
    assert.strictEqual(parseRelativeDurationSeconds("< 1m"), 30);
    assert.strictEqual(parseRelativeDurationSeconds("4h 0m"), 4 * 3600);
    assert.strictEqual(parseRelativeDurationSeconds("5d 19h 45m"), 5 * 86400 + 19 * 3600 + 45 * 60);
    assert.isUndefined(parseRelativeDurationSeconds("Quota available"));
  });

  it("reconstructs ANSI/VT cursor movement and chunked escape sequences", () => {
    const vt = new MinimalVtScreen(10, 60);
    vt.feed("\x1b[?1049h\x1b[1;1HGEMINI MODELS\x1b[2;3HWeekly Limit Remaining");
    vt.feed("\x1b[3;5H75.00%");
    vt.feed("\x1b[4;5HRefreshes in 1d 2h");
    const parsed = parseAgyUsageScreen(vt.text(), { nowMs: FIXED_NOW_MS });
    assert.strictEqual(parsed.ok, true);
    assert.strictEqual(parsed.windows[0]?.usedPercent, 25);
  });

  it("parses GEMINI MODELS when Bubble Tea leaves autocomplete redraw artifacts on the header line (live T3 regression)", () => {
    const capturedWithRedrawArtifact = [
      "└ Models & Quota",
      "",
      "  Account: u@example.invalid",
      "",
      "GEMINI MODELSe · enter Select · tab Complete",
      "  Models within this group: Gemini 4 Neon, Gemini 4 Carbon, Gemini 4 Argon, Gemini 4 Hydrogen, Orchestrator (Neon), Orch",
      "",
      "",
      "  Weekly Limit Remaining",
      "    [██████████████████████████████████░░░░░░░░░░░░░░░░] 67.83%",
      "    Refreshes in 5d 18h 25m",
      "",
      "  Five Hour Limit Remaining",
      "    [███████████████████████████████████████░░░░░░░░░░░] 77.55%",
      "    Refreshes in 2h 39m",
      "",
      "",
      "CLAUDE AND GPT MODELS",
      "  Models within this group: Claude Opus 5.5, Claude Sonnet 5.5, GPT-OSS 120B",
      "",
      "  Weekly Limit Remaining",
      "    [█████████████████████████████████░░░░░░░░░░░░░░░░░] 65.81%",
      "    Refreshes in 4d 20h 15m",
      "",
      "  Five Hour Limit Remaining",
      "    [██████████████████████████████████████████████████] 100.00%",
      "    Quota available",
    ].join("\n");
    const parsed = parseAgyUsageScreen(capturedWithRedrawArtifact, { nowMs: FIXED_NOW_MS });
    assert.strictEqual(parsed.ok, true);
    assert.deepStrictEqual(
      parsed.windows.map((w) => w.id),
      ["weekly", "5h", "weekly_claude_gpt", "5h_claude_gpt"],
    );
  });

  it("enforces the 15-minute minimum refresh interval floor and allows upward overrides", () => {
    assert.strictEqual(resolveAntigravityLimitsRefreshMs({}), ANTIGRAVITY_LIMITS_MIN_REFRESH_MS);
    assert.strictEqual(
      resolveAntigravityLimitsRefreshMs({ T3_ANTIGRAVITY_LIMITS_REFRESH_SECONDS: "60" }),
      ANTIGRAVITY_LIMITS_MIN_REFRESH_MS,
    );
    assert.strictEqual(
      resolveAntigravityLimitsRefreshMs({ T3_ANTIGRAVITY_LIMITS_REFRESH_SECONDS: "1800" }),
      1_800_000,
    );
  });
});

describe("antigravityUsageLimitsFork safety properties", () => {
  it("makes no network requests to Google hosts and never reads OAuth token files", async () => {
    const sourcePath = NodePath.resolve(import.meta.dirname, "antigravityUsageLimitsFork.ts");
    const source = await NodeFSP.readFile(sourcePath, "utf8");
    const forbidden = [
      "googleapis.com",
      "cloudcode-pa",
      "FetchQuotaStatus",
      "loadCodeAssist",
      "retrieveUserQuota",
      "HttpClient",
      "fetch(",
      "access_token",
      "refresh_token",
      "acp_token.json",
    ];
    for (const token of forbidden) {
      assert.isFalse(source.includes(token), `Forbidden token found in source: ${token}`);
    }
    assert.isFalse(
      /readFile(?:String)?\([^)]*antigravity-oauth-token/.test(source),
      "Source must never read antigravity-oauth-token",
    );
  });

  it.effect(
    "aborts without sending /usage on unexpected prompts (login, trust, update, onboarding)",
    () =>
      Effect.gen(function* () {
        const prompts = [
          "Sign in with Google to continue",
          "Do you trust the contents of this project?",
          "Update available: press y to update",
          "Welcome to Antigravity — Terms of Service",
          "Authentication failed: Token expired",
        ];
        for (const promptText of prompts) {
          assert.isDefined(detectUnexpectedAgyPrompt(promptText));
          const writes: string[] = [];
          const ptyLayer = Layer.succeed(PtyAdapter.PtyAdapter, {
            spawn: () =>
              Effect.sync(() => {
                const proc = new FakePtyProcess((data, p) => {
                  writes.push(data);
                  if (data === "\x1b" || data === "\x03") p.emitExit(0, null);
                });
                queueMicrotask(() => proc.emitData(promptText));
                return proc;
              }),
          });
          const result = yield* captureAgyUsageScreen({
            executablePath: "/fake/agy",
            probeHome: "/tmp/home",
            scratchCwd: "/tmp/cwd",
            logFile: "/tmp/agy.log",
            baseEnv: {},
            timeoutMs: 5_000,
            settleScale: 0,
          }).pipe(Effect.provide(ptyLayer), Effect.provideService(HostProcess.Platform, "linux"));
          assert.strictEqual(result.ok, false);
          assert.isFalse(
            writes.some((w) => w.includes("/usage")),
            `Must not send /usage on prompt: ${promptText}`,
          );
        }
      }),
  );

  it.effect("sends only /usage, Enter, and quit keys on a normal capture", () =>
    Effect.gen(function* () {
      const writes: string[] = [];
      const ptyLayer = Layer.succeed(PtyAdapter.PtyAdapter, {
        spawn: () =>
          Effect.sync(() => {
            const proc = new FakePtyProcess((data, p) => {
              writes.push(data);
              if (data === "\r") {
                queueMicrotask(() =>
                  p.emitData(`\x1b[2J\x1b[H${SAMPLE_BOTH_GROUPS_SCREEN.replaceAll("\n", "\r\n")}`),
                );
              }
              if (data === "\x1b" || data === "\x03") p.emitExit(0, null);
            });
            queueMicrotask(() => proc.emitData(SAMPLE_BANNER));
            return proc;
          }),
      });

      const result = yield* captureAgyUsageScreen({
        executablePath: "/fake/agy",
        probeHome: "/tmp/home",
        scratchCwd: "/tmp/cwd",
        logFile: "/tmp/agy.log",
        baseEnv: {},
        timeoutMs: 10_000,
        settleScale: 0,
      }).pipe(Effect.provide(ptyLayer), Effect.provideService(HostProcess.Platform, "linux"));
      assert.strictEqual(result.ok, true);
      const allowed = new Set(["/usage", "\r", "\x1b", "\x03"]);
      for (const written of writes) {
        assert.isTrue(allowed.has(written), `Unexpected PTY write: ${JSON.stringify(written)}`);
      }
      assert.isTrue(writes.includes("/usage"));
      assert.isTrue(writes.includes("\r"));
    }),
  );

  it.effect(
    "enforces 15-minute rate limit, caches results, does not retry failures inside window, and respects opt-out/missing binary",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const profileDir = yield* makeTempProfile;
          let spawns = 0;
          let failMode = false;
          const ptyLayer = Layer.succeed(PtyAdapter.PtyAdapter, {
            spawn: () =>
              Effect.sync(() => {
                spawns += 1;
                const proc = new FakePtyProcess((data, p) => {
                  if (data === "\r" && !failMode) {
                    queueMicrotask(() =>
                      p.emitData(
                        `\x1b[2J\x1b[H${SAMPLE_BOTH_GROUPS_SCREEN.replaceAll("\n", "\r\n")}`,
                      ),
                    );
                  }
                  if (data === "\x1b" || data === "\x03") p.emitExit(0, null);
                });
                queueMicrotask(() =>
                  proc.emitData(failMode ? "Sign in with Google" : SAMPLE_BANNER),
                );
                return proc;
              }),
          });

          const settingsLayer = ServerSettings.layerTest({ antigravityUsageLimitsEnabled: true });

          const enabledLayer = Layer.mergeAll(ptyLayer, settingsLayer, NodeServices.layer);
          const disabledLayer = Layer.mergeAll(
            ptyLayer,
            ServerSettings.layerTest({ antigravityUsageLimitsEnabled: false }),
            NodeServices.layer,
          );

          // 1. Missing binary reports undefined (not probeFailed) and never spawns.
          const missingBinProbe = yield* makeAntigravityUsageLimitsProbe({
            profileDirectory: profileDir,
            authMethod: "oauth-personal",
            binaryPath: "",
            processEnvironment: {},
            resolveExecutable: () => Effect.undefined,
            settleScale: 0,
          }).pipe(
            Effect.provide(enabledLayer),
            Effect.provideService(HostProcess.Platform, "linux"),
          );
          assert.isUndefined(yield* missingBinProbe.probe);
          assert.strictEqual(spawns, 0);

          // 2. Opt-out setting returns undefined and never spawns.
          const optedOutProbe = yield* makeAntigravityUsageLimitsProbe({
            profileDirectory: profileDir,
            authMethod: "oauth-personal",
            binaryPath: "",
            processEnvironment: {},
            resolveExecutable: () => Effect.succeed({ executablePath: "/fake/agy" }),
            settleScale: 0,
          }).pipe(
            Effect.provide(disabledLayer),
            Effect.provideService(HostProcess.Platform, "linux"),
          );
          assert.isUndefined(yield* optedOutProbe.probe);
          assert.strictEqual(spawns, 0);

          // 3. Normal probe spawns once, caches for 15 minutes across repeated calls.
          const probe = yield* makeAntigravityUsageLimitsProbe({
            profileDirectory: profileDir,
            authMethod: "oauth-personal",
            binaryPath: "",
            processEnvironment: {},
            resolveExecutable: () => Effect.succeed({ executablePath: "/fake/agy" }),
            settleScale: 0,
          }).pipe(
            Effect.provide(enabledLayer),
            Effect.provideService(HostProcess.Platform, "linux"),
          );

          const first = yield* probe.probe;
          assert.isDefined(first);
          assert.isUndefined(first.unavailable);
          assert.strictEqual(first.windows.length, 4);
          assert.strictEqual(spawns, 1);

          // Second call inside 15m window serves cache without spawning.
          yield* TestClock.adjust("10 minutes");
          const second = yield* probe.probe;
          assert.deepStrictEqual(second, first);
          assert.strictEqual(spawns, 1);

          // 4. After 15m, a failure records lastAttemptAtMs, returns stale good data, and does not retry inside the window.
          failMode = true;
          yield* TestClock.adjust("6 minutes");
          const third = yield* probe.probe;
          assert.strictEqual(spawns, 2);
          assert.deepStrictEqual(third?.windows, first.windows);

          yield* TestClock.adjust("5 minutes");
          const fourth = yield* probe.probe;
          assert.strictEqual(spawns, 2);
          assert.deepStrictEqual(fourth?.windows, first.windows);

          // 5. Clear resets cache so a new account can probe immediately.
          failMode = false;
          yield* probe.clear;
          const fifth = yield* probe.probe;
          assert.strictEqual(spawns, 3);
          assert.strictEqual(fifth?.windows.length, 4);
        }),
      ),
  );

  it.live("cleans up on hard timeout without hanging", () =>
    Effect.gen(function* () {
      const kills: Array<string | undefined> = [];
      const ptyLayer = Layer.succeed(PtyAdapter.PtyAdapter, {
        spawn: () =>
          Effect.sync(() => {
            const proc = new FakePtyProcess();
            const origKill = proc.kill.bind(proc);
            proc.kill = (sig) => {
              kills.push(sig);
              origKill(sig);
            };
            return proc;
          }),
      });
      const result = yield* captureAgyUsageScreen({
        executablePath: "/fake/agy",
        probeHome: "/tmp/home",
        scratchCwd: "/tmp/cwd",
        logFile: "/tmp/agy.log",
        baseEnv: {},
        timeoutMs: 120,
        settleScale: 0,
      }).pipe(Effect.provide(ptyLayer), Effect.provideService(HostProcess.Platform, "linux"));
      assert.strictEqual(result.ok, false);
      assert.isTrue(kills.includes("SIGTERM"));
    }),
  );

  it.live("runs end-to-end against a fake agy binary through real NodePtyAdapter", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const profileDir = yield* makeTempProfile;
        const fakeAgy = NodePath.join(profileDir, "fake-agy.sh");
        const script = [
          "#!/bin/sh",
          "printf '\\033[2J\\033[HAntigravity CLI 1.5.18\\nu@example.invalid (Google AI Ultra)\\n? for shortcuts\\n'",
          "IFS= read -r line",
          'case "$line" in',
          "  *usage*)",
          "    printf '\\033[2J\\033[HGEMINI MODELS\\n  Weekly Limit Remaining\\n    [████] 80.00%%\\n    Refreshes in 3d 2h\\n  Five Hour Limit Remaining\\n    [████] 90.00%%\\n    Refreshes in 2h 30m\\nCLAUDE AND GPT MODELS\\n  Weekly Limit Remaining\\n    [████] 60.00%%\\n    Refreshes in 4d 1h\\n  Five Hour Limit Remaining\\n    [████] 100.00%%\\n    Quota available\\n'",
          "    ;;",
          "esac",
          "sleep 30",
        ].join("\n");
        yield* Effect.promise(async () => {
          await NodeFSP.writeFile(fakeAgy, script, { mode: 0o755 });
        });

        const probe = yield* makeAntigravityUsageLimitsProbe({
          profileDirectory: profileDir,
          authMethod: "oauth-personal",
          binaryPath: fakeAgy,
          processEnvironment: process.env,
          resolveExecutable: () => Effect.succeed({ executablePath: fakeAgy }),
          timeoutMs: 10_000,
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              NodePtyAdapter.layer,
              ServerSettings.layerTest({ antigravityUsageLimitsEnabled: true }),
            ).pipe(Layer.provideMerge(NodeServices.layer)),
          ),
          Effect.provideService(HostProcess.Platform, "linux"),
        );

        const limits = yield* probe.probe;
        assert.isDefined(limits);
        assert.isUndefined(limits.unavailable);
        assert.strictEqual(limits.windows.length, 4);
        assert.strictEqual(limits.windows.find((w) => w.id === "5h")?.usedPercent, 10);
        assert.strictEqual(limits.windows.find((w) => w.id === "weekly")?.usedPercent, 20);
        assert.strictEqual(limits.windows.find((w) => w.id === "5h_claude_gpt")?.usedPercent, 0);
        assert.strictEqual(
          limits.windows.find((w) => w.id === "weekly_claude_gpt")?.usedPercent,
          40,
        );

        // Verify token symlink in isolated probe home points to antigravity-acp and never copied.
        const linkTarget = yield* Effect.promise(() =>
          NodeFSP.readlink(
            NodePath.join(
              profileDir,
              "limits-probe",
              "home",
              ".gemini",
              "antigravity-cli",
              "antigravity-oauth-token",
            ),
          ),
        );
        assert.strictEqual(
          linkTarget,
          NodePath.join(profileDir, "antigravity-acp", "antigravity-oauth-token"),
        );

        // Verify disk cache was written with mode 0o600 and contains no email or token.
        const cachePath = NodePath.join(profileDir, "limits-probe", "cache.json");
        const cacheText = yield* Effect.promise(() => NodeFSP.readFile(cachePath, "utf8"));
        assert.isFalse(cacheText.includes("u@example.invalid"));
        assert.isFalse(cacheText.includes("antigravity-oauth-token"));
      }),
    ),
  );
});
