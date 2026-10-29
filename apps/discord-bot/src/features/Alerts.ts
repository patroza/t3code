// @effect-diagnostics nodeBuiltinImport:off missingEffectContext:off anyUnknownInErrorContext:off
/**
 * Guest ops alerts: sustained host CPU/memory pressure (with top processes as context), clear runaway
 * processes, long turns, session errors, fatal/bridge failures. Persistent conditions re-page on the
 * 15m × 2ⁿ ladder and post a recovery when they clear; recovery text is not a session error.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import { DiscordConfig, DiscordREST } from "dfx";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";

import { loadAlertProcessRulesFromFileSync, type AlertProcessRule } from "../alertProcessRules.ts";
import type { DiscordBotConfig } from "../config.ts";
import {
  createMessageWithAttachments,
  DiscordUploadError,
  textFile,
  type DiscordUploadFile,
} from "../presentation/discordFiles.ts";

const POLL = "60 seconds";
const COOLDOWN_MS = 10 * 60 * 1000;
/** Fatal errors use a shorter cooldown so distinct keys still surface quickly. */
const FATAL_COOLDOWN_MS = 2 * 60 * 1000;
/**
 * Session last_error fatals used to re-post every 2m per thread after restarts.
 * Sticky projection rows never clear, so cooldown alone re-pages the same failure
 * forever (e.g. a week-old "Invalid params" every 30m). Age-gate + matching
 * cooldown: page once while the row is still fresh, then drop it.
 */
export const SESSION_ERROR_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const SESSION_ERROR_FATAL_COOLDOWN_MS = SESSION_ERROR_MAX_AGE_MS;
/** Cap distinct session-error posts per watchdog tick. */
const SESSION_ERROR_ALERT_MAX = 5;
/** Leave headroom below Discord's 2,000-character message-content limit. */
const DISCORD_ALERT_MESSAGE_LIMIT = 1900;

/** Host CPU pressure: cpu% ≥ this, or load1 ≥ nproc × HOST_LOAD_RATIO (and ≥ 2). */
export const HOST_CPU_PERCENT_ALERT = 85;
export const HOST_LOAD_RATIO = 1.0;
/** Host CPU pressure must hold this long (consecutive polls) before paging. */
export const HOST_CPU_SUSTAINED_FOR_MS = 5 * 60 * 1000;
/** Memory pressure: MemAvailable below max(this, HOST_MEM_AVAILABLE_MIN_PERCENT of total)… */
export const HOST_MEM_AVAILABLE_MIN_MB = 1024;
export const HOST_MEM_AVAILABLE_MIN_PERCENT = 10;
/** …or PSI memory (when /proc/pressure/memory exists): some avg60 ≥ X or full avg60 ≥ Y. */
export const HOST_MEM_PSI_SOME_AVG60 = 20;
export const HOST_MEM_PSI_FULL_AVG60 = 5;
/** Memory pressure is more urgent than CPU; shorter sustain window. */
export const HOST_MEM_SUSTAINED_FOR_MS = 2 * 60 * 1000;
/** How many processes to list per ranking (CPU / RSS) as context in host alerts. */
const HOST_ALERT_TOP_N = 5;
const DISK_FREE_MIN_PERCENT = 10;
const DISK_FREE_MIN_GB = 2;
/** Alert when a legacy stdio Sentry MCP process exceeds this RSS. */
const SENTRY_RSS_ALERT_MB = 512;
const SENTRY_COUNT_ALERT = 2;
/**
 * Default per-process alerts are runaways only (CPU rate between ticks, not cumulative):
 * ≥ 90% of a core for ≥ 30 min, or RSS ≥ 50% of total RAM for ≥ 5 min.
 * Modest usage is covered by host pressure; tighter ceilings are opt-in via the rules file.
 */
export const DEFAULT_PROCESS_CPU_PERCENT = 90; // percent of a single core, averaged over the tick gap
export const DEFAULT_PROCESS_CPU_SUSTAINED_FOR_MS = 30 * 60 * 1000;
export const DEFAULT_PROCESS_RSS_FRACTION_OF_TOTAL = 0.5;
export const DEFAULT_PROCESS_RSS_SUSTAINED_FOR_MS = 5 * 60 * 1000;
/** RSS samples kept per process for trend reporting (one per poll ⇒ ~15 min). */
const RSS_HISTORY_SAMPLES = 15;
/**
 * First long-turn page threshold and base of the doubling milestone ladder.
 * Pages at 0.25h, 0.5h, 1h, 2h, 4h, … (15m × 2ⁿ) while the turn stays `running`,
 * instead of re-paging every fixed cooldown (was 10m — spammy for multi-hour turns).
 */
export const TURN_RUNNING_MIN_MS = 15 * 60 * 1000;

/** Paths to check for free space (guest rootfs is tiny; data volume is the real store). */
const DISK_PATHS = ["/", "/var/lib/t3"] as const;

/**
 * Processes we watch as "runaways" (alert only — never auto-kill).
 * Targets legacy local `@sentry/mcp-server` stdio children. Excludes the shared
 * `shared-sentry-mcp-proxy` HTTP proxy (contains "sentry-mcp" in the path).
 */
const RUNAWAY_PATTERNS: ReadonlyArray<{
  readonly id: string;
  readonly match: (cmd: string) => boolean;
}> = [
  {
    id: "sentry-mcp",
    match: (cmd) => {
      if (cmd.includes("shared-sentry-mcp-proxy") || cmd.includes("t3-watchdog")) return false;
      return cmd.includes("@sentry/mcp-server") || /\bsentry-mcp\b/.test(cmd);
    },
  },
];

export interface ProcInfo {
  readonly pid: number;
  readonly rssMb: number;
  readonly cpuSeconds: number;
  readonly cmd: string;
  readonly label: string;
}

/** Per-process tracker state carried between ticks to derive a CPU rate. */
export interface ProcSustainState {
  readonly cpuSeconds: number;
  readonly sampledAtMs: number;
  readonly wasHot: boolean;
  /** When the current hot streak began, for reporting how long it has lasted. */
  readonly hotSinceMs: number;
  /** Recent RSS samples (oldest first, capped) for trend reporting. */
  readonly rssHistory?: ReadonlyArray<{ readonly atMs: number; readonly rssMb: number }>;
  /** Start of the current hot streak per rule id (only rules currently hot). */
  readonly hotSinceByRule?: Readonly<Record<string, number>>;
}

/** Per-tick per-process sample with derived CPU rate and RSS trend (for host-alert context). */
export interface ProcSample {
  readonly pid: number;
  readonly rssMb: number;
  /** Average CPU over the last tick gap (percent of one core), or null on first sight. */
  readonly cpuPercent: number | null;
  /** RSS change across the retained history window. */
  readonly rssTrendMb: number;
  readonly rssTrendSpanMs: number;
  readonly label: string;
}

/** A process that has been hot (high CPU rate or RSS) for long enough to alert. */
export interface SustainedHotProcess {
  readonly pid: number;
  readonly rssMb: number;
  /** Average CPU over the last tick gap, as percent of a single core. */
  readonly cpuPercent: number;
  readonly ruleId: string;
  readonly rssMbThreshold: number | null;
  readonly cpuPercentThreshold: number | null;
  readonly sustainedForMs: number;
  /** How long it has been continuously hot. */
  readonly sustainedMs: number;
  /** RSS change across the retained history window. */
  readonly rssTrendMb: number;
  readonly rssTrendSpanMs: number;
  readonly label: string;
}

export interface ResolvedProcessAlertRule {
  readonly id: string;
  readonly rssMbThreshold: number | null;
  readonly cpuPercentThreshold: number | null;
  readonly sustainedForMs: number;
}

/**
 * Default runaway rules (CPU and RSS are separate rules so each has its own sustain window).
 * `memTotalMb` ≤ 0 (unknown) disables the RSS runaway rule.
 */
