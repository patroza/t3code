import * as Cause from "effect/Cause";
import { describe, expect, it } from "vite-plus/test";

import {
  classifySessionLastError,
  formatAlertCause,
  isExpectedSessionLastError,
  memoryPolicyForProcess,
  parseProcMemoryStatus,
  selectSessionErrorsForAlert,
  sessionErrorAlertKey,
  trackSustainedHotProcesses,
  type ProcInfo,
  type ProcSustainState,
} from "./Alerts.ts";

const TICK_MS = 60_000;
const CPU_THRESHOLD = 50;
const RSS_THRESHOLD = 768;
const SUSTAINED_TICKS = 5;

const proc = (over: Partial<ProcInfo> & { pid: number }): ProcInfo => ({
  pid: over.pid,
  rssMb: over.rssMb ?? 100,
  rssAnonMb: over.rssAnonMb ?? 50,
  rssFileMb: over.rssFileMb ?? 50,
  cpuSeconds: over.cpuSeconds ?? 0,
  cmd: over.cmd ?? `/bin/proc-${over.pid}`,
  label: over.label ?? `proc-${over.pid}`,
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
      cpuPercentThreshold: CPU_THRESHOLD,
      rssMbThreshold: RSS_THRESHOLD,
      memoryPolicyFor: (process) => memoryPolicyForProcess(process, RSS_THRESHOLD),
      sustainedTicks: SUSTAINED_TICKS,
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
    expect(selected.fatals).toHaveLength(1);
    expect(selected.fatals[0]?.threadId).toBe("t3");
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

describe("trackSustainedHotProcesses", () => {
  it("parses total, anonymous, and file-backed RSS from proc status", () => {
    expect(
      parseProcMemoryStatus(`
VmRSS:       1638400 kB
RssAnon:      921600 kB
RssFile:      716800 kB
`),
    ).toEqual({
      rssMb: 1_600,
      rssAnonMb: 900,
      rssFileMb: 700,
    });
  });

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
    const ticks = Array.from({ length: SUSTAINED_TICKS + 1 }, (_unused, i) => [
      proc({ pid: 900, rssMb: 200, cpuSeconds: i * 60 }),
    ]);
    const hot = run(ticks).hot;
    expect(hot).toHaveLength(1);
    expect(hot[0]!.pid).toBe(900);
    expect(hot[0]!.cpuPercent).toBeGreaterThanOrEqual(CPU_THRESHOLD);
    // SUSTAINED_TICKS consecutive hot samples span SUSTAINED_TICKS-1 intervals of
    // wall time (the first tick only primes the rate baseline).
    expect(Math.round(hot[0]!.sustainedMs / TICK_MS)).toBe(SUSTAINED_TICKS - 1);
  });

  it("does not alert before the sustained window elapses", () => {
    const ticks = Array.from({ length: SUSTAINED_TICKS }, (_unused, i) => [
      proc({ pid: 900, cpuSeconds: i * 60 }),
    ]);
    // Only SUSTAINED_TICKS-1 measurable hot ticks so far (first tick has no rate).
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
    const ticks = Array.from({ length: SUSTAINED_TICKS + 1 }, () => [
      proc({ pid: 950, rssMb: 900, cpuSeconds: 5 }),
    ]);
    const hot = run(ticks).hot;
    expect(hot).toHaveLength(1);
    expect(hot[0]!.rssMb).toBe(900);
    expect(hot[0]!.memoryKind).toBe("rss");
    expect(hot[0]!.cpuPercent).toBe(0);
  });

  it("ignores Jaeger file cache below the anonymous-memory threshold", () => {
    const ticks = Array.from({ length: SUSTAINED_TICKS + 1 }, () => [
      proc({
        pid: 950,
        rssMb: 3_000,
        rssAnonMb: 900,
        rssFileMb: 2_100,
        cmd: "/cmd/jaeger/jaeger-linux --config=/etc/jaeger/config.yaml",
      }),
    ]);

    expect(run(ticks).hot).toEqual([]);
  });

  it("alerts once Jaeger sustains 2 GiB of anonymous memory", () => {
    const ticks = Array.from({ length: SUSTAINED_TICKS + 1 }, () => [
      proc({
        pid: 950,
        rssMb: 3_000,
        rssAnonMb: 2 * 1024,
        rssFileMb: 952,
        cmd: "/cmd/jaeger/jaeger-linux --config=/etc/jaeger/config.yaml",
      }),
    ]);

    expect(run(ticks).hot).toEqual([
      expect.objectContaining({
        pid: 950,
        memoryKind: "anonymous",
        memoryValueMb: 2 * 1024,
        memoryThresholdMb: 2 * 1024,
      }),
    ]);
  });

  it("falls back to total RSS when the kernel omits the Jaeger RSS breakdown", () => {
    expect(
      memoryPolicyForProcess(
        proc({
          pid: 950,
          rssMb: 2 * 1024,
          rssAnonMb: 0,
          rssFileMb: 0,
          cmd: "/cmd/jaeger/jaeger-linux",
        }),
      ),
    ).toEqual({
      valueMb: 2 * 1024,
      thresholdMb: 2 * 1024,
      kind: "rss",
    });
  });

  it("treats a reused pid as a new process and resets its streak", () => {
    const busy = Array.from({ length: 4 }, (_unused, i) => [
      proc({ pid: 900, cpuSeconds: i * 60 }),
    ]);
    // pid 900 reappears with a lower cumulative counter → different process.
    const reused = [proc({ pid: 900, cpuSeconds: 1 })];
    expect(run([...busy, reused]).hot).toEqual([]);
  });

  it("prunes state for processes that have exited", () => {
    const { state } = run([[proc({ pid: 900 })], [proc({ pid: 901 })]]);
    expect(state.has(900)).toBe(false);
    expect(state.has(901)).toBe(true);
  });
});
