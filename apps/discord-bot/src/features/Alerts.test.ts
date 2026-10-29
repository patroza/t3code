// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("dfx", () => ({
  DiscordConfig: { DiscordConfig: {} },
  DiscordREST: {},
}));

import {
  bridgeAlertDelivery,
  classifySessionLastError,
  fatalAlertDelivery,
  formatAlertCause,
  formatLongRunningTurnMilestone,
  isExpectedSessionLastError,
  listLongRunningTurns,
  listSessionErrors,
  longRunningTurnMilestoneMs,
  nextLongRunningTurnMilestoneMs,
  selectSessionErrorsForAlert,
  sessionErrorAgeMs,
  sessionErrorAlertDelivery,
  sessionErrorAlertKey,
  SESSION_ERROR_MAX_AGE_MS,
  shouldAlertLongRunningTurn,
  trackSustainedHotProcesses,
  advanceConditionLadder,
  defaultRunawayProcessRules,
  formatProcessLabel,
  formatRssTrend,
  hostPressureAlertContent,
  INITIAL_HOST_PRESSURE_STATE,
  parseMemPsi,
  parseProcStat,
  escapeDiscordText,
  runawayProcessAlertContent,
  recoveredAlertContent,
  topProcesses,
  trackHostPressure,
  type ConditionLadderEntry,
  type HostPressureSample,
  type HostPressureState,
  TURN_RUNNING_MIN_MS,
  type ProcInfo,
  type ProcSustainState,
} from "./Alerts.ts";

const TICK_MS = 60_000;
const CPU_THRESHOLD = 50;
const RSS_THRESHOLD = 768;
const SUSTAINED_FOR_MS = 4 * TICK_MS;

describe("persisted long-running turns", () => {
  it.each(["v2-only", "both", "v1"] as const)(
    "reads active work from a %s database without alerting for completed or queued work",
    (schema) => {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-alert-turns-"));
      const dbPath = NodePath.join(tempDir, schema === "v1" ? "state.sqlite" : "statev2.sqlite");
      const now = DateTime.nowUnsafe();
      const timestamp = (minutes: number) =>
        DateTime.formatIso(DateTime.subtract(now, { minutes }));
      const rows = [
        ["old-thread", "old-run", "running", timestamp(30)],
        ["recent-thread", "recent-run", "running", timestamp(2)],
        ["completed-thread", "completed-run", "completed", timestamp(90)],
        ["queued-thread", "queued-run", "queued", timestamp(90)],
      ];

      try {
        NodeChildProcess.execFileSync(
          "python3",
          [
            "-c",
            [
              "import json, sqlite3, sys",
              "db = sqlite3.connect(sys.argv[1])",
              "schema, rows = sys.argv[2], json.loads(sys.argv[3])",
              "if schema != 'v1':",
              "  db.execute('CREATE TABLE orchestration_v2_projection_runs (thread_id TEXT, run_id TEXT, status TEXT, requested_at TEXT)')",
              "  db.executemany('INSERT INTO orchestration_v2_projection_runs VALUES (?, ?, ?, ?)', rows)",
              "if schema != 'v2-only':",
              "  db.execute('CREATE TABLE projection_turns (thread_id TEXT, turn_id TEXT, state TEXT, requested_at TEXT)')",
              "  legacy = rows if schema == 'v1' else [('stale-thread', 'stale-turn', 'running', rows[0][3])]",
              "  db.executemany('INSERT INTO projection_turns VALUES (?, ?, ?, ?)', legacy)",
              "db.commit()",
            ].join("\n"),
            dbPath,
            schema,
            JSON.stringify(rows),
          ],
          { encoding: "utf8" },
        );

        expect(listLongRunningTurns(dbPath, TURN_RUNNING_MIN_MS)).toEqual([
          { threadId: "old-thread", turnId: "old-run", ageMin: 30 },
        ]);
      } finally {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }
    },
  );
});

const proc = (over: Partial<ProcInfo> & { pid: number }): ProcInfo => ({
  pid: over.pid,
  rssMb: over.rssMb ?? 100,
  cpuSeconds: over.cpuSeconds ?? 0,
  cmd: over.cmd ?? `/bin/proc-${over.pid}`,
  label: over.label ?? `proc-${over.pid}`,
  ...(over.startTicks !== undefined ? { startTicks: over.startTicks } : {}),
});

/** Replay a fixed per-tick behaviour and return the final tick's hot list. */
function run(
  ticks: ReadonlyArray<ReadonlyArray<ProcInfo>>,
  startMs = 1_000_000,
): {
  hot: ReturnType<typeof trackSustainedHotProcesses>["hot"];
  state: ReadonlyMap<number, ProcSustainState>;
} {
  let state: ReadonlyMap<number, ProcSustainState> = new Map();
  let hot: ReturnType<typeof trackSustainedHotProcesses>["hot"] = [];
  ticks.forEach((procs, index) => {
    const result = trackSustainedHotProcesses({
      prev: state,
      procs,
      nowMs: startMs + index * TICK_MS,
      resolveRule: () => ({
        id: "default",
        cpuPercentThreshold: CPU_THRESHOLD,
        rssMbThreshold: RSS_THRESHOLD,
        sustainedForMs: SUSTAINED_FOR_MS,
      }),
    });
    state = result.next;
    hot = result.hot;
  });
  return { hot, state };
}