export function defaultRunawayProcessRules(
  memTotalMb: number,
): ReadonlyArray<ResolvedProcessAlertRule> {
  const rules: ResolvedProcessAlertRule[] = [
    {
      id: "runaway-cpu",
      rssMbThreshold: null,
      cpuPercentThreshold: DEFAULT_PROCESS_CPU_PERCENT,
      sustainedForMs: DEFAULT_PROCESS_CPU_SUSTAINED_FOR_MS,
    },
  ];
  if (memTotalMb > 0) {
    rules.push({
      id: "runaway-rss",
      rssMbThreshold: memTotalMb * DEFAULT_PROCESS_RSS_FRACTION_OF_TOTAL,
      cpuPercentThreshold: null,
      sustainedForMs: DEFAULT_PROCESS_RSS_SUSTAINED_FOR_MS,
    });
  }
  return rules;
}

/**
 * Advance the per-process hotness tracker by one tick (pure). Exited pids are pruned; a pid whose
 * CPU counter went backwards is treated as reused. Each rule keeps its own streak
 * (`hotSinceByRule`); a process is reported once, for the first rule hot long enough.
 */
export function trackSustainedHotProcesses(input: {
  readonly prev: ReadonlyMap<number, ProcSustainState>;
  readonly procs: ReadonlyArray<ProcInfo>;
  readonly nowMs: number;
  readonly resolveRule?: (proc: ProcInfo) => ResolvedProcessAlertRule;
  readonly resolveRules?: (proc: ProcInfo) => ReadonlyArray<ResolvedProcessAlertRule>;
}): {
  readonly next: Map<number, ProcSustainState>;
  readonly hot: ReadonlyArray<SustainedHotProcess>;
  readonly samples: ReadonlyArray<ProcSample>;
} {
  const next = new Map<number, ProcSustainState>();
  const hot: SustainedHotProcess[] = [];
  const samples: ProcSample[] = [];
  const rulesFor = (proc: ProcInfo): ReadonlyArray<ResolvedProcessAlertRule> =>
    input.resolveRules?.(proc) ?? (input.resolveRule ? [input.resolveRule(proc)] : []);

  for (const proc of input.procs) {
    const rules = rulesFor(proc);
    const prior = input.prev.get(proc.pid);
    // A counter that went backwards means the pid was reused; ignore the prior.
    const reused = prior !== undefined && proc.cpuSeconds < prior.cpuSeconds;
    const previous = reused ? undefined : prior;

    const elapsedMs = previous ? input.nowMs - previous.sampledAtMs : 0;
    const cpuPercent =
      previous && elapsedMs > 0
        ? (Math.max(0, proc.cpuSeconds - previous.cpuSeconds) / (elapsedMs / 1_000)) * 100
        : null;

    const rssHistory = [
      ...(previous?.rssHistory ?? []),
      { atMs: input.nowMs, rssMb: proc.rssMb },
    ].slice(-RSS_HISTORY_SAMPLES);
    const oldest = rssHistory[0]!;
    const rssTrendMb = proc.rssMb - oldest.rssMb;
    const rssTrendSpanMs = input.nowMs - oldest.atMs;

    const hotSinceByRule: Record<string, number> = {};
    let reported: SustainedHotProcess | null = null;
    for (const rule of rules) {
      const isHot =
        (rule.cpuPercentThreshold !== null &&
          cpuPercent !== null &&
          cpuPercent >= rule.cpuPercentThreshold) ||
        (rule.rssMbThreshold !== null && proc.rssMb >= rule.rssMbThreshold);
      if (!isHot) continue;
      const since =
        previous?.hotSinceByRule?.[rule.id] ??
        (previous?.wasHot && rules.length === 1 ? previous.hotSinceMs : input.nowMs);
      hotSinceByRule[rule.id] = since;
      if (reported === null && input.nowMs - since >= rule.sustainedForMs) {
        reported = {
          pid: proc.pid,
          rssMb: proc.rssMb,
          cpuPercent: cpuPercent ?? 0,
          ruleId: rule.id,
          rssMbThreshold: rule.rssMbThreshold,
          cpuPercentThreshold: rule.cpuPercentThreshold,
          sustainedForMs: rule.sustainedForMs,
          sustainedMs: input.nowMs - since,
          rssTrendMb,
          rssTrendSpanMs,
          label: proc.label,
        };
      }
    }
    const sinceValues = Object.values(hotSinceByRule);
    const isHot = sinceValues.length > 0;

    next.set(proc.pid, {
      cpuSeconds: proc.cpuSeconds,
      sampledAtMs: input.nowMs,
      wasHot: isHot,
      hotSinceMs: isHot ? Math.min(...sinceValues) : input.nowMs,
      rssHistory,
      hotSinceByRule,
    });

    if (reported !== null) hot.push(reported);
    samples.push({
      pid: proc.pid,
      rssMb: proc.rssMb,
      cpuPercent,
      rssTrendMb,
      rssTrendSpanMs,
      label: proc.label,
    });
  }

  hot.sort((a, b) => b.cpuPercent - a.cpuPercent || b.rssMb - a.rssMb);
  return { next, hot: hot.slice(0, 8), samples };
}

/** Top-N processes by CPU rate and by RSS, for host-alert context. */
export function topProcesses(
  samples: ReadonlyArray<ProcSample>,
  n: number = HOST_ALERT_TOP_N,
): { readonly byCpu: ReadonlyArray<ProcSample>; readonly byRss: ReadonlyArray<ProcSample> } {
  const byCpu = samples
    .filter((p) => p.cpuPercent !== null && p.cpuPercent >= 1)
    .toSorted((a, b) => (b.cpuPercent ?? 0) - (a.cpuPercent ?? 0))
    .slice(0, n);
  const byRss = samples.toSorted((a, b) => b.rssMb - a.rssMb).slice(0, n);
  return { byCpu, byRss };
}

/** `flat over 14m`, `+212 MiB over 14m`, `-80 MiB over 14m`; `new` with no history. */
export function formatRssTrend(deltaMb: number, spanMs: number): string {
  if (spanMs < 60_000) return "trend n/a";
  const minutes = Math.round(spanMs / 60_000);
  if (Math.abs(deltaMb) < 16) return `flat over ${minutes}m`;
  const sign = deltaMb > 0 ? "+" : "-";
  return `${sign}${Math.abs(deltaMb).toFixed(0)} MiB over ${minutes}m`;
}

export function formatProcSampleLine(p: ProcSample): string {
  const cpu = p.cpuPercent === null ? "?" : p.cpuPercent.toFixed(0);
  return (
    `• ${p.label} (pid ${p.pid}) cpu≈${cpu}% rss=${p.rssMb.toFixed(0)}MiB ` +
    `(${formatRssTrend(p.rssTrendMb, p.rssTrendSpanMs)})`
  );
}

const INTERPRETERS = new Set([
  "python",
  "python2",
  "python3",
  "node",
  "bun",
  "deno",
  "ruby",
  "perl",
  "php",
  "bash",
  "sh",
  "zsh",
  "java",
  "tsx",
  "uv",
  "uvx",
  "npx",
  "pnpm",
]);
/** Interpreter flags that consume the following token. */
const FLAGS_WITH_VALUE = new Set([
  "--import",
  "--require",
  "-r",
  "--loader",
  "--experimental-loader",
  "-X",
  "-W",
  "-cp",
  "-classpath",
  "--max-old-space-size",
]);
const MAX_LABEL_LENGTH = 60;

function basename(token: string): string {
  const parts = token.split("/");
  return parts[parts.length - 1] || token;
}

function truncateLabel(label: string): string {
  return label.length > MAX_LABEL_LENGTH ? `${label.slice(0, MAX_LABEL_LENGTH - 1)}…` : label;
}

/**
 * Human-readable process name from a /proc cmdline (+ optional systemd unit).
 * - Interpreters show the script / module: `python3 anonymize_openmage_dump.py`, `python3 -m http.server`.
 * - Other binaries show their basename: `mariadbd`.
 * - A non-generic systemd unit is appended: `mariadbd [mysql.service]`.
 */
