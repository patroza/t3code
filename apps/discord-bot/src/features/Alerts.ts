// @effect-diagnostics nodeBuiltinImport:off missingEffectContext:off anyUnknownInErrorContext:off
/**
 * Guest-side ops alerts → a dedicated Discord channel.
 *
 * - Host: load, CPU%, memory, disk free
 * - Runaways: legacy stdio Sentry MCP proliferation / high RSS → alert only (never kill)
 * - T3: long-running turns; **real** session errors only (not orphan-restart recover text)
 * - App: postFatalAlert() / postBridgeAlert() for hard + bridge failures
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

const POLL_MS = 60 * 1000;
const POLL = "60 seconds";
const COOLDOWN_MS = 10 * 60 * 1000;
/** Fatal errors use a shorter cooldown so distinct keys still surface quickly. */
const FATAL_COOLDOWN_MS = 2 * 60 * 1000;
/**
 * Session last_error fatals used to re-post every 2m per thread after restarts.
 * Longer window + signature keys keep real provider failures visible without spam.
 */
const SESSION_ERROR_FATAL_COOLDOWN_MS = 30 * 60 * 1000;
/** Cap distinct session-error posts per watchdog tick. */
const SESSION_ERROR_ALERT_MAX = 5;
/** Leave headroom below Discord's 2,000-character message-content limit. */
const DISCORD_ALERT_MESSAGE_LIMIT = 1900;

const LOAD_RATIO = 0.75;
const CPU_PERCENT_ALERT = 85;
const MEM_AVAILABLE_MIN_MB = 1024;
const DISK_FREE_MIN_PERCENT = 10;
const DISK_FREE_MIN_GB = 2;
/** Alert when a legacy stdio Sentry MCP process exceeds this RSS. */
const SENTRY_RSS_ALERT_MB = 512;
const SENTRY_COUNT_ALERT = 2;
/**
 * Default generic process rule for "unexpectedly hot" processes.
 * The sustained duration preserves the prior five-sample window semantics:
 * the first sample establishes the CPU-rate baseline, then four 60s intervals
 * must stay hot before alerting.
 *
 * This measures a *rate* (Δcpu / Δwall between ticks), not cumulative CPU time:
 * a long-lived-but-idle process (e.g. one that gathered 200s of CPU over hours
 * yet now moves a few seconds per 10 min) is not a problem and used to re-alert
 * forever. What we want to catch is a process actually pegging CPU or memory for
 * a sustained stretch.
 */
const DEFAULT_PROCESS_CPU_PERCENT = 50; // percent of a single core, averaged over the tick gap
const DEFAULT_PROCESS_RSS_ALERT_MB = 768;
const DEFAULT_PROCESS_SUSTAINED_FOR_MS = 4 * POLL_MS;
const TURN_RUNNING_MIN_MS = 15 * 60 * 1000;

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
  readonly label: string;
}

interface ResolvedProcessAlertRule {
  readonly id: string;
  readonly rssMbThreshold: number | null;
  readonly cpuPercentThreshold: number | null;
  readonly sustainedForMs: number;
}

const DEFAULT_PROCESS_ALERT_RULE: ResolvedProcessAlertRule = {
  id: "default",
  rssMbThreshold: DEFAULT_PROCESS_RSS_ALERT_MB,
  cpuPercentThreshold: DEFAULT_PROCESS_CPU_PERCENT,
  sustainedForMs: DEFAULT_PROCESS_SUSTAINED_FOR_MS,
};

/**
 * Advance the per-process hotness tracker by one tick.
 *
 * Pure so the streak/rate logic is testable without /proc. Only pids present in
 * `procs` survive into the returned state, which prunes exited processes; a pid
 * whose CPU counter went backwards is treated as reused and its streak resets.
 */