describe("formatAlertCause", () => {
  it("pretty-prints Effect Cause failures instead of [Object]", () => {
    const cause = Cause.fail(new Error("stream tip update failed"));
    const rendered = formatAlertCause(cause);
    expect(rendered).toContain("stream tip update failed");
    expect(rendered).not.toContain("[Object]");
  });

  it("falls back for plain Errors and strings", () => {
    expect(formatAlertCause(new Error("boom"))).toContain("boom");
    expect(formatAlertCause("plain")).toBe("plain");
  });

  it("keeps complete causes by default while honoring explicit preview limits", () => {
    const cause = `start\n${"x".repeat(4_000)}\nend`;
    expect(formatAlertCause(cause)).toBe(cause);
    expect(formatAlertCause(cause, 20)).toBe(`${cause.slice(0, 20)}…`);
  });
});

describe("Discord alert content", () => {
  it("reads the complete persisted session error before attaching it", () => {
    const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-alert-trace-"));
    const dbPath = NodePath.join(tempDir, "state.sqlite");
    const trace = `Error: Invalid params\n${"    at decodeFrame (file:///long/path.js:1:1)\n".repeat(80)}`;

    try {
      NodeChildProcess.execFileSync(
        "python3",
        [
          "-c",
          [
            "import sqlite3, sys",
            "db = sqlite3.connect(sys.argv[1])",
            "db.execute('CREATE TABLE projection_thread_sessions (thread_id TEXT, last_error TEXT, status TEXT, updated_at TEXT)')",
            "db.execute('INSERT INTO projection_thread_sessions VALUES (?, ?, ?, ?)', ('thread-1', sys.argv[2], 'error', '2026-07-28T00:00:00Z'))",
            "db.commit()",
          ].join("\n"),
          dbPath,
          trace,
        ],
        { encoding: "utf8" },
      );

      expect(trace.length).toBeGreaterThan(300);
      expect(listSessionErrors(dbPath)).toEqual([
        {
          threadId: "thread-1",
          lastError: trace,
          status: "error",
          updatedAt: "2026-07-28T00:00:00Z",
        },
      ]);
    } finally {
      NodeFS.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("attaches the complete T3 session stack as one text file", () => {
    const trace = [
      "Error: Invalid params",
      ...Array.from(
        { length: 80 },
        (_, index) =>
          `    at decodeFrame${index} (file:///var/lib/t3/src/t3code/node_modules/effect/frame-${index}.js:877:8)`,
      ),
    ].join("\n");
    const delivery = sessionErrorAlertDelivery("2d9ccf35-a36a-41bc-a762-523f5e423f41", trace);

    expect(delivery.content).toContain("thread=`2d9ccf35-a36a-41bc-a762-523f5e423f41`");
    expect(delivery.content).not.toContain("Invalid params");
    expect(delivery.files).toHaveLength(1);
    expect(delivery.files[0]?.name).toBe(
      "t3-session-error-2d9ccf35-a36a-41bc-a762-523f5e423f41.txt",
    );
    expect(delivery.files[0]?.mimeType).toBe("text/plain;charset=utf-8");
    expect(new TextDecoder().decode(delivery.files[0]?.data)).toBe(trace);
  });

  it("keeps fatal and bridge traces out of message content and intact in attachments", () => {
    const trace = `start\n${"x".repeat(4_000)}\nend`;
    for (const delivery of [
      fatalAlertDelivery("failure", trace),
      bridgeAlertDelivery("failure", trace),
    ]) {
      expect(delivery.content).not.toContain(trace);
      expect(delivery.files).toHaveLength(1);
      expect(delivery.files[0]?.name.endsWith(".txt")).toBe(true);
      expect(new TextDecoder().decode(delivery.files[0]?.data)).toBe(trace);
    }
  });

  it("puts t3 thread id on the short fatal/bridge Discord message", () => {
    const trace = "stack goes in the attachment";
    const threadId = "44c2ab99-729b-4999-83cc-3a4dd04432e0";
    const channelId = "1532989230219919520";
    const fatal = fatalAlertDelivery("T3 thread subscription exited", trace, {
      threadId,
      channelId,
    });
    expect(fatal.content).toContain("**FATAL: T3 thread subscription exited**");
    expect(fatal.content).toContain(`thread=\`${threadId}\``);
    expect(fatal.content).toContain(`channel=\`${channelId}\``);
    expect(fatal.content).not.toContain(trace);
    expect(new TextDecoder().decode(fatal.files[0]?.data)).toBe(trace);

    const bridge = bridgeAlertDelivery("Working heartbeat failed", trace, { threadId });
    expect(bridge.content).toContain("**BRIDGE: Working heartbeat failed**");
    expect(bridge.content).toContain(`thread=\`${threadId}\``);
    expect(bridge.content).not.toContain("channel=");
  });
});

describe("session last_error alert classification", () => {
  it("treats orphan / server-restart recover text as expected (not fatal)", () => {
    expect(
      isExpectedSessionLastError(
        "Recovered orphan session (server_restart). Send a follow-up to resume.",
      ),
    ).toBe(true);
    expect(
      isExpectedSessionLastError(
        "Server restarted while the agent was working. Send a follow-up to resume it.",
      ),
    ).toBe(true);
    expect(classifySessionLastError({ lastError: "Recovered orphan session (reaper)." })).toBe(
      "ignore",
    );
  });

  it("keeps real provider failures as fatal", () => {
    expect(
      classifySessionLastError({
        lastError: "ProviderAdapterProcessError: Failed to spawn ACP process for command: grok",
        status: "error",
      }),
    ).toBe("fatal");
  });

  it("filters recoveries and caps fatals for posting", () => {
    const selected = selectSessionErrorsForAlert(
      [
        {
          threadId: "t1",
          lastError: "Recovered orphan session (server_restart). Send a follow-up to resume.",
        },
        {
          threadId: "t2",
          lastError: "Recovered orphan session (server_restart). Send a follow-up to resume.",
        },
        { threadId: "t3", lastError: "Provider adapter process error (grok)" },
        { threadId: "t4", lastError: "Provider adapter process error (codex)" },
      ],
      1,
    );
    expect(selected.ignoredRecoveryCount).toBe(2);
    expect(selected.ignoredStaleCount).toBe(0);
    expect(selected.fatals).toHaveLength(1);
    expect(selected.fatals[0]?.threadId).toBe("t3");
  });

  it("drops sticky last_error rows older than the max age window", () => {
    const nowMs = Date.parse("2026-08-01T07:30:00.000Z");
    const selected = selectSessionErrorsForAlert(
      [
        {
          // The live spam: 10-day-old Invalid params still status=error.
          threadId: "2d9ccf35-a36a-41bc-a762-523f5e423f41",
          lastError: "Error: Invalid params\n    at decodeJsonError (...)",
          status: "error",
          updatedAt: "2026-07-21T15:11:34.330Z",
        },
        {
          threadId: "fresh-1",
          lastError: "ProviderAdapterProcessError: Failed to spawn ACP process for command: grok",
          status: "error",
          updatedAt: "2026-08-01T07:00:00.000Z",
        },
      ],
      5,
      { nowMs, maxAgeMs: SESSION_ERROR_MAX_AGE_MS },
    );
    expect(selected.ignoredStaleCount).toBe(1);
    expect(selected.fatals).toEqual([
      {
        threadId: "fresh-1",
        lastError: "ProviderAdapterProcessError: Failed to spawn ACP process for command: grok",
      },
    ]);
    expect(
      classifySessionLastError({
        lastError: "Error: Invalid params",
        status: "error",
        updatedAt: "2026-07-21T15:11:34.330Z",
        nowMs,
      }),
    ).toBe("stale");
    expect(sessionErrorAgeMs("2026-07-21T15:11:34.330Z", nowMs)).toBeGreaterThan(
      SESSION_ERROR_MAX_AGE_MS,
    );
  });

  it("shares cooldown keys across threads with the same failure signature", () => {
    const a = sessionErrorAlertKey(
      "aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb",
      "Failed to spawn ACP process for thread aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb",
    );
    const b = sessionErrorAlertKey(
      "cccccccc-1111-2222-3333-dddddddddddd",
      "Failed to spawn ACP process for thread cccccccc-1111-2222-3333-dddddddddddd",
    );
    expect(a).toBe(b);
    expect(a.startsWith("session-error-sig:")).toBe(true);
  });
});

describe("long-running turn alert milestones (0.25h × 2ⁿ)", () => {
  const min = (n: number) => n * 60_000;

  it("stays quiet below the first 15m threshold", () => {
    expect(longRunningTurnMilestoneMs(min(14))).toBeNull();
    expect(shouldAlertLongRunningTurn(min(14), undefined).alert).toBe(false);
  });

  it("pages at 15m, 30m, 1h, 2h, 4h and not between rungs", () => {
    // First page at 15m.
    expect(longRunningTurnMilestoneMs(min(15))).toBe(min(15));
    expect(shouldAlertLongRunningTurn(min(15), undefined)).toEqual({
      alert: true,
      milestoneMs: min(15),
    });
    // Still on the 15m rung until 30m — no re-page.
    expect(longRunningTurnMilestoneMs(min(29))).toBe(min(15));
    expect(shouldAlertLongRunningTurn(min(29), min(15)).alert).toBe(false);
    // 30m / 1h / 2h / 4h rungs.
    expect(longRunningTurnMilestoneMs(min(30))).toBe(min(30));
    expect(longRunningTurnMilestoneMs(min(75))).toBe(min(60)); // the 75m spam case
    expect(longRunningTurnMilestoneMs(min(125))).toBe(min(120));
    expect(longRunningTurnMilestoneMs(min(240))).toBe(min(240));

    let last: number | undefined;
    const ages = [15, 20, 25, 30, 45, 59, 60, 75, 90, 119, 120, 180, 240];
    const paged: number[] = [];
    for (const ageMin of ages) {
      const decision = shouldAlertLongRunningTurn(min(ageMin), last);
      if (decision.alert) {
        paged.push(ageMin);
        last = decision.milestoneMs;
      }
    }
    // Only when a new doubling rung is crossed — not every 10 minutes.
    expect(paged).toEqual([15, 30, 60, 120, 240]);
  });

  it("re-pages at most once for the current rung after a restart", () => {
    // Bot restart loses last milestone; age is already 75m → one page for 1h rung.
    const decision = shouldAlertLongRunningTurn(min(75), undefined);
    expect(decision).toEqual({ alert: true, milestoneMs: min(60) });
    expect(shouldAlertLongRunningTurn(min(75), min(60)).alert).toBe(false);
    // Next page only when age reaches 2h.
    expect(shouldAlertLongRunningTurn(min(119), min(60)).alert).toBe(false);
    expect(shouldAlertLongRunningTurn(min(120), min(60))).toEqual({
      alert: true,
      milestoneMs: min(120),
    });
  });

  it("formats milestone labels and next-rung helper", () => {
    expect(formatLongRunningTurnMilestone(min(15))).toBe("15m");
    expect(formatLongRunningTurnMilestone(min(30))).toBe("30m");
    expect(formatLongRunningTurnMilestone(min(60))).toBe("1h");
    expect(formatLongRunningTurnMilestone(min(120))).toBe("2h");
    expect(nextLongRunningTurnMilestoneMs(TURN_RUNNING_MIN_MS)).toBe(min(30));
    expect(nextLongRunningTurnMilestoneMs(min(60))).toBe(min(120));
  });
});

describe("trackSustainedHotProcesses", () => {
  it("does not alert on a long-lived but idle process", () => {
    // The reported bug: a process with lots of cumulative CPU time that now barely
    // moves (a few seconds every tick) must never alert. +2s of CPU per 60s tick
    // is ~3% of a core.
    const ticks = Array.from({ length: 12 }, (_unused, i) => [
      proc({ pid: 773, rssMb: 141, cpuSeconds: 232 + i * 2 }),
    ]);
    expect(run(ticks).hot).toEqual([]);
  });

  it("alerts once a process stays CPU-hot for the sustained window", () => {
    // A full core busy: +60s of CPU per 60s tick = ~100%.
    const ticks = Array.from({ length: 6 }, (_unused, i) => [
      proc({ pid: 900, rssMb: 200, cpuSeconds: i * 60 }),
    ]);
    const hot = run(ticks).hot;
    expect(hot).toHaveLength(1);
    expect(hot[0]!.pid).toBe(900);
    expect(hot[0]!.cpuPercent).toBeGreaterThanOrEqual(CPU_THRESHOLD);
    expect(Math.round(hot[0]!.sustainedMs / TICK_MS)).toBe(4);
  });

  it("does not alert before the sustained window elapses", () => {
    const ticks = Array.from({ length: 5 }, (_unused, i) => [
      proc({ pid: 900, cpuSeconds: i * 60 }),
    ]);
    expect(run(ticks).hot).toEqual([]);
  });

  it("resets the streak when CPU drops back to idle", () => {
    const hotTick = (i: number) => [proc({ pid: 900, cpuSeconds: i * 60 })];
    const idleTick = (cpu: number) => [proc({ pid: 900, cpuSeconds: cpu })];
    // Three hot ticks, then idle — must clear, not alert.
    const ticks = [hotTick(0), hotTick(1), hotTick(2), hotTick(3), idleTick(181), idleTick(182)];
    expect(run(ticks).hot).toEqual([]);
  });

  it("alerts on sustained high RSS even at zero CPU", () => {
    const ticks = Array.from({ length: 5 }, () => [proc({ pid: 950, rssMb: 900, cpuSeconds: 5 })]);
    const hot = run(ticks).hot;
    expect(hot).toHaveLength(1);
    expect(hot[0]!.rssMb).toBe(900);
    expect(hot[0]!.cpuPercent).toBe(0);
  });

  it("treats a reused pid as a new process and resets its streak", () => {
    const busy = Array.from({ length: 4 }, (_unused, i) => [
      proc({ pid: 900, cpuSeconds: i * 60 }),
    ]);
    // pid 900 reappears with a lower cumulative counter → different process.
    const reused = [proc({ pid: 900, cpuSeconds: 1 })];
    expect(run([...busy, reused]).hot).toEqual([]);
  });

  it("detects pid reuse via start time even when the CPU counter is higher", () => {
    const busy = Array.from({ length: 4 }, (_unused, i) => [
      proc({ pid: 900, cpuSeconds: i * 60, startTicks: 1 }),
    ]);
    const reused = [proc({ pid: 900, cpuSeconds: 10_000, startTicks: 2 })];
    const r = run([...busy, reused]);
    expect(r.hot).toEqual([]);
    expect(r.state.get(900)!.hotSinceByRule).toEqual({});
  });

  it("restarts the streak after a sample gap instead of crediting the gap", () => {
    let state: ReadonlyMap<number, ProcSustainState> = new Map();
    const rule = () => ({
      id: "r",
      rssMbThreshold: 500,
      cpuPercentThreshold: null,
      sustainedForMs: SUSTAINED_FOR_MS,
    });
    const a = trackSustainedHotProcesses({
      prev: state,
      procs: [proc({ pid: 1, rssMb: 900 })],
      nowMs: 0,
      resolveRule: rule,
    });
    state = a.next;
    const b = trackSustainedHotProcesses({
      prev: state,
      procs: [proc({ pid: 1, rssMb: 900 })],
      nowMs: 60 * TICK_MS,
      resolveRule: rule,
    });
    expect(b.hot).toEqual([]);
  });

  it("keeps an alerting process alive through a short cool spell (no recovery flap)", () => {
    // 100% from tick 1 (alerts at tick 5 after the 4m window), one 40% tick, then hot again.
    const cpu = [0, 60, 120, 180, 240, 300, 324, 384];
    const hotPerTick = cpu.map(
      (_c, i) => run(cpu.slice(0, i + 1).map((c) => [proc({ pid: 5, cpuSeconds: c })])).hot.length,
    );
    expect(hotPerTick).toEqual([0, 0, 0, 0, 0, 1, 1, 1]);
    // But a long cool spell (≥ 3m) clears it.
    const cleared = [0, 60, 120, 180, 240, 300, 301, 302, 303, 304].map((c) => [
      proc({ pid: 5, cpuSeconds: c }),
    ]);
    expect(run(cleared).hot).toEqual([]);
  });

  it("prunes state for processes that have exited", () => {
    const { state } = run([[proc({ pid: 900 })], [proc({ pid: 901 })]]);
    expect(state.has(900)).toBe(false);
    expect(state.has(901)).toBe(true);
  });
});

describe("default runaway process rules", () => {
  const replay = (ticks: ReadonlyArray<ReadonlyArray<ProcInfo>>, memTotalMb = 16_384) => {
    let state: ReadonlyMap<number, ProcSustainState> = new Map();
    let result: ReturnType<typeof trackSustainedHotProcesses> | undefined;
    ticks.forEach((procs, index) => {
      result = trackSustainedHotProcesses({
        prev: state,
        procs,
        nowMs: 1_000_000 + index * TICK_MS,
        resolveRules: () => defaultRunawayProcessRules(memTotalMb),
      });
      state = result.next;
    });
    return result!;
  };

  it("no longer pages for modest RSS on healthy long batch jobs", () => {
    // Real noise: python3 1630MiB ~10% CPU and mariadbd 849MiB ~3% for hours.
    const ticks = Array.from({ length: 240 }, (_unused, i) => [
      proc({ pid: 3699598, rssMb: 1630, cpuSeconds: i * 6 }),
      proc({ pid: 3083063, rssMb: 849, cpuSeconds: i * 2 }),
    ]);
    expect(replay(ticks).hot).toEqual([]);
  });

  it("pages for a process pegging a core for 30 minutes", () => {
    const ticks = Array.from({ length: 32 }, (_unused, i) => [
      proc({ pid: 42, rssMb: 100, cpuSeconds: i * 59 }),
    ]);
    const hot = replay(ticks).hot;
    expect(hot).toHaveLength(1);
    expect(hot[0]!.ruleId).toBe("runaway-cpu");
    expect(replay(ticks.slice(0, 31)).hot).toEqual([]);
  });

  it("pages for a fast memory leak well below half of RAM (rss-growth)", () => {
    // 16 GiB box: +300 MiB/min from 2 GiB → +3.6 GiB over 12m while still < 50% RAM.
    const ticks = Array.from({ length: 13 }, (_unused, i) => [
      proc({ pid: 8, rssMb: 2_000 + i * 300, cpuSeconds: i * 5 }),
    ]);
    const result = replay(ticks);
    expect(result.hot.map((h) => h.ruleId)).toEqual(["rss-growth"]);
    expect(runawayProcessAlertContent(result.hot[0]!, 0)).toContain(
      "**Process memory growing fast: ",
    );
    // Slow growth (+50 MiB/min) and a large flat process stay quiet for hours.
    const slow = Array.from({ length: 120 }, (_unused, i) => [
      proc({ pid: 9, rssMb: 1_000 + i * 50, cpuSeconds: i }),
      proc({ pid: 10, rssMb: 6_000, cpuSeconds: i * 6 }),
    ]);
    expect(replay(slow).hot).toEqual([]);
  });

  it("pages when one process holds over half of RAM for 5 minutes, with RSS trend", () => {
    const ticks = Array.from({ length: 6 }, (_unused, i) => [
      proc({ pid: 7, rssMb: 9_000 + i * 100, cpuSeconds: 0 }),
    ]);
    const result = replay(ticks);
    expect(result.hot).toHaveLength(1);
    expect(result.hot[0]!.ruleId).toBe("runaway-rss");
    expect(result.hot[0]!.rssTrendMb).toBe(500);
    expect(formatRssTrend(result.hot[0]!.rssTrendMb, result.hot[0]!.rssTrendSpanMs)).toBe(
      "+500 MiB over 5m",
    );
  });
});

describe("formatRssTrend", () => {
  it("reports flat, growth, shrink and missing history", () => {
    expect(formatRssTrend(4, 10 * TICK_MS)).toBe("flat over 10m");
    expect(formatRssTrend(212, 14 * TICK_MS)).toBe("+212 MiB over 14m");
    expect(formatRssTrend(-80, 14 * TICK_MS)).toBe("-80 MiB over 14m");
    expect(formatRssTrend(0, 0)).toBe("trend n/a");
  });
});

describe("formatProcessLabel", () => {
  it("shows the script for interpreters instead of the bare path", () => {
    expect(
      formatProcessLabel(
        "/run/current-system/sw/bin/python3 /home/x/anonymize_openmage_dump.py --in a",
      ),
    ).toBe("python3 anonymize_openmage_dump.py");
    expect(formatProcessLabel("/usr/bin/python3 -u -m http.server 8000")).toBe(
      "python3 -m http.server",
    );
    expect(formatProcessLabel("node --import tsx src/main.ts")).toBe("node main.ts");
    expect(formatProcessLabel("python3.12 -c import os")).toBe("python3.12 -c …");
  });

  it("uses the binary basename and appends a systemd unit / container", () => {
    expect(formatProcessLabel("/nix/store/abc-mariadb/bin/mariadbd --datadir=/var/lib/mysql")).toBe(
      "mariadbd",
    );
    expect(formatProcessLabel("mariadbd", "mysql.service")).toBe("mariadbd [mysql.service]");
    expect(formatProcessLabel("redis-server *:6379", "container 0123456789ab")).toBe(
      "redis-server [container 0123456789ab]",
    );
    expect(formatProcessLabel("bash", "session-3.scope")).toBe("bash");
  });

  it("keeps sentry special-cases and truncates long names", () => {
    expect(formatProcessLabel("node /x/@sentry/mcp-server/dist/index.js")).toBe("sentry-mcp");
    const label = formatProcessLabel(`/bin/python3 ${"a".repeat(100)}.py`);
    expect(label.length).toBe(60);
    expect(label.endsWith("…")).toBe(true);
  });
});

describe("formatProcessLabel edge cases", () => {
  it("handles env prefixes, launchers, empty and odd cmdlines", () => {
    expect(formatProcessLabel("/usr/bin/env PYTHONUNBUFFERED=1 python3 -u job.py")).toBe(
      "python3 job.py",
    );
    expect(formatProcessLabel("env -i FOO=1 /usr/bin/mariadbd")).toBe("mariadbd");
    expect(formatProcessLabel("uv run scripts/etl.py")).toBe("uv etl.py");
    expect(formatProcessLabel("pnpm exec vite build")).toBe("pnpm vite");
    expect(formatProcessLabel("node --max-old-space-size 4096 --inspect dist/server.js")).toBe(
      "node server.js",
    );
    expect(formatProcessLabel("node --max-old-space-size=4096 dist/server.js")).toBe(
      "node server.js",
    );
    expect(formatProcessLabel("")).toBe("?");
    expect(formatProcessLabel("   ")).toBe("?");
    expect(formatProcessLabel("python3")).toBe("python3");
    expect(formatProcessLabel("/")).toBe("/");
  });
});

describe("escapeDiscordText", () => {
  it("neutralizes mentions, markdown and newlines from process names", () => {
    const evil = "node `x` **@everyone** <@123> _a_ ~~b~~ ||c||\n> quote";
    const out = escapeDiscordText(evil);
    expect(out).not.toContain("@everyone");
    expect(out).not.toContain("<@123>");
    expect(out).not.toMatch(/(^|[^\\])`/u);
    expect(out).not.toContain("\n");
    expect(out).toContain("\\*\\*");
  });

  it("is applied to labels in alert bodies", () => {
    const content = hostPressureAlertContent({
      key: "host-cpu",
      sample: sample({ cpuPercent: 99 }),
      ageMs: 6 * TICK_MS,
      milestoneMs: 0,
      procSamples: [
        {
          pid: 1,
          rssMb: 10,
          cpuPercent: 99,
          rssTrendMb: 0,
          rssTrendSpanMs: 0,
          label: "python3 @everyone`.py",
        },
      ],
    });
    expect(content).not.toContain("@everyone");
    expect(content).toContain("python3 @\u200beveryone\\`.py");
  });
});