export function formatProcessLabel(cmd: string, unit?: string | null): string {
  if (cmd.includes("shared-sentry-mcp-proxy")) return "shared-sentry-mcp-proxy";
  if (cmd.includes("@sentry/mcp-server") || /\bsentry-mcp\b/.test(cmd)) return "sentry-mcp";
  const tokens = cmd.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return "?";
  const exe = basename(tokens[0]!);
  const interpreter = exe.replace(/[\d.]+$/u, "");
  let label = exe;
  if (INTERPRETERS.has(exe) || INTERPRETERS.has(interpreter)) {
    for (let i = 1; i < tokens.length; i++) {
      const token = tokens[i]!;
      if (token === "-m" && tokens[i + 1] !== undefined) {
        label = `${exe} -m ${tokens[i + 1]}`;
        break;
      }
      if (token === "-c" || token === "-e") {
        label = `${exe} ${token} …`;
        break;
      }
      if (token.startsWith("-")) {
        if (FLAGS_WITH_VALUE.has(token)) i++;
        continue;
      }
      label = `${exe} ${basename(token)}`;
      break;
    }
  }
  const unitName = unit?.trim();
  if (
    unitName &&
    !unitName.startsWith("session-") &&
    !unitName.startsWith("user@") &&
    unitName !== "init.scope"
  ) {
    label = `${label} [${unitName}]`;
  }
  return truncateLabel(label);
}

export interface HostPressureSample {
  readonly cpuPercent: number | null;
  readonly load1: number;
  readonly nproc: number;
  readonly memTotalMb: number;
  readonly memAvailableMb: number;
  readonly memPsi: { readonly someAvg60: number; readonly fullAvg60: number } | null;
}

export interface HostPressureState {
  readonly cpuHotSinceMs: number | null;
  readonly memHotSinceMs: number | null;
}

export const INITIAL_HOST_PRESSURE_STATE: HostPressureState = {
  cpuHotSinceMs: null,
  memHotSinceMs: null,
};

export type HostPressureCondition = "host-cpu" | "host-mem";

/** Memory available floor in MiB for a given total: max(1 GiB, 10% of total). */
export function hostMemAvailableFloorMb(memTotalMb: number): number {
  return Math.max(HOST_MEM_AVAILABLE_MIN_MB, (memTotalMb * HOST_MEM_AVAILABLE_MIN_PERCENT) / 100);
}

export function isHostCpuPressure(sample: HostPressureSample): boolean {
  const cpuHot = sample.cpuPercent !== null && sample.cpuPercent >= HOST_CPU_PERCENT_ALERT;
  const loadHot = sample.load1 >= 2 && sample.load1 >= sample.nproc * HOST_LOAD_RATIO;
  return cpuHot || loadHot;
}

export function isHostMemPressure(sample: HostPressureSample): boolean {
  const lowAvailable =
    sample.memTotalMb > 0 &&
    sample.memAvailableMb > 0 &&
    sample.memAvailableMb < hostMemAvailableFloorMb(sample.memTotalMb);
  const psi =
    sample.memPsi !== null &&
    (sample.memPsi.someAvg60 >= HOST_MEM_PSI_SOME_AVG60 ||
      sample.memPsi.fullAvg60 >= HOST_MEM_PSI_FULL_AVG60);
  return lowAvailable || psi;
}

/**
 * Advance host-pressure streaks by one sample. Returns conditions that have held for their
 * sustain window, with the time each streak began (for ladder / recovery bookkeeping).
 */
export function trackHostPressure(input: {
  readonly prev: HostPressureState;
  readonly sample: HostPressureSample;
  readonly nowMs: number;
}): {
  readonly next: HostPressureState;
  readonly active: ReadonlyArray<{ readonly key: HostPressureCondition; readonly sinceMs: number }>;
} {
  const cpuHotSinceMs = isHostCpuPressure(input.sample)
    ? (input.prev.cpuHotSinceMs ?? input.nowMs)
    : null;
  const memHotSinceMs = isHostMemPressure(input.sample)
    ? (input.prev.memHotSinceMs ?? input.nowMs)
    : null;
  const active: Array<{ key: HostPressureCondition; sinceMs: number }> = [];
  if (cpuHotSinceMs !== null && input.nowMs - cpuHotSinceMs >= HOST_CPU_SUSTAINED_FOR_MS) {
    active.push({ key: "host-cpu", sinceMs: cpuHotSinceMs });
  }
  if (memHotSinceMs !== null && input.nowMs - memHotSinceMs >= HOST_MEM_SUSTAINED_FOR_MS) {
    active.push({ key: "host-mem", sinceMs: memHotSinceMs });
  }
  return { next: { cpuHotSinceMs, memHotSinceMs }, active };
}

/** Ladder bookkeeping for a persistent, previously paged condition. */
export interface ConditionLadderEntry {
  readonly sinceMs: number;
  /** 0 = initial page; afterwards the 15m × 2ⁿ milestone (by condition age) last paged. */
  readonly lastMilestoneMs: number;
  /** Extra context remembered for the recovery message. */
  readonly title: string;
}

/**
 * Pages/recoveries for persistent conditions: a new condition pages at once (milestone 0), then
 * only when its age crosses the next 15m × 2ⁿ milestone (same ladder as long turns). A paged
 * condition that is no longer active (or restarted its streak) is reported as recovered.
 */
export function advanceConditionLadder(input: {
  readonly prev: ReadonlyMap<string, ConditionLadderEntry>;
  readonly active: ReadonlyArray<{
    readonly key: string;
    readonly sinceMs: number;
    readonly title: string;
  }>;
  readonly nowMs: number;
  readonly baseMs?: number;
}): {
  readonly next: Map<string, ConditionLadderEntry>;
  readonly pages: ReadonlyArray<{
    readonly key: string;
    readonly milestoneMs: number;
    readonly ageMs: number;
  }>;
  readonly recovered: ReadonlyArray<{
    readonly key: string;
    readonly title: string;
    readonly durationMs: number;
  }>;
} {
  const baseMs = input.baseMs ?? TURN_RUNNING_MIN_MS;
  const next = new Map<string, ConditionLadderEntry>();
  const pages: Array<{ key: string; milestoneMs: number; ageMs: number }> = [];
  for (const condition of input.active) {
    const prior = input.prev.get(condition.key);
    // A different streak start means the condition cleared and came back between ticks.
    const previous = prior !== undefined && prior.sinceMs === condition.sinceMs ? prior : undefined;
    const ageMs = Math.max(0, input.nowMs - condition.sinceMs);
    if (previous === undefined) {
      pages.push({ key: condition.key, milestoneMs: 0, ageMs });
      next.set(condition.key, {
        sinceMs: condition.sinceMs,
        lastMilestoneMs: 0,
        title: condition.title,
      });
      continue;
    }
    const decision = shouldAlertLongRunningTurn(
      ageMs,
      previous.lastMilestoneMs > 0 ? previous.lastMilestoneMs : undefined,
      baseMs,
    );
    if (decision.alert) {
      pages.push({ key: condition.key, milestoneMs: decision.milestoneMs, ageMs });
      next.set(condition.key, {
        ...previous,
        lastMilestoneMs: decision.milestoneMs,
        title: condition.title,
      });
    } else {
      next.set(condition.key, { ...previous, title: condition.title });
    }
  }
  const recovered: Array<{ key: string; title: string; durationMs: number }> = [];
  for (const [key, entry] of input.prev) {
    const current = next.get(key);
    if (current === undefined || current.sinceMs !== entry.sinceMs) {
      recovered.push({
        key,
        title: entry.title,
        durationMs: Math.max(0, input.nowMs - entry.sinceMs),
      });
    }
  }
  return { next, pages, recovered };
}