export function trackSustainedHotProcesses(input: {
  readonly prev: ReadonlyMap<number, ProcSustainState>;
  readonly procs: ReadonlyArray<ProcInfo>;
  readonly nowMs: number;
  readonly resolveRule: (proc: ProcInfo) => ResolvedProcessAlertRule;
}): {
  readonly next: Map<number, ProcSustainState>;
  readonly hot: ReadonlyArray<SustainedHotProcess>;
} {
  const next = new Map<number, ProcSustainState>();
  const hot: SustainedHotProcess[] = [];

  for (const proc of input.procs) {
    const rule = input.resolveRule(proc);
    const prior = input.prev.get(proc.pid);
    // A counter that went backwards means the pid was reused; ignore the prior.
    const reused = prior !== undefined && proc.cpuSeconds < prior.cpuSeconds;
    const previous = reused ? undefined : prior;

    const elapsedMs = previous ? input.nowMs - previous.sampledAtMs : 0;
    const cpuPercent =
      previous && elapsedMs > 0
        ? (Math.max(0, proc.cpuSeconds - previous.cpuSeconds) / (elapsedMs / 1_000)) * 100
        : null;

    const isHot =
      (rule.cpuPercentThreshold !== null &&
        cpuPercent !== null &&
        cpuPercent >= rule.cpuPercentThreshold) ||
      (rule.rssMbThreshold !== null && proc.rssMb >= rule.rssMbThreshold);
    const hotSinceMs = isHot ? (previous?.wasHot ? previous.hotSinceMs : input.nowMs) : input.nowMs;

    next.set(proc.pid, {
      cpuSeconds: proc.cpuSeconds,
      sampledAtMs: input.nowMs,
      wasHot: isHot,
      hotSinceMs,
    });

    if (isHot && input.nowMs - hotSinceMs >= rule.sustainedForMs) {
      hot.push({
        pid: proc.pid,
        rssMb: proc.rssMb,
        cpuPercent: cpuPercent ?? 0,
        ruleId: rule.id,
        rssMbThreshold: rule.rssMbThreshold,
        cpuPercentThreshold: rule.cpuPercentThreshold,
        sustainedForMs: rule.sustainedForMs,
        sustainedMs: input.nowMs - hotSinceMs,
        label: proc.label,
      });
    }
  }

  hot.sort((a, b) => b.cpuPercent - a.cpuPercent || b.rssMb - a.rssMb);
  return { next, hot: hot.slice(0, 8) };
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
  }>;
  readonly failedUnits: ReadonlyArray<string>;
}

export type SessionLastErrorKind = "ignore" | "fatal";

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
 * Classify a session last_error for the ops watchdog.
 * - ignore: expected recover / empty
 * - fatal: real provider / process / hard session failure
 */