describe("parseProcStat", () => {
  it("parses comm with spaces/parens, cpu seconds and start time", () => {
    const stat =
      "1234 (weird ) name) S 1 1 1 0 -1 4194560 100 0 0 0 250 50 0 0 20 0 1 0 98765 1000 10 18446744073709551615";
    expect(parseProcStat(stat, 100)).toEqual({
      comm: "weird ) name",
      cpuSeconds: 3,
      startTicks: 98765,
    });
    expect(parseProcStat("garbage", 100)).toBeNull();
  });
});

describe("parseMemPsi", () => {
  it("parses some/full avg60", () => {
    expect(
      parseMemPsi(
        "some avg10=1.00 avg60=12.50 avg300=3.00 total=1\nfull avg10=0.00 avg60=2.25 avg300=0.00 total=1\n",
      ),
    ).toEqual({ someAvg60: 12.5, fullAvg60: 2.25 });
    expect(parseMemPsi("")).toBeNull();
  });
});

const sample = (over: Partial<HostPressureSample> = {}): HostPressureSample => ({
  cpuPercent: 20,
  load1: 1,
  nproc: 8,
  memTotalMb: 16_384,
  memAvailableMb: 8_000,
  memPsi: null,
  ...over,
});

describe("trackHostPressure", () => {
  const replay = (samples: ReadonlyArray<HostPressureSample>) => {
    let state: HostPressureState = INITIAL_HOST_PRESSURE_STATE;
    let active: ReturnType<typeof trackHostPressure>["active"] = [];
    samples.forEach((s, i) => {
      const r = trackHostPressure({ prev: state, sample: s, nowMs: i * TICK_MS });
      state = r.next;
      active = r.active;
    });
    return active;
  };

  it("fires host-cpu only after 5 minutes of sustained CPU or load", () => {
    const hot = sample({ cpuPercent: 95 });
    expect(replay(Array.from({ length: 5 }, () => hot))).toEqual([]);
    expect(replay(Array.from({ length: 6 }, () => hot))).toEqual([{ key: "host-cpu", sinceMs: 0 }]);
    const loaded = sample({ load1: 9 });
    expect(replay(Array.from({ length: 6 }, () => loaded)).map((a) => a.key)).toEqual(["host-cpu"]);
  });

  it("keeps the streak through a short dip but resets after the clear grace", () => {
    const hot = sample({ cpuPercent: 95 });
    const cool = sample();
    // One cool tick inside the 3m grace doesn't restart the 5m sustain window.
    expect(replay([hot, hot, hot, cool, hot, hot, hot])).toEqual([{ key: "host-cpu", sinceMs: 0 }]);
    // Three cool ticks (≥ 3m) clear it; the next streak starts fresh.
    expect(replay([hot, hot, hot, cool, cool, cool, cool, hot, hot, hot])).toEqual([]);
  });

  it("hysteresis: an active condition hovering around the threshold does not flap", () => {
    let state: HostPressureState = INITIAL_HOST_PRESSURE_STATE;
    const seen: Array<ReadonlyArray<string>> = [];
    for (let i = 0; i < 30; i++) {
      // 6 hot minutes, then alternate hot/cool every minute.
      const s = i < 6 || i % 2 === 0 ? sample({ cpuPercent: 90 }) : sample({ cpuPercent: 80 });
      const r = trackHostPressure({ prev: state, sample: s, nowMs: i * TICK_MS });
      state = r.next;
      seen.push(r.active.map((a) => a.key));
    }
    expect(seen.slice(5).every((keys) => keys.length === 1 && keys[0] === "host-cpu")).toBe(true);
    expect(state.cpuHotSinceMs).toBe(0);
    // A not-yet-active streak cooling inside the grace is not reported as active.
    const r = trackHostPressure({
      prev: INITIAL_HOST_PRESSURE_STATE,
      sample: sample({ cpuPercent: 95 }),
      nowMs: 0,
    });
    expect(
      trackHostPressure({ prev: r.next, sample: sample(), nowMs: 10 * TICK_MS }).active,
    ).toEqual([]);
  });

  it("resets streaks across a sample gap (suspend / clock jump)", () => {
    const hot = sample({ cpuPercent: 95, memAvailableMb: 100 });
    const a = trackHostPressure({ prev: INITIAL_HOST_PRESSURE_STATE, sample: hot, nowMs: 0 });
    // 1h later (VM suspended): must not instantly count as a 1h-old streak.
    const b = trackHostPressure({ prev: a.next, sample: hot, nowMs: 60 * TICK_MS });
    expect(b.active).toEqual([]);
    expect(b.next.cpuHotSinceMs).toBe(60 * TICK_MS);
    // Clock moved backwards: also reset.
    const c = trackHostPressure({ prev: b.next, sample: hot, nowMs: 30 * TICK_MS });
    expect(c.next.memHotSinceMs).toBe(30 * TICK_MS);
  });

  it("ignores NaN / zero readings instead of paging", () => {
    const weird = sample({ cpuPercent: null, load1: Number.NaN, memTotalMb: 0, memAvailableMb: 0 });
    expect(replay(Array.from({ length: 10 }, () => weird))).toEqual([]);
  });

  it("fires host-mem on low available memory or PSI after 2 minutes", () => {
    const low = sample({ memAvailableMb: 900 });
    expect(replay([low, low, low]).map((a) => a.key)).toEqual(["host-mem"]);
    // 10% of 16 GiB floor = 1638 MiB
    const lowPct = sample({ memAvailableMb: 1_500 });
    expect(replay([lowPct, lowPct, lowPct]).map((a) => a.key)).toEqual(["host-mem"]);
    const psi = sample({ memPsi: { someAvg60: 25, fullAvg60: 0 } });
    expect(replay([psi, psi, psi]).map((a) => a.key)).toEqual(["host-mem"]);
  });
});