/** `5m`, `2h 10m` */
export function formatDurationShort(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

export function recoveredAlertContent(title: string, durationMs: number): string {
  return `✅ **Recovered:** ${title} (lasted ~${formatDurationShort(durationMs)})`;
}

/** Ladder suffix for a page: initial vs milestone re-page. */
function ladderNote(milestoneMs: number): string {
  if (milestoneMs === 0) {
    return `_Re-pages at 15m, 30m, 1h, 2h… while it persists; posts recovery when it clears._`;
  }
  return `_Still ongoing · milestone ${formatLongRunningTurnMilestone(milestoneMs)} (next ~${formatLongRunningTurnMilestone(nextLongRunningTurnMilestoneMs(milestoneMs))})._`;
}

export function hostPressureAlertContent(input: {
  readonly key: HostPressureCondition;
  readonly sample: HostPressureSample;
  readonly ageMs: number;
  readonly milestoneMs: number;
  readonly procSamples: ReadonlyArray<ProcSample>;
}): string {
  const s = input.sample;
  const top = topProcesses(input.procSamples);
  const memLine =
    `mem avail=${s.memAvailableMb.toFixed(0)}/${s.memTotalMb.toFixed(0)} MiB` +
    (s.memTotalMb > 0 ? ` (${((s.memAvailableMb / s.memTotalMb) * 100).toFixed(0)}% free)` : "") +
    (s.memPsi !== null
      ? ` · psi some60=${s.memPsi.someAvg60.toFixed(1)} full60=${s.memPsi.fullAvg60.toFixed(1)}`
      : "");
  const cpuLine = `cpu≈${s.cpuPercent?.toFixed(0) ?? "?"}% · load1=${s.load1.toFixed(2)} on ${s.nproc} CPUs`;
  const lines =
    input.key === "host-cpu"
      ? [
          `**Host CPU pressure** for ${formatDurationShort(input.ageMs)}`,
          cpuLine,
          `_alert: cpu ≥${HOST_CPU_PERCENT_ALERT}% or load1 ≥ ${HOST_LOAD_RATIO}×nproc, sustained ≥${formatDurationShort(HOST_CPU_SUSTAINED_FOR_MS)}_`,
          memLine,
        ]
      : [
          `**Host memory pressure** for ${formatDurationShort(input.ageMs)}`,
          memLine,
          `_alert: avail < ${hostMemAvailableFloorMb(s.memTotalMb).toFixed(0)} MiB or PSI some60 ≥${HOST_MEM_PSI_SOME_AVG60} / full60 ≥${HOST_MEM_PSI_FULL_AVG60}, sustained ≥${formatDurationShort(HOST_MEM_SUSTAINED_FOR_MS)}_`,
          cpuLine,
        ];
  const cpuBlock = top.byCpu.length > 0 ? ["Top CPU:", ...top.byCpu.map(formatProcSampleLine)] : [];
  const rssBlock = top.byRss.length > 0 ? ["Top RSS:", ...top.byRss.map(formatProcSampleLine)] : [];
  const blocks = input.key === "host-cpu" ? [...cpuBlock, ...rssBlock] : [...rssBlock, ...cpuBlock];
  return [...lines, ...blocks, ladderNote(input.milestoneMs)].join("\n");
}

export function runawayProcessAlertContent(p: SustainedHotProcess, milestoneMs: number): string {
  const parts: string[] = [];
  if (p.rssMbThreshold !== null) parts.push(`RSS≥${p.rssMbThreshold.toFixed(0)}MiB`);
  if (p.cpuPercentThreshold !== null)
    parts.push(`CPU≥${p.cpuPercentThreshold.toFixed(0)}% of a core`);
  return [
    `**Runaway process: ${p.label}** (pid ${p.pid})`,
    `cpu≈${p.cpuPercent.toFixed(0)}% rss=${p.rssMb.toFixed(0)}MiB (${formatRssTrend(p.rssTrendMb, p.rssTrendSpanMs)}) for ${formatDurationShort(p.sustainedMs)}`,
    `_rule=${p.ruleId}; ${parts.join(" or ")} sustained ≥${formatDurationShort(p.sustainedForMs)}. Not auto-killed._`,
    ladderNote(milestoneMs),
  ].join("\n");
}

export interface DiskInfo {
  readonly path: string;
  readonly totalGb: number;
  readonly freeGb: number;
  readonly freePercent: number;
}

export interface HostSnapshot {
  readonly load1: number;
  readonly load5: number;
  readonly nproc: number;
  readonly cpuPercent: number | null;
  readonly memTotalMb: number;
  readonly memAvailableMb: number;
  /** PSI memory averages (null when /proc/pressure is unavailable). */
  readonly memPsi: { readonly someAvg60: number; readonly fullAvg60: number } | null;
  /** All processes this tick with derived CPU rate / RSS trend (for top-N context). */
  readonly procSamples: ReadonlyArray<ProcSample>;
  readonly disks: ReadonlyArray<DiskInfo>;
  readonly runaways: ReadonlyArray<ProcInfo>;
  readonly fatProcesses: ReadonlyArray<SustainedHotProcess>;
  readonly longTurns: ReadonlyArray<{
    readonly threadId: string;
    readonly turnId: string;
    readonly ageMin: number;
  }>;
  readonly sessionErrors: ReadonlyArray<{
    readonly threadId: string;
    readonly lastError: string;
    readonly status?: string | null;
    readonly updatedAt?: string | null;
  }>;
  readonly failedUnits: ReadonlyArray<string>;
}

export type SessionLastErrorKind = "ignore" | "stale" | "fatal";

/**
 * Operational recover text that must not page as FATAL.
 * Written by orphan settle after server restart / reaper — expected, high volume.
 */
export function isExpectedSessionLastError(lastError: string): boolean {
  const text = lastError.trim().toLowerCase();
  if (text === "") return true;
  if (text.includes("recovered orphan session")) return true;
  if (text.includes("server restarted while the agent was working")) return true;
  if (text.includes("send a follow-up to resume")) return true;
  return false;
}

/**
 * Age of a projection_thread_sessions.updated_at value, or null if unparseable.
 * Sticky last_error rows keep their original timestamp; use this to drop ancient noise.
 */
export function sessionErrorAgeMs(
  updatedAt: string | null | undefined,
  nowMs: number,
): number | null {
  if (updatedAt == null || updatedAt.trim() === "") return null;
  const parsed = Date.parse(updatedAt);
  if (Number.isNaN(parsed)) return null;
  return Math.max(0, nowMs - parsed);
}

/**
 * Classify a session last_error for the ops watchdog.
 * - ignore: expected recover / empty
 * - stale: real failure text, but too old to re-page (sticky projection row)
 * - fatal: real provider / process / hard session failure still worth paging
 */
export function classifySessionLastError(input: {
  readonly lastError: string;
  readonly status?: string | null | undefined;
  readonly updatedAt?: string | null | undefined;
  readonly nowMs?: number;
  readonly maxAgeMs?: number;
}): SessionLastErrorKind {
  if (isExpectedSessionLastError(input.lastError)) return "ignore";
  // Age-gate only when the caller supplied both updatedAt and nowMs (projection path).
  // Pure text-only classification (unit tests) skips the gate — no Date.now() here.
  if (input.updatedAt !== undefined && input.nowMs !== undefined) {
    const maxAgeMs = input.maxAgeMs ?? SESSION_ERROR_MAX_AGE_MS;
    const ageMs = sessionErrorAgeMs(input.updatedAt, input.nowMs);
    // null/unparseable timestamps: treat as stale so a bad row cannot page forever.
    if (ageMs === null || ageMs > maxAgeMs) return "stale";
  }
  // Prefer true error rows; still allow non-empty last_error on other statuses when
  // the text is not an expected recover (e.g. ACP spawn failure left on interrupted).
  if (input.status === "error" || input.status === "interrupted" || input.status == null) {
    return "fatal";
  }
  // ready/idle/stopped with a leftover last_error string — still worth a quiet fatal
  // once, but not recover spam (already ignored above).
  return "fatal";
}

/**
 * Filter + cap session errors for Discord posting.
 * Groups ignored recoveries / stale stickies for optional summary; never emits them as FATAL.
 */
export function selectSessionErrorsForAlert(
  errors: ReadonlyArray<{
    readonly threadId: string;
    readonly lastError: string;
    readonly status?: string | null | undefined;
    readonly updatedAt?: string | null | undefined;
  }>,
  maxFatals: number = SESSION_ERROR_ALERT_MAX,
  timing?: { readonly nowMs: number; readonly maxAgeMs?: number },
): {
  readonly fatals: ReadonlyArray<{ readonly threadId: string; readonly lastError: string }>;
  readonly ignoredRecoveryCount: number;
  readonly ignoredStaleCount: number;
} {
  let ignoredRecoveryCount = 0;
  let ignoredStaleCount = 0;
  const fatals: Array<{ threadId: string; lastError: string }> = [];
  const maxAgeMs = timing?.maxAgeMs ?? SESSION_ERROR_MAX_AGE_MS;
  for (const entry of errors) {
    const kind = classifySessionLastError({
      lastError: entry.lastError,
      status: entry.status,
      updatedAt: entry.updatedAt,
      ...(timing !== undefined ? { nowMs: timing.nowMs, maxAgeMs } : {}),
    });
    if (kind === "ignore") {
      ignoredRecoveryCount += 1;
      continue;
    }
    if (kind === "stale") {
      ignoredStaleCount += 1;
      continue;
    }
    if (fatals.length < Math.max(0, maxFatals)) {
      fatals.push({ threadId: entry.threadId, lastError: entry.lastError });
    }
  }
  return { fatals, ignoredRecoveryCount, ignoredStaleCount };
}

/** Stable-ish key so identical failure text across threads shares one cooldown bucket. */
export function sessionErrorAlertKey(threadId: string, lastError: string): string {
  const signature = lastError
    .trim()
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu, "<id>")
    .replace(/\b\d{4,}\b/gu, "<n>")
    .slice(0, 120);
  // Prefer signature-first so N threads with the same spawn error share cooldown.
  // Fall back to thread id when the body is empty/unique.
  if (signature.length >= 12) {
    return `session-error-sig:${signature}`;
  }
  return `session-error:${threadId}`;
}

