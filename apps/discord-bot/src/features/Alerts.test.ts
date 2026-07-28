import * as Cause from "effect/Cause";
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
  isExpectedSessionLastError,
  selectSessionErrorsForAlert,
  sessionErrorAlertDelivery,
  sessionErrorAlertKey,
  trackSustainedHotProcesses,
  type ProcInfo,
  type ProcSustainState,
} from "./Alerts.ts";

const TICK_MS = 60_000;
const CPU_THRESHOLD = 50;
const RSS_THRESHOLD = 768;
const SUSTAINED_FOR_MS = 4 * TICK_MS;

const proc = (over: Partial<ProcInfo> & { pid: number }): ProcInfo => ({
  pid: over.pid,
  rssMb: over.rssMb ?? 100,
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

  it("prunes state for processes that have exited", () => {
    const { state } = run([[proc({ pid: 900 })], [proc({ pid: 901 })]]);
    expect(state.has(900)).toBe(false);
    expect(state.has(901)).toBe(true);
  });
});