export function classifySessionLastError(input: {
  readonly lastError: string;
  readonly status?: string | null | undefined;
}): SessionLastErrorKind {
  if (isExpectedSessionLastError(input.lastError)) return "ignore";
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
 * Groups ignored recoveries for optional summary; never emits them as FATAL lines.
 */
export function selectSessionErrorsForAlert(
  errors: ReadonlyArray<{
    readonly threadId: string;
    readonly lastError: string;
    readonly status?: string | null | undefined;
  }>,
  maxFatals: number = SESSION_ERROR_ALERT_MAX,
): {
  readonly fatals: ReadonlyArray<{ readonly threadId: string; readonly lastError: string }>;
  readonly ignoredRecoveryCount: number;
} {
  let ignoredRecoveryCount = 0;
  const fatals: Array<{ threadId: string; lastError: string }> = [];
  for (const entry of errors) {
    const kind = classifySessionLastError(entry);
    if (kind === "ignore") {
      ignoredRecoveryCount += 1;
      continue;
    }
    if (fatals.length < Math.max(0, maxFatals)) {
      fatals.push({ threadId: entry.threadId, lastError: entry.lastError });
    }
  }
  return { fatals, ignoredRecoveryCount };
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

// --- /proc helpers -----------------------------------------------------------

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
    const ticks =
      Number(NodeChildProcess.execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).trim()) ||
      100;
    return (utime + stime) / ticks;
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

function shortCmd(cmd: string): string {
  if (cmd.includes("shared-sentry-mcp-proxy")) return "shared-sentry-mcp-proxy";
  if (cmd.includes("@sentry/mcp-server") || /\bsentry-mcp\b/.test(cmd)) return "sentry-mcp";
  const base = cmd.split(/\s+/).find((p) => p.includes("/")) ?? cmd;
  return base.slice(-80);
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
      label: shortCmd(cmd),
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
): ReadonlyArray<SustainedHotProcess> {
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

  const resolveRule = (proc: ProcInfo): ResolvedProcessAlertRule => {
    const normalizedCmd = proc.cmd.toLowerCase();
    const normalizedLabel = proc.label.toLowerCase();
    const custom = rules.find((rule) => {
      const match = rule.match.toLowerCase();
      return normalizedCmd.includes(match) || normalizedLabel.includes(match);
    });
    if (custom === undefined) return DEFAULT_PROCESS_ALERT_RULE;
    return {
      id: custom.id,
      rssMbThreshold: custom.rssMbThreshold ?? null,
      cpuPercentThreshold: custom.cpuPercentThreshold ?? null,
      sustainedForMs: custom.sustainedForMs,
    };
  };

  const { next, hot } = trackSustainedHotProcesses({
    prev: sustainState,
    procs: procs.filter((p) => !skip(p.cmd)),
    nowMs,
    resolveRule,
  });
  sustainState = next;
  return hot;
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

function listLongRunningTurns(
  dbPath: string,
  minAgeMs: number,
): ReadonlyArray<{ threadId: string; turnId: string; ageMin: number }> {
  const parsed = querySqliteJson(
    dbPath,
    `
min_age_ms = float(sys.argv[2])
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
}> {
  const parsed = querySqliteJson(
    dbPath,
    `
cur = db.execute(
  "SELECT thread_id, last_error, status FROM projection_thread_sessions "
  "WHERE last_error IS NOT NULL AND TRIM(last_error) != '' "
  "ORDER BY updated_at DESC LIMIT 40"
)
print(json.dumps([
  {"threadId": r[0], "lastError": r[1] or "", "status": r[2]}
  for r in cur
]))
`,
  );
  return (parsed as Array<{ threadId: string; lastError: string; status: string | null }>) ?? [];
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
  return {
    load1: load.load1,
    load5: load.load5,
    nproc: Math.max(1, readNproc()),
    cpuPercent: sampleCpuPercent(),
    memTotalMb: mem.total,
    memAvailableMb: mem.available,
    disks,
    runaways: listRunaways(procs),
    fatProcesses: listFatProcesses(procs, input.nowMs, input.alertProcessRules),
    longTurns: listLongRunningTurns(db, TURN_RUNNING_MIN_MS),
    sessionErrors: listSessionErrors(db),
    failedUnits: listFailedSystemdUnits(),
  };
}

// --- Fatal / bridge alert bus (callable from bridge / main) ------------------

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

export function fatalAlertDelivery(title: string, trace: string): AlertTraceDelivery {
  return alertTraceDelivery(`**FATAL: ${title}**`, "fatal-trace.txt", trace);
}

export function bridgeAlertDelivery(title: string, trace: string): AlertTraceDelivery {
  return alertTraceDelivery(`**BRIDGE: ${title}**`, "bridge-trace.txt", trace);
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
export const postFatalAlert = (key: string, title: string, detail: string) =>
  Effect.gen(function* () {
    const p = poster;
    if (p === null) {
      yield* Effect.logError(`Fatal (no alerts channel): ${title}`, { detail });
      return;
    }
    const delivery = fatalAlertDelivery(title, detail);
    yield* p(`fatal:${key}`, delivery.content, FATAL_COOLDOWN_MS, delivery.files);
  });

/**
 * Post a **bridge** ops alert (medium cooldown). Use for onThread failures,
 * stream/heartbeat Discord errors, and other bridge soft-failures that leave
 * Discord threads desynced while T3 still advances.
 */
export const postBridgeAlert = (key: string, title: string, detail: string) =>
  Effect.gen(function* () {
    const p = poster;
    if (p === null) {
      yield* Effect.logError(`Bridge alert (no alerts channel): ${title}`, { detail });
      return;
    }
    const delivery = bridgeAlertDelivery(title, detail);
    yield* p(`bridge:${key}`, delivery.content, BRIDGE_ALERT_COOLDOWN_MS, delivery.files);
  });

// --- Watchdog ----------------------------------------------------------------

/**
 * Periodic guest watchdog → Discord alerts channel.
 * No-op (log only) when `alertsChannelId` is unset.
 */
export const runAlertWatchdog = (botConfig: DiscordBotConfig) =>
  Effect.gen(function* () {
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

    const postAlert: Poster = (key, content, cooldownMs = COOLDOWN_MS, files = []) =>
      Effect.gen(function* () {
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
        const loadLimit = snap.nproc * LOAD_RATIO;

        // --- load ---
        if (snap.load1 >= loadLimit && snap.load1 >= 2) {
          yield* postAlert(
            "load",
            [
              "**High load**",
              `load1=${snap.load1.toFixed(2)} load5=${snap.load5.toFixed(2)}`,
              `threshold≈${loadLimit.toFixed(2)} on ${snap.nproc} CPUs`,
              `cpu≈${snap.cpuPercent?.toFixed(0) ?? "?"}%; mem avail=${snap.memAvailableMb.toFixed(0)} MiB`,
            ].join("\n"),
          );
        }

        // --- cpu ---
        if (snap.cpuPercent !== null && snap.cpuPercent >= CPU_PERCENT_ALERT) {
          yield* postAlert(
            "cpu",
            [
              "**High CPU**",
              `cpu≈${snap.cpuPercent.toFixed(0)}% (alert ≥${CPU_PERCENT_ALERT}%)`,
              `load1=${snap.load1.toFixed(2)} nproc=${snap.nproc}`,
              snap.fatProcesses.length > 0
                ? `sustained:\n${snap.fatProcesses
                    .slice(0, 5)
                    .map(
                      (p) =>
                        `• pid=${p.pid} rss=${p.rssMb.toFixed(0)}MiB cpu≈${p.cpuPercent.toFixed(0)}% ${p.label}`,
                    )
                    .join("\n")}`
                : "",
            ]
              .filter(Boolean)
              .join("\n"),
          );
        }

        // --- memory ---
        if (snap.memAvailableMb > 0 && snap.memAvailableMb < MEM_AVAILABLE_MIN_MB) {
          yield* postAlert(
            "mem",
            [
              "**Low memory**",
              `available=${snap.memAvailableMb.toFixed(0)} MiB (min ${MEM_AVAILABLE_MIN_MB})`,
              `total=${snap.memTotalMb.toFixed(0)} MiB`,
              snap.runaways.length > 0
                ? `runaways: ${snap.runaways.map((s) => `pid=${s.pid} ${s.rssMb.toFixed(0)}MiB`).join(", ")}`
                : "",
            ]
              .filter(Boolean)
              .join("\n"),
          );
        }

        // --- disk ---
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

        // --- runaway MCP (legacy stdio Sentry) — alert only, never kill ---
        const runaways = snap.runaways;
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

        // --- other stuck/fat processes (alert only) ---
        const fatNonRunaway = snap.fatProcesses.filter(
          (p) => !runaways.some((k) => k.pid === p.pid),
        );
        if (fatNonRunaway.length > 0) {
          yield* postAlert(
            "stuck-proc",
            [
              "**Sustained high RSS / CPU process(es)**",
              ...fatNonRunaway.map(
                (p) =>
                  `• pid=${p.pid} rss=${p.rssMb.toFixed(0)}MiB cpu≈${p.cpuPercent.toFixed(0)}% ` +
                  `for ${Math.round(p.sustainedMs / 60_000)}m ${p.label}`,
              ),
              ...fatNonRunaway.map((p) => {
                const parts = [];
                if (p.rssMbThreshold !== null) parts.push(`RSS≥${p.rssMbThreshold.toFixed(0)}MiB`);
                if (p.cpuPercentThreshold !== null) {
                  parts.push(`CPU≥${p.cpuPercentThreshold.toFixed(0)}% of a core`);
                }
                return `_rule=${p.ruleId}; sustained ≥${Math.round(p.sustainedForMs / 60_000)}m; ${parts.join(" or ")}._`;
              }),
            ].join("\n"),
          );
        }

        // --- long T3 turns ---
        for (const turn of snap.longTurns) {
          yield* postAlert(
            `turn:${turn.turnId}`,
            [
              "**Long-running T3 turn**",
              `thread=\`${turn.threadId}\``,
              `turn=\`${turn.turnId}\``,
              `age≈${turn.ageMin} min (alert after ${TURN_RUNNING_MIN_MS / 60_000} min)`,
            ].join("\n"),
          );
        }

        // --- session last_error (real fatals only; skip orphan-restart recover spam) ---
        const sessionSelection = selectSessionErrorsForAlert(snap.sessionErrors);
        for (const err of sessionSelection.fatals) {
          const delivery = sessionErrorAlertDelivery(err.threadId, err.lastError);
          yield* postAlert(
            sessionErrorAlertKey(err.threadId, err.lastError),
            delivery.content,
            SESSION_ERROR_FATAL_COOLDOWN_MS,
            delivery.files,
          );
        }
        // Expected recoveries are intentionally not posted — high volume after restarts
        // and already covered by Wake Required UX when work was actually mid-turn.
        if (sessionSelection.ignoredRecoveryCount > 0) {
          yield* Effect.logDebug("Skipped expected session last_error recoveries", {
            count: sessionSelection.ignoredRecoveryCount,
          });
        }

        // --- failed systemd units ---
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
          Effect.logError("Alert watchdog tick failed").pipe(
            Effect.andThen(Effect.logError(cause)),
          ),
        ),
      ),
      Schedule.spaced(POLL),
    );
  });