function readLoad(): { load1: number; load5: number } {
  const raw = NodeFS.readFileSync("/proc/loadavg", "utf8");
  const parts = raw.split(/\s+/);
  return { load1: Number(parts[0] ?? "0"), load5: Number(parts[1] ?? "0") };
}

function readNproc(): number {
  try {
    return NodeFS.readdirSync("/sys/devices/system/cpu").filter((name) => /^cpu\d+$/.test(name))
      .length;
  } catch {
    return 1;
  }
}

function readMemMb(): { total: number; available: number } {
  const raw = NodeFS.readFileSync("/proc/meminfo", "utf8");
  const get = (key: string) => {
    const match = new RegExp(`^${key}:\\s+(\\d+)`, "m").exec(raw);
    return match ? Number(match[1]) / 1024 : 0;
  };
  return { total: get("MemTotal"), available: get("MemAvailable") };
}

/** PSI memory averages from /proc/pressure/memory, or null when unsupported. */
export function parseMemPsi(raw: string): { someAvg60: number; fullAvg60: number } | null {
  const read = (kind: string) => {
    const match = new RegExp(`^${kind}\\b.*?\\bavg60=([\\d.]+)`, "m").exec(raw);
    return match ? Number(match[1]) : null;
  };
  const some = read("some");
  if (some === null) return null;
  return { someAvg60: some, fullAvg60: read("full") ?? 0 };
}

function readMemPsi(): { someAvg60: number; fullAvg60: number } | null {
  try {
    return parseMemPsi(NodeFS.readFileSync("/proc/pressure/memory", "utf8"));
  } catch {
    return null;
  }
}

/** Sample total jiffies from /proc/stat (all cpus line). */
function readCpuJiffies(): { idle: number; total: number } | null {
  try {
    const line = NodeFS.readFileSync("/proc/stat", "utf8").split("\n")[0] ?? "";
    // cpu user nice system idle iowait irq softirq steal ...
    const parts = line.trim().split(/\s+/).slice(1).map(Number);
    if (parts.length < 4) return null;
    const idle = (parts[3] ?? 0) + (parts[4] ?? 0); // idle + iowait
    const total = parts.reduce((a, b) => a + b, 0);
    return { idle, total };
  } catch {
    return null;
  }
}

let lastCpuSample: { idle: number; total: number } | null = null;

function sampleCpuPercent(): number | null {
  const now = readCpuJiffies();
  if (now === null) return null;
  const prev = lastCpuSample;
  lastCpuSample = now;
  if (prev === null) return null;
  const dTotal = now.total - prev.total;
  const dIdle = now.idle - prev.idle;
  if (dTotal <= 0) return null;
  return Math.max(0, Math.min(100, (1 - dIdle / dTotal) * 100));
}

function readDisk(path: string): DiskInfo | null {
  try {
    if (!NodeFS.existsSync(path)) return null;
    const s = NodeFS.statfsSync(path);
    // Node types: bsize, blocks, bfree, bavail
    const bsize = Number(s.bsize);
    const total = Number(s.blocks) * bsize;
    const free = Number(s.bavail) * bsize;
    if (total <= 0) return null;
    return {
      path,
      totalGb: total / 1024 ** 3,
      freeGb: free / 1024 ** 3,
      freePercent: (free / total) * 100,
    };
  } catch {
    return null;
  }
}

function readRssMb(pid: number): number {
  try {
    const status = NodeFS.readFileSync(`/proc/${pid}/status`, "utf8");
    const match = /^VmRSS:\s+(\d+)\s+kB/m.exec(status);
    return match ? Number(match[1]) / 1024 : 0;
  } catch {
    return 0;
  }
}

let clkTck: number | null = null;
function clockTicks(): number {
  if (clkTck === null) {
    try {
      clkTck =
        Number(
          NodeChildProcess.execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).trim(),
        ) || 100;
    } catch {
      clkTck = 100;
    }
  }
  return clkTck;
}

/** utime + stime from /proc/pid/stat (clock ticks → seconds). */
function readCpuSeconds(pid: number): number {
  try {
    const stat = NodeFS.readFileSync(`/proc/${pid}/stat`, "utf8");
    // comm can contain spaces/parens — split after last ") "
    const idx = stat.lastIndexOf(") ");
    if (idx < 0) return 0;
    const fields = stat.slice(idx + 2).split(/\s+/);
    const utime = Number(fields[11] ?? 0); // 14th field overall, 12th after state
    const stime = Number(fields[12] ?? 0);
    return (utime + stime) / clockTicks();
  } catch {
    try {
      // fields: after ") " → state ppid ... utime is index 11 (0-based) in the remainder
      const stat = NodeFS.readFileSync(`/proc/${pid}/stat`, "utf8");
      const idx = stat.lastIndexOf(") ");
      const fields = stat.slice(idx + 2).split(/\s+/);
      return (Number(fields[11] ?? 0) + Number(fields[12] ?? 0)) / 100;
    } catch {
      return 0;
    }
  }
}

function readCmdline(pid: number): string {
  try {
    return NodeFS.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ").trim();
  } catch {
    return "";
  }
}

/** systemd unit (or docker/libpod scope) from /proc/pid/cgroup; cheap single read. */
function readUnit(pid: number): string | null {
  try {
    const raw = NodeFS.readFileSync(`/proc/${pid}/cgroup`, "utf8");
    const path =
      raw
        .split("\n")
        .find((line) => line.startsWith("0::"))
        ?.slice(3) ?? "";
    const segments = path.split("/").filter(Boolean);
    for (let i = segments.length - 1; i >= 0; i--) {
      const seg = segments[i]!;
      const container = /^(?:docker|libpod)-([0-9a-f]{12})[0-9a-f]*\.scope$/u.exec(seg);
      if (container) return `container ${container[1]}`;
      if (seg.endsWith(".service")) return seg;
    }
    return null;
  } catch {
    return null;
  }
}

function listProcesses(): ReadonlyArray<ProcInfo> {
  const out: ProcInfo[] = [];
  for (const ent of NodeFS.readdirSync("/proc")) {
    if (!/^\d+$/.test(ent)) continue;
    const pid = Number(ent);
    if (pid === process.pid) continue;
    const cmd = readCmdline(pid);
    if (cmd === "") continue;
    out.push({
      pid,
      rssMb: readRssMb(pid),
      cpuSeconds: readCpuSeconds(pid),
      cmd,
      label: formatProcessLabel(cmd, readUnit(pid)),
    });
  }
  return out;
}