describe("advanceConditionLadder", () => {
  const MIN = 60_000;
  const step = (
    prev: ReadonlyMap<string, ConditionLadderEntry>,
    activeSince: number | null,
    nowMs: number,
  ) =>
    advanceConditionLadder({
      prev,
      active:
        activeSince === null
          ? []
          : [{ key: "host-cpu", sinceMs: activeSince, title: "Host CPU pressure" }],
      nowMs,
    });

  it("pages immediately, then on the 15m × 2ⁿ ladder, then reports recovery", () => {
    let state: ReadonlyMap<string, ConditionLadderEntry> = new Map();
    const pagedAt: number[] = [];
    for (let minute = 5; minute <= 130; minute++) {
      const r = step(state, 0, minute * MIN);
      state = r.next;
      if (r.pages.length > 0) pagedAt.push(minute);
      expect(r.recovered).toEqual([]);
    }
    expect(pagedAt).toEqual([5, 15, 30, 60, 120]);
    const r = step(state, null, 131 * MIN);
    expect(r.pages).toEqual([]);
    expect(r.recovered).toEqual([
      { key: "host-cpu", title: "Host CPU pressure", durationMs: 131 * MIN },
    ]);
    expect(r.next.size).toBe(0);
    expect(recoveredAlertContent("Host CPU pressure", 131 * MIN)).toBe(
      "✅ **Recovered:** Host CPU pressure (lasted ~2h 11m)",
    );
  });

  it("does not double-page when the initial page lands past a rung (30m runaway)", () => {
    const since = 0;
    const r1 = advanceConditionLadder({
      prev: new Map(),
      active: [{ key: "proc:1:runaway-cpu", sinceMs: since, title: "x" }],
      nowMs: 30 * MIN,
    });
    expect(r1.pages).toHaveLength(1);
    const pagedAt: number[] = [];
    let state = r1.next;
    for (let minute = 31; minute <= 130; minute++) {
      const r = advanceConditionLadder({
        prev: state,
        active: [{ key: "proc:1:runaway-cpu", sinceMs: since, title: "x" }],
        nowMs: minute * MIN,
      });
      state = r.next;
      if (r.pages.length > 0) pagedAt.push(minute);
    }
    expect(pagedAt).toEqual([60, 120]);
  });

  it("treats a new streak start as recovery plus a fresh page", () => {
    const first = step(new Map(), 0, 5 * MIN);
    const r = step(first.next, 10 * MIN, 15 * MIN);
    expect(r.recovered.map((x) => x.key)).toEqual(["host-cpu"]);
    expect(r.pages).toEqual([{ key: "host-cpu", milestoneMs: 0, ageMs: 5 * MIN }]);
  });
});