function listRunaways(procs: ReadonlyArray<ProcInfo>): ReadonlyArray<ProcInfo> {
  return procs.filter((p) => RUNAWAY_PATTERNS.some((rule) => rule.match(p.cmd)));
}

// Per-tick tracker state for sustained-hotness detection. Module-level because
// it must persist across `collectHostSnapshot` calls; the logic itself lives in
// the pure `trackSustainedHotProcesses`.
let sustainState: ReadonlyMap<number, ProcSustainState> = new Map();

function listFatProcesses(
  procs: ReadonlyArray<ProcInfo>,
  nowMs: number,
  rules: ReadonlyArray<AlertProcessRule>,
  memTotalMb: number,
): {
  readonly hot: ReadonlyArray<SustainedHotProcess>;
  readonly samples: ReadonlyArray<ProcSample>;
} {
  // Generic sustained high RSS / CPU alerts (never auto-kill). Our own long-lived
  // services are excluded — they are expected to run hot and are handled by
  // dedicated checks, not this generic catch-all.
  const skip = (cmd: string) =>
    cmd.includes("t3code") ||
    cmd.includes("apps/server") ||
    cmd.includes("discord-bot") ||
    cmd.includes("shared-sentry-mcp-proxy") ||
    cmd.includes("codex app-server") ||
    cmd.includes("cloud-hypervisor") ||
    cmd.includes("virtiofsd");

  const defaults = defaultRunawayProcessRules(memTotalMb);
  // Opt-in rules from the rules file act as explicit per-process ceilings and replace the
  // default runaway rules for matching processes. Self-skipped services still contribute
  // samples (host-alert context) but never per-process pages.
  const resolveRules = (proc: ProcInfo): ReadonlyArray<ResolvedProcessAlertRule> => {
    const normalizedCmd = proc.cmd.toLowerCase();
    const normalizedLabel = proc.label.toLowerCase();
    const custom = rules.find((rule) => {
      const match = rule.match.toLowerCase();
      return normalizedCmd.includes(match) || normalizedLabel.includes(match);
    });
    if (custom !== undefined) {
      return [
        {
          id: custom.id,
          rssMbThreshold: custom.rssMbThreshold ?? null,
          cpuPercentThreshold: custom.cpuPercentThreshold ?? null,
          sustainedForMs: custom.sustainedForMs,
        },
      ];
    }
    return skip(proc.cmd) ? [] : defaults;
  };

  const { next, hot, samples } = trackSustainedHotProcesses({
    prev: sustainState,
    procs,
    nowMs,
    resolveRules,
  });
  sustainState = next;
  return { hot, samples };
}