describe("hostPressureAlertContent", () => {
  it("lists top processes by CPU and RSS with trend", () => {
    const procSamples = [
      {
        pid: 1,
        rssMb: 1630,
        cpuPercent: 10,
        rssTrendMb: 2,
        rssTrendSpanMs: 14 * TICK_MS,
        label: "python3 dump.py",
      },
      {
        pid: 2,
        rssMb: 849,
        cpuPercent: 3,
        rssTrendMb: 0,
        rssTrendSpanMs: 14 * TICK_MS,
        label: "mariadbd",
      },
      {
        pid: 3,
        rssMb: 300,
        cpuPercent: 380,
        rssTrendMb: 250,
        rssTrendSpanMs: 14 * TICK_MS,
        label: "node build.js",
      },
    ];
    expect(topProcesses(procSamples).byCpu.map((p) => p.pid)).toEqual([3, 1, 2]);
    const content = hostPressureAlertContent({
      key: "host-cpu",
      sample: sample({ cpuPercent: 92, load1: 7.5 }),
      ageMs: 6 * TICK_MS,
      milestoneMs: 0,
      procSamples,
    });
    expect(content).toContain("**Host CPU pressure** for 6m");
    expect(content).toContain(
      "Top CPU:\n• node build.js (pid 3) cpu≈380% rss=300MiB (+250 MiB over 14m)",
    );
    expect(content).toContain("• python3 dump.py (pid 1) cpu≈10% rss=1630MiB (flat over 14m)");
    expect(content).toContain("Top RSS:");
    expect(content.length).toBeLessThan(1900);
  });
});