function querySqliteJson(dbPath: string, scriptBody: string, extraArgs: string[] = []): unknown {
  if (!NodeFS.existsSync(dbPath)) return null;
  try {
    const script = `
import json, sqlite3, sys, time
from datetime import datetime
db_path = sys.argv[1]
db = sqlite3.connect("file:" + db_path + "?mode=ro", uri=True)
${scriptBody}
`;
    const raw = NodeChildProcess.execFileSync("python3", ["-c", script, dbPath, ...extraArgs], {
      encoding: "utf8",
      timeout: 5_000,
    });
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Highest 0.25h × 2ⁿ milestone the turn age has reached, or `null` if still
 * below the first page threshold.
 *
 * Examples (base 15m): 14m → null; 15–29m → 15m; 30–59m → 30m; 60–119m → 60m;
 * 125m → 120m.
 */
export function longRunningTurnMilestoneMs(
  ageMs: number,
  baseMs: number = TURN_RUNNING_MIN_MS,
): number | null {
  if (!(ageMs >= baseMs) || !(baseMs > 0)) return null;
  const exp = Math.floor(Math.log2(ageMs / baseMs));
  if (!Number.isFinite(exp) || exp < 0) return null;
  return baseMs * 2 ** exp;
}

/** Next doubling milestone after the one we just paged (cap not applied). */
export function nextLongRunningTurnMilestoneMs(milestoneMs: number): number {
  return milestoneMs * 2;
}

/** Human label for a milestone duration: `15m`, `30m`, `1h`, `2h`, … */
export function formatLongRunningTurnMilestone(milestoneMs: number): string {
  const minutes = milestoneMs / 60_000;
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = minutes / 60;
  if (Number.isInteger(hours)) return `${hours}h`;
  // Keep one decimal for non-integer hours (shouldn't happen on pure 2ⁿ ladder).
  return `${hours}h`;
}

/**
 * Whether to page for this long-running turn given the last milestone already
 * posted for its `turnId`. Milestone is derived from turn age (not wall-clock
 * since last post), so bot restarts re-page at most once for the current rung.
 */
export function shouldAlertLongRunningTurn(
  ageMs: number,
  lastAlertedMilestoneMs: number | undefined,
  baseMs: number = TURN_RUNNING_MIN_MS,
):
  | { readonly alert: true; readonly milestoneMs: number }
  | { readonly alert: false; readonly milestoneMs: number | null } {
  const milestoneMs = longRunningTurnMilestoneMs(ageMs, baseMs);
  if (milestoneMs === null) {
    return { alert: false, milestoneMs: null };
  }
  if (lastAlertedMilestoneMs !== undefined && milestoneMs <= lastAlertedMilestoneMs) {
    return { alert: false, milestoneMs };
  }
  return { alert: true, milestoneMs };
}

export function listLongRunningTurns(
  dbPath: string,
  minAgeMs: number,
): ReadonlyArray<{ threadId: string; turnId: string; ageMin: number }> {
  const parsed = querySqliteJson(
    dbPath,
    `
min_age_ms = float(sys.argv[2])
has_v2_runs = db.execute(
  "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'orchestration_v2_projection_runs'"
).fetchone() is not None
if has_v2_runs:
  cur = db.execute(
    "SELECT thread_id, run_id, requested_at FROM orchestration_v2_projection_runs "
    "WHERE status = 'running' ORDER BY requested_at ASC LIMIT 10"
  )
else:
  cur = db.execute(
    "SELECT thread_id, turn_id, requested_at FROM projection_turns "
    "WHERE state = 'running' AND turn_id IS NOT NULL ORDER BY requested_at ASC LIMIT 10"
  )
now = time.time()
out = []
for thread_id, turn_id, requested_at in cur:
  try:
    started = datetime.fromisoformat(requested_at.replace("Z", "+00:00")).timestamp()
  except Exception:
    started = now
  age_ms = (now - started) * 1000
  if age_ms >= min_age_ms:
    out.append({"threadId": thread_id, "turnId": turn_id, "ageMin": int(age_ms // 60000)})
print(json.dumps(out))
`,
    [String(minAgeMs)],
  );
  return (parsed as Array<{ threadId: string; turnId: string; ageMin: number }>) ?? [];
}

export function listSessionErrors(dbPath: string): ReadonlyArray<{
  threadId: string;
  lastError: string;
  status: string | null;
  updatedAt: string | null;
}> {
  const parsed = querySqliteJson(
    dbPath,
    `
cur = db.execute(
  "SELECT thread_id, last_error, status, updated_at FROM projection_thread_sessions "
  "WHERE last_error IS NOT NULL AND TRIM(last_error) != '' "
  "ORDER BY updated_at DESC LIMIT 40"
)
print(json.dumps([
  {"threadId": r[0], "lastError": r[1] or "", "status": r[2], "updatedAt": r[3]}
  for r in cur
]))
`,
  );
  return (
    (parsed as Array<{
      threadId: string;
      lastError: string;
      status: string | null;
      updatedAt: string | null;
    }>) ?? []
  );
}

function listFailedSystemdUnits(): ReadonlyArray<string> {
  try {
    const raw = NodeChildProcess.execFileSync(
      "systemctl",
      ["list-units", "--failed", "--no-legend", "--no-pager", "--plain"],
      { encoding: "utf8", timeout: 5_000 },
    );
    return raw
      .split("\n")
      .map((line) => line.trim().split(/\s+/)[0] ?? "")
      .filter((u) => u.endsWith(".service") || u.endsWith(".timer"));
  } catch {
    return [];
  }
}

export function collectHostSnapshot(input: {
  readonly stateSqlitePath: string | undefined;
  readonly nowMs: number;
  readonly alertProcessRules: ReadonlyArray<AlertProcessRule>;
}): HostSnapshot {
  const mem = readMemMb();
  const load = readLoad();
  const procs = listProcesses();
  const disks = DISK_PATHS.map(readDisk).filter((d): d is DiskInfo => d !== null);
  const db = input.stateSqlitePath ?? "";
  const fat = listFatProcesses(procs, input.nowMs, input.alertProcessRules, mem.total);
  return {
    load1: load.load1,
    load5: load.load5,
    nproc: Math.max(1, readNproc()),
    cpuPercent: sampleCpuPercent(),
    memTotalMb: mem.total,
    memAvailableMb: mem.available,
    memPsi: readMemPsi(),
    procSamples: fat.samples,
    disks,
    runaways: listRunaways(procs),
    fatProcesses: fat.hot,
    longTurns: listLongRunningTurns(db, TURN_RUNNING_MIN_MS),
    sessionErrors: listSessionErrors(db),
    failedUnits: listFailedSystemdUnits(),
  };
}

type Poster = (
  key: string,
  content: string,
  cooldownMs?: number,
  files?: ReadonlyArray<DiscordUploadFile>,
) => Effect.Effect<void>;

let poster: Poster | null = null;

/** Bridge snapshot handler failures: short enough to notice, long enough to avoid spam. */
const BRIDGE_ALERT_COOLDOWN_MS = 3 * 60 * 1000;
const TRACE_MIME_TYPE = "text/plain;charset=utf-8";

export interface AlertTraceDelivery {
  readonly content: string;
  readonly files: ReadonlyArray<DiscordUploadFile>;
}

function alertTraceDelivery(content: string, filename: string, trace: string): AlertTraceDelivery {
  return {
    content: `${content}\n_Complete trace attached as \`${filename}\`._`,
    files: [textFile(filename, trace, TRACE_MIME_TYPE)],
  };
}

/** Identity lines shown in the short Discord alert body (not only the attachment). */
export type AlertIdentity = {
  readonly threadId?: string;
  readonly channelId?: string;
};

function alertIdentityLines(identity?: AlertIdentity): ReadonlyArray<string> {
  if (identity === undefined) return [];
  const lines: string[] = [];
  if (identity.threadId !== undefined && identity.threadId.trim() !== "") {
    lines.push(`thread=\`${identity.threadId}\``);
  }
  if (identity.channelId !== undefined && identity.channelId.trim() !== "") {
    lines.push(`channel=\`${identity.channelId}\``);
  }
  return lines;
}

export function fatalAlertDelivery(
  title: string,
  trace: string,
  identity?: AlertIdentity,
): AlertTraceDelivery {
  return alertTraceDelivery(
    [`**FATAL: ${title}**`, ...alertIdentityLines(identity)].join("\n"),
    "fatal-trace.txt",
    trace,
  );
}

export function bridgeAlertDelivery(
  title: string,
  trace: string,
  identity?: AlertIdentity,
): AlertTraceDelivery {
  return alertTraceDelivery(
    [`**BRIDGE: ${title}**`, ...alertIdentityLines(identity)].join("\n"),
    "bridge-trace.txt",
    trace,
  );
}

export function sessionErrorAlertDelivery(threadId: string, trace: string): AlertTraceDelivery {
  const filename = `t3-session-error-${threadId}.txt`;
  return alertTraceDelivery(
    ["**FATAL: T3 session error**", `thread=\`${threadId}\``].join("\n"),
    filename,
    trace,
  );
}

/**
 * Render an Effect `Cause` (or any thrown value) for Discord / logs.
 * Logging `{ cause }` alone shows `{ _id: 'Cause', failures: [ [Object] ] }`.
 */
export function formatAlertCause(cause: unknown, maxLen?: number): string {
  let text: string;
  try {
    if (Cause.isCause(cause)) {
      text = Cause.pretty(cause);
    } else if (cause instanceof Error) {
      text = cause.stack?.trim() || cause.message || String(cause);
    } else if (typeof cause === "string") {
      text = cause;
    } else {
      text = JSON.stringify(cause, null, 2) ?? String(cause);
    }
  } catch {
    text = String(cause);
  }
  const trimmed = text.replace(/\s+$/u, "").trim();
  if (trimmed === "") return "(empty cause)";
  return maxLen !== undefined && trimmed.length > maxLen ? `${trimmed.slice(0, maxLen)}…` : trimmed;
}

/**
 * Post a **fatal** ops alert (short cooldown). Safe no-op if watchdog not started
 * or channel unset. Does not require DiscordREST in the caller — uses the
 * watchdog-held poster.
 */
export const postFatalAlert = Effect.fn("Alerts.postFatalAlert")(function* (
  key: string,
  title: string,
  detail: string,
  identity?: AlertIdentity,
) {
  const p = poster;
  if (p === null) {
    yield* Effect.logError(`Fatal (no alerts channel): ${title}`, { detail, ...identity });
    return;
  }
  const delivery = fatalAlertDelivery(title, detail, identity);
  yield* p(`fatal:${key}`, delivery.content, FATAL_COOLDOWN_MS, delivery.files);
});

/**
 * Post a **bridge** ops alert (medium cooldown). Use for onThread failures,
 * stream/heartbeat Discord errors, and other bridge soft-failures that leave
 * Discord threads desynced while T3 still advances.
 */
export const postBridgeAlert = Effect.fn("Alerts.postBridgeAlert")(function* (
  key: string,
  title: string,
  detail: string,
  identity?: AlertIdentity,
) {
  const p = poster;
  if (p === null) {
    yield* Effect.logError(`Bridge alert (no alerts channel): ${title}`, { detail, ...identity });
    return;
  }
  const delivery = bridgeAlertDelivery(title, detail, identity);
  yield* p(`bridge:${key}`, delivery.content, BRIDGE_ALERT_COOLDOWN_MS, delivery.files);
});

/**
 * Periodic guest watchdog → Discord alerts channel.
 * No-op (log only) when `alertsChannelId` is unset.
 */
export const runAlertWatchdog = Effect.fn("Alerts.runAlertWatchdog")(function* (
  botConfig: DiscordBotConfig,
) {
  const channelId = botConfig.alertsChannelId;
  if (channelId === undefined || channelId.trim() === "") {
    yield* Effect.logInfo(
      "Discord alerts channel unset (DISCORD_ALERTS_CHANNEL_ID); watchdog idle",
    );
    return;
  }

  const rest = yield* DiscordREST;
  const discordConfig = yield* DiscordConfig.DiscordConfig;
  const alertProcessRules = loadAlertProcessRulesFromFileSync(botConfig.alertProcessRulesPath);
  const lastSent = new Map<string, number>();
  /** Highest long-turn milestone already posted per `turnId` (0.25h × 2ⁿ ladder). */
  const lastTurnMilestones = new Map<string, number>();
  /** Host pressure streaks and ladder state for persistent resource conditions. */
  let hostPressure = INITIAL_HOST_PRESSURE_STATE;
  let resourceLadder: ReadonlyMap<string, ConditionLadderEntry> = new Map();

  const postAlert: Poster = Effect.fn("Alerts.postAlert")(function* (
    key,
    content,
    cooldownMs = COOLDOWN_MS,
    files = [],
  ) {
    const now = yield* Clock.currentTimeMillis;
    const prev = lastSent.get(key) ?? 0;
    if (now - prev < cooldownMs) return;
    lastSent.set(key, now);
    const body =
      content.length > DISCORD_ALERT_MESSAGE_LIMIT
        ? `${content.slice(0, DISCORD_ALERT_MESSAGE_LIMIT)}…`
        : content;
    yield* Effect.gen(function* () {
      if (files.length === 0) {
        yield* rest.createMessage(channelId, { content: body });
      } else {
        yield* Effect.tryPromise({
          try: () =>
            createMessageWithAttachments({
              baseUrl: discordConfig.rest.baseUrl,
              botToken: Redacted.value(discordConfig.token),
              channelId,
              content: body,
              files,
            }),
          catch: (cause) =>
            cause instanceof DiscordUploadError
              ? cause
              : new DiscordUploadError(cause instanceof Error ? cause.message : String(cause)),
        });
      }
      yield* Effect.logInfo("Posted Discord ops alert", {
        key,
        channelId,
        fileCount: files.length,
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("Failed to post Discord ops alert").pipe(
          Effect.andThen(Effect.logError(cause)),
        ),
      ),
    );
  });

  poster = postAlert;

  // Prime CPU sample so the next tick has a delta. No boot/idle chatter —
  // only post when a check fails.
  sampleCpuPercent();

  yield* Effect.repeat(
    Effect.gen(function* () {
      const nowMs = yield* Clock.currentTimeMillis;
      const snap = collectHostSnapshot({
        stateSqlitePath: botConfig.stateSqlitePath,
        nowMs,
        alertProcessRules,
      });
      const runaways = snap.runaways;
      const hostSample: HostPressureSample = snap;
      const host = trackHostPressure({ prev: hostPressure, sample: hostSample, nowMs });
      hostPressure = host.next;
      const runawayProcs = snap.fatProcesses.filter((p) => !runaways.some((k) => k.pid === p.pid));
      const hostTitles: Record<HostPressureCondition, string> = {
        "host-cpu": "Host CPU pressure",
        "host-mem": "Host memory pressure",
      };
      const ladder = advanceConditionLadder({
        prev: resourceLadder,
        active: [
          ...host.active.map((c) => ({ ...c, title: hostTitles[c.key] })),
          ...runawayProcs.map((p) => ({
            key: `proc:${p.pid}:${p.ruleId}`,
            sinceMs: nowMs - p.sustainedMs,
            title: `Runaway process ${p.label} (pid ${p.pid})`,
          })),
        ],
        nowMs,
      });
      resourceLadder = ladder.next;
      // Cooldown 0: cadence is the 15m × 2ⁿ ladder, not wall-clock spacing.
      for (const page of ladder.pages) {
        if (page.key === "host-cpu" || page.key === "host-mem") {
          yield* postAlert(
            `${page.key}:${page.milestoneMs}:${nowMs}`,
            hostPressureAlertContent({
              key: page.key,
              sample: hostSample,
              ageMs: page.ageMs,
              milestoneMs: page.milestoneMs,
              procSamples: snap.procSamples,
            }),
            0,
          );
          continue;
        }
        const proc = runawayProcs.find((p) => page.key === `proc:${p.pid}:${p.ruleId}`);
        if (proc !== undefined) {
          yield* postAlert(
            `${page.key}:${page.milestoneMs}:${nowMs}`,
            runawayProcessAlertContent(proc, page.milestoneMs),
            0,
          );
        }
      }
      for (const rec of ladder.recovered) {
        yield* postAlert(
          `recovered:${rec.key}:${nowMs}`,
          recoveredAlertContent(rec.title, rec.durationMs),
          0,
        );
      }

      for (const d of snap.disks) {
        if (d.freePercent < DISK_FREE_MIN_PERCENT || d.freeGb < DISK_FREE_MIN_GB) {
          yield* postAlert(
            `disk:${d.path}`,
            [
              "**Low disk space**",
              `path=\`${d.path}\``,
              `free=${d.freeGb.toFixed(1)} GiB (${d.freePercent.toFixed(0)}%) of ${d.totalGb.toFixed(1)} GiB`,
              `thresholds: <${DISK_FREE_MIN_PERCENT}% or <${DISK_FREE_MIN_GB} GiB`,
            ].join("\n"),
          );
        }
      }

      if (runaways.length >= SENTRY_COUNT_ALERT) {
        yield* postAlert(
          "runaway-count",
          [
            `**Legacy Sentry MCP stdio process(es)** (${runaways.length})`,
            ...runaways.map(
              (s) =>
                `• pid=${s.pid} rss=${s.rssMb.toFixed(0)} MiB cpuTime=${s.cpuSeconds.toFixed(0)}s ${s.label}`,
            ),
            "_Not auto-killed. Prefer shared proxy `shared-sentry-mcp-proxy` + `/etc/shared-mcp-setup`._",
          ].join("\n"),
        );
      } else {
        const fat = runaways.filter((s) => s.rssMb >= SENTRY_RSS_ALERT_MB);
        if (fat.length > 0) {
          yield* postAlert(
            "runaway-rss",
            [
              "**Legacy Sentry MCP high RSS**",
              ...fat.map(
                (s) =>
                  `• pid=${s.pid} rss=${s.rssMb.toFixed(0)} MiB (alert ≥${SENTRY_RSS_ALERT_MB}) ${s.label}`,
              ),
              "_Not auto-killed. Check agent MCP config points at http://127.0.0.1:7391/mcp._",
            ].join("\n"),
          );
        }
      }

      const longTurnIds = new Set(snap.longTurns.map((t) => t.turnId));
      for (const turnId of lastTurnMilestones.keys()) {
        if (!longTurnIds.has(turnId)) lastTurnMilestones.delete(turnId);
      }
      for (const turn of snap.longTurns) {
        const ageMs = turn.ageMin * 60_000;
        const decision = shouldAlertLongRunningTurn(ageMs, lastTurnMilestones.get(turn.turnId));
        if (!decision.alert) continue;
        lastTurnMilestones.set(turn.turnId, decision.milestoneMs);
        const milestoneLabel = formatLongRunningTurnMilestone(decision.milestoneMs);
        const nextLabel = formatLongRunningTurnMilestone(
          nextLongRunningTurnMilestoneMs(decision.milestoneMs),
        );
        // Cooldown 0: cadence is the age-milestone ladder, not wall-clock spacing.
        yield* postAlert(
          `turn:${turn.turnId}`,
          [
            "**Long-running T3 turn**",
            `thread=\`${turn.threadId}\``,
            `turn=\`${turn.turnId}\``,
            `age≈${turn.ageMin} min · milestone ${milestoneLabel} (next ~${nextLabel}; ladder 15m×2ⁿ)`,
          ].join("\n"),
          0,
        );
      }

      const sessionSelection = selectSessionErrorsForAlert(
        snap.sessionErrors,
        SESSION_ERROR_ALERT_MAX,
        {
          nowMs,
          maxAgeMs: SESSION_ERROR_MAX_AGE_MS,
        },
      );
      for (const err of sessionSelection.fatals) {
        const delivery = sessionErrorAlertDelivery(err.threadId, err.lastError);
        yield* postAlert(
          sessionErrorAlertKey(err.threadId, err.lastError),
          delivery.content,
          SESSION_ERROR_FATAL_COOLDOWN_MS,
          delivery.files,
        );
      }
      // Expected recoveries and sticky multi-day last_error rows are intentionally not
      // posted — recoveries are high volume after restarts; stickies re-page forever
      // without an age gate (see SESSION_ERROR_MAX_AGE_MS).
      if (sessionSelection.ignoredRecoveryCount > 0 || sessionSelection.ignoredStaleCount > 0) {
        yield* Effect.logDebug("Skipped non-actionable session last_error rows", {
          recoveryCount: sessionSelection.ignoredRecoveryCount,
          staleCount: sessionSelection.ignoredStaleCount,
        });
      }

      if (snap.failedUnits.length > 0) {
        yield* postAlert(
          "systemd-failed",
          ["**FATAL: systemd failed units**", ...snap.failedUnits.map((u) => `• \`${u}\``)].join(
            "\n",
          ),
          FATAL_COOLDOWN_MS,
        );
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("Alert watchdog tick failed").pipe(Effect.andThen(Effect.logError(cause))),
      ),
    ),
    Schedule.spaced(POLL),
  );
});
