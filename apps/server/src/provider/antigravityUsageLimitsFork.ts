// @effect-diagnostics-next-line nodeBuiltinImport:off - Effect's symlink has no type argument, and process-group termination uses process.kill(-pid).
import * as NodeFSP from "node:fs/promises";

import type {
  AntigravityAuthMethod,
  ServerProvider,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";
import type { ServerProviderDraft } from "@t3tools/provider-core/server/snapshotProbe";
import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
  resolveUsageLimitsAfterProbe,
} from "@t3tools/provider-core/server/usageLimits";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FiberHandle from "effect/FiberHandle";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ServerSettings from "../serverSettings.ts";
import type * as AntigravityInstallation from "./AntigravityInstallation.ts";

export const ANTIGRAVITY_LIMITS_MIN_REFRESH_MS = 15 * 60 * 1_000;
const ANTIGRAVITY_LIMITS_DEFAULT_TIMEOUT_MS = 20_000;

const PTY_ROWS = 50;
const PTY_COLS = 120;
const FIVE_HOUR_MINS = 5 * 60;
const WEEKLY_MINS = 7 * 24 * 60;

const UNEXPECTED_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  [
    "trust-folder prompt",
    /Do you trust the contents of this project|Yes,\s*I trust this folder|Accessing workspace:/i,
  ],
  [
    "login prompt",
    /Sign in with Google|Log in to|Login required|Not logged in|Waiting for authentication|Enter authorization code|Select authentication|Authenticate with/i,
  ],
  [
    "update prompt",
    /Update available|New version available|Do you want to update|Press .+ to update/i,
  ],
  [
    "onboarding prompt",
    /Terms of Service|Privacy Policy|Accept and continue|Choose your theme|Welcome to Antigravity/i,
  ],
  ["auth error", /Authentication failed|Token expired|Unauthorized|Failed to authenticate/i],
];

const USAGE_ERROR_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  [
    "quota load error",
    /Failed to load quota|Error loading quota|Unable to fetch quota|Could not load quota/i,
  ],
];

const DEFAULT_ONBOARDING_JSON = `${JSON.stringify({
  consumerOnboardingComplete: true,
  enterpriseOnboardingComplete: false,
  onboardingComplete: true,
})}\n`;

const DiskCacheWindow = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["session", "weekly", "monthly", "other"]),
  label: Schema.String,
  usedPercent: Schema.Number,
  resetsAt: Schema.optional(Schema.String),
  windowDurationMins: Schema.optional(Schema.Number),
});

const DiskCachePayload = Schema.Struct({
  version: Schema.Literal(1),
  fetchedAtMs: Schema.optional(Schema.Number),
  lastAttemptAtMs: Schema.Number,
  lastError: Schema.optional(Schema.String),
  checkedAt: Schema.optional(Schema.String),
  windows: Schema.optional(Schema.Array(DiskCacheWindow)),
});
type DiskCachePayload = typeof DiskCachePayload.Type;

const decodeDiskCache = Schema.decodeUnknownOption(Schema.fromJsonString(DiskCachePayload));
const encodeDiskCache = Schema.encodeSync(Schema.fromJsonString(DiskCachePayload));

const ProbeSettingsFile = Schema.Struct({
  trustedWorkspaces: Schema.Array(Schema.String),
});
const encodeProbeSettings = Schema.encodeSync(Schema.fromJsonString(ProbeSettingsFile));

class AntigravityLimitsSymlinkError extends Schema.TaggedError<AntigravityLimitsSymlinkError>()(
  "AntigravityLimitsSymlinkError",
  { cause: Schema.Defect() },
) {}

function safePtyWrite(pty: PtyAdapter.PtyProcess, data: string): boolean {
  try {
    pty.write(data);
    return true;
  } catch {
    return false;
  }
}

function safePtyKill(pty: PtyAdapter.PtyProcess, signal: "SIGTERM" | "SIGKILL"): void {
  try {
    pty.kill(signal);
  } catch {
    // Ignore kill errors after exit.
  }
}

/** Minimal VT100/ANSI screen emulator sufficient to reconstruct Bubble Tea / Ink TUI frames. */
export class MinimalVtScreen {
  private readonly rows: number;
  private readonly cols: number;
  private grid: string[][];
  private r = 0;
  private c = 0;
  private saved: readonly [number, number] = [0, 0];
  private buf = "";

  constructor(rows = PTY_ROWS, cols = PTY_COLS) {
    this.rows = rows;
    this.cols = cols;
    this.grid = Array.from({ length: rows }, () => Array.from({ length: cols }, () => " "));
  }

  clear(): void {
    this.grid = Array.from({ length: this.rows }, () =>
      Array.from({ length: this.cols }, () => " "),
    );
    this.r = 0;
    this.c = 0;
  }

  private newline(): void {
    if (this.r + 1 >= this.rows) {
      this.grid.shift();
      this.grid.push(Array.from({ length: this.cols }, () => " "));
    } else {
      this.r += 1;
    }
  }

  feed(text: string): void {
    const s = this.buf + text;
    this.buf = "";
    let i = 0;
    const n = s.length;
    while (i < n) {
      const ch = s[i]!;
      if (ch === "\x1b") {
        if (i + 1 >= n) {
          this.buf = s.slice(i);
          break;
        }
        const nxt = s[i + 1]!;
        if (nxt === "[") {
          let j = i + 2;
          while (j < n && !(s[j]! >= "@" && s[j]! <= "~")) {
            j += 1;
          }
          if (j >= n) {
            this.buf = s.slice(i);
            break;
          }
          this.handleCsi(s.slice(i + 2, j), s[j]!);
          i = j + 1;
          continue;
        }
        if (nxt === "]") {
          let j = i + 2;
          let end = -1;
          while (j < n) {
            if (s[j] === "\x07") {
              end = j + 1;
              break;
            }
            if (s[j] === "\x1b" && j + 1 < n && s[j + 1] === "\\") {
              end = j + 2;
              break;
            }
            j += 1;
          }
          if (end === -1) {
            this.buf = s.slice(i);
            break;
          }
          i = end;
          continue;
        }
        if (nxt === "(" || nxt === ")" || nxt === "*" || nxt === "+") {
          if (i + 2 >= n) {
            this.buf = s.slice(i);
            break;
          }
          i += 3;
          continue;
        }
        if (nxt === "7") {
          this.saved = [this.r, this.c];
          i += 2;
          continue;
        }
        if (nxt === "8") {
          [this.r, this.c] = this.saved;
          i += 2;
          continue;
        }
        i += 2;
        continue;
      }
      if (ch === "\r") {
        this.c = 0;
        i += 1;
        continue;
      }
      if (ch === "\n") {
        this.newline();
        i += 1;
        continue;
      }
      if (ch === "\b") {
        this.c = Math.max(0, this.c - 1);
        i += 1;
        continue;
      }
      if (ch === "\t") {
        this.c = Math.min(this.cols - 1, (Math.floor(this.c / 8) + 1) * 8);
        i += 1;
        continue;
      }
      if (ch.charCodeAt(0) < 32) {
        i += 1;
        continue;
      }
      if (this.r >= 0 && this.r < this.rows && this.c >= 0 && this.c < this.cols) {
        this.grid[this.r]![this.c] = ch;
      }
      this.c += 1;
      if (this.c >= this.cols) {
        this.c = 0;
        this.newline();
      }
      i += 1;
    }
  }

  private nums(params: string, fallback = 1): number[] {
    const clean = params.replace(/^[?>=<]+/, "");
    if (!clean) return [fallback];
    return clean.split(";").map((part) => {
      if (!part) return fallback;
      const parsed = Number.parseInt(part, 10);
      return Number.isNaN(parsed) ? fallback : parsed;
    });
  }

  private handleCsi(params: string, cmd: string): void {
    if (params.startsWith("?")) {
      if (
        (cmd === "h" || cmd === "l") &&
        (params.includes("1049") || params.includes("1047") || params.includes("47"))
      ) {
        this.clear();
      }
      return;
    }
    if (cmd === "H" || cmd === "f") {
      const values = this.nums(params, 1);
      const row = (values[0] ?? 1) - 1;
      const col = (values[1] ?? 1) - 1;
      this.r = Math.max(0, Math.min(this.rows - 1, row));
      this.c = Math.max(0, Math.min(this.cols - 1, col));
      return;
    }
    if (cmd === "A") {
      this.r = Math.max(0, this.r - (this.nums(params, 1)[0] ?? 1));
      return;
    }
    if (cmd === "B") {
      this.r = Math.min(this.rows - 1, this.r + (this.nums(params, 1)[0] ?? 1));
      return;
    }
    if (cmd === "C") {
      this.c = Math.min(this.cols - 1, this.c + (this.nums(params, 1)[0] ?? 1));
      return;
    }
    if (cmd === "D") {
      this.c = Math.max(0, this.c - (this.nums(params, 1)[0] ?? 1));
      return;
    }
    if (cmd === "G") {
      this.c = Math.max(0, Math.min(this.cols - 1, (this.nums(params, 1)[0] ?? 1) - 1));
      return;
    }
    if (cmd === "J") {
      const mode = this.nums(params, 0)[0] ?? 0;
      if (mode === 2 || mode === 3) {
        this.clear();
      } else if (mode === 0) {
        for (let x = this.c; x < this.cols; x += 1) this.grid[this.r]![x] = " ";
        for (let y = this.r + 1; y < this.rows; y += 1) {
          this.grid[y] = Array.from({ length: this.cols }, () => " ");
        }
      } else if (mode === 1) {
        for (let y = 0; y < this.r; y += 1) {
          this.grid[y] = Array.from({ length: this.cols }, () => " ");
        }
        for (let x = 0; x <= this.c; x += 1) this.grid[this.r]![x] = " ";
      }
      return;
    }
    if (cmd === "K") {
      const mode = this.nums(params, 0)[0] ?? 0;
      if (mode === 0) {
        for (let x = this.c; x < this.cols; x += 1) this.grid[this.r]![x] = " ";
      } else if (mode === 1) {
        for (let x = 0; x <= this.c; x += 1) this.grid[this.r]![x] = " ";
      } else if (mode === 2) {
        this.grid[this.r] = Array.from({ length: this.cols }, () => " ");
      }
      return;
    }
    if (cmd === "s") {
      this.saved = [this.r, this.c];
    } else if (cmd === "u") {
      [this.r, this.c] = this.saved;
    }
  }

  text(): string {
    const lines = this.grid.map((row) => row.join("").trimEnd());
    while (lines.length > 0 && !lines[0]) lines.shift();
    while (lines.length > 0 && !lines[lines.length - 1]) lines.pop();
    return lines.join("\n");
  }
}

function stripAnsi(input: string): string {
  return input
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-Z\\-_]/g, "");
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function shortGroupLabel(name: string): string {
  const trimmed = name.trim();
  if (/claude.*gpt|gpt.*claude/i.test(trimmed)) return "Claude/GPT";
  if (/gemini/i.test(trimmed)) return "Gemini";
  return trimmed.replace(/\s+models$/i, "") || "Models";
}

export function parseRelativeDurationSeconds(input: string): number | undefined {
  if (/<\s*1\s*m/i.test(input)) return 30;
  let total = 0;
  let matched = false;
  const re = /(\d+)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/gi;
  for (const match of input.matchAll(re)) {
    const amount = Number(match[1]);
    const unit = (match[2] ?? "").toLowerCase();
    if (!Number.isFinite(amount)) continue;
    matched = true;
    if (unit.startsWith("d")) total += amount * 86_400;
    else if (unit.startsWith("h")) total += amount * 3_600;
    else if (unit.startsWith("m")) total += amount * 60;
    else if (unit.startsWith("s")) total += amount;
  }
  return matched ? total : undefined;
}

export interface ParsedAgyUsageScreen {
  readonly ok: boolean;
  readonly plan: string | undefined;
  readonly windows: ReadonlyArray<ServerProviderUsageWindow>;
  readonly error?: string;
}

/**
 * Parse rendered text from `agy`'s interactive `/usage` screen (and optional startup banner).
 * `agy` displays percent REMAINING; T3's limits model stores percent USED.
 */
export function parseAgyUsageScreen(
  screenText: string,
  options: { readonly bannerText?: string; readonly nowMs: number },
): ParsedAgyUsageScreen {
  const cleanScreen = stripAnsi(screenText);
  const cleanBanner = stripAnsi(options.bannerText ?? "");
  const combined = `${cleanBanner}\n${cleanScreen}`;

  const planMatch = combined.match(/[^\s@]+@[^\s@]+\.[a-z]{2,}\s+\(([^()]{2,60})\)/i);
  const plan = planMatch?.[1]?.trim() || undefined;

  const lines = cleanScreen.split(/\r?\n/).map((line) => line.trim());
  let currentGroup: { readonly isGemini: boolean; readonly tag: string } | null = null;
  let active: {
    readonly isUsedMetric: boolean;
    readonly id: string;
    readonly kind: "session" | "weekly";
    readonly label: string;
    readonly windowDurationMins: number;
    usedPercent: number | undefined;
    resetsAt: string | undefined;
  } | null = null;
  const collected: ServerProviderUsageWindow[] = [];
  const seenIds = new Set<string>();

  const flush = () => {
    if (!active || active.usedPercent === undefined) {
      active = null;
      return;
    }
    if (!seenIds.has(active.id)) {
      seenIds.add(active.id);
      collected.push({
        id: active.id,
        kind: active.kind,
        label: active.label,
        usedPercent: active.usedPercent,
        windowDurationMins: active.windowDurationMins,
        ...(active.resetsAt ? { resetsAt: active.resetsAt } : {}),
      });
    }
    active = null;
  };

  for (const line of lines) {
    if (!line) continue;

    if (
      /^(GEMINI|CLAUDE\s+AND\s+GPT|CLAUDE\s*\/\s*GPT|[A-Z0-9 /&-]+)\s+MODELS$/i.test(line) &&
      !/^Models within this group/i.test(line)
    ) {
      flush();
      const tag = shortGroupLabel(line);
      currentGroup = { isGemini: tag === "Gemini", tag };
      continue;
    }

    const isWeeklyHead = /\bweekly\s+limit\b/i.test(line);
    const is5hHead = /\b(?:five\s*hour|5[\s-]*hour|5h)\s+limit\b/i.test(line);
    if ((isWeeklyHead || is5hHead) && currentGroup) {
      flush();
      const is5h = is5hHead;
      const isUsedMetric = /\bused\b/i.test(line) && !/\bremaining\b/i.test(line);
      const baseId = is5h ? "5h" : "weekly";
      const suffix = currentGroup.isGemini
        ? ""
        : `_${currentGroup.tag
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "_")
            .replace(/^_|_$/g, "")}`;
      const kindLabel = is5h ? "5-hour" : "Weekly";
      active = {
        isUsedMetric,
        id: currentGroup.isGemini ? baseId : `${baseId}${suffix}`,
        kind: is5h ? "session" : "weekly",
        label: currentGroup.isGemini ? kindLabel : `${kindLabel} · ${currentGroup.tag}`,
        windowDurationMins: is5h ? FIVE_HOUR_MINS : WEEKLY_MINS,
        usedPercent: undefined,
        resetsAt: undefined,
      };
      continue;
    }

    if (!active) continue;

    if (active.usedPercent === undefined) {
      const pctMatch = line.match(/(\d+(?:\.\d+)?)\s*%/);
      if (pctMatch) {
        const value = clampPercent(Number(pctMatch[1]));
        const remaining = active.isUsedMetric ? round1(clampPercent(100 - value)) : round1(value);
        active.usedPercent = round1(clampPercent(100 - remaining));
        continue;
      }
    }

    const resetMatch = line.match(/(?:Refreshes|Resets)\s+in\s+(.+)/i);
    if (resetMatch?.[1]) {
      const durationSeconds = parseRelativeDurationSeconds(resetMatch[1]);
      if (durationSeconds !== undefined) {
        const resetDate = DateTime.make(options.nowMs + durationSeconds * 1_000);
        if (Option.isSome(resetDate)) {
          active.resetsAt = DateTime.formatIso(resetDate.value);
        }
      }
      continue;
    }
    if (/^Quota\s+available$/i.test(line)) {
      active.resetsAt = undefined;
    }
  }
  flush();

  if (collected.length === 0) {
    return {
      ok: false,
      plan,
      windows: [],
      error: "Could not parse Antigravity quota windows from agy /usage.",
    };
  }
  return { ok: true, plan, windows: collected };
}

export function detectUnexpectedAgyPrompt(
  text: string,
  extra: ReadonlyArray<readonly [string, RegExp]> = [],
): string | undefined {
  for (const [label, pattern] of UNEXPECTED_PATTERNS) {
    if (pattern.test(text)) return label;
  }
  for (const [label, pattern] of extra) {
    if (pattern.test(text)) return label;
  }
  return undefined;
}

function hasAgyUsageScreen(text: string): boolean {
  const hasGroup = /GEMINI MODELS|CLAUDE AND GPT MODELS/i.test(text);
  const hasPct = /\b\d+(?:\.\d+)?%/.test(text);
  const hasLimit = /(?:Weekly|Five Hour|5-?Hour)\s+Limit/i.test(text);
  return hasGroup && hasPct && hasLimit;
}

export function resolveAntigravityLimitsRefreshMs(
  environment: NodeJS.ProcessEnv,
  overrideMs?: number,
): number {
  const envSeconds = Number(environment.T3_ANTIGRAVITY_LIMITS_REFRESH_SECONDS);
  const configuredMs =
    Number.isFinite(envSeconds) && envSeconds > 0
      ? envSeconds * 1_000
      : overrideMs !== undefined && Number.isFinite(overrideMs) && overrideMs > 0
        ? overrideMs
        : ANTIGRAVITY_LIMITS_MIN_REFRESH_MS;
  return Math.max(ANTIGRAVITY_LIMITS_MIN_REFRESH_MS, configuredMs);
}

export interface AgyPtyCaptureResult {
  readonly ok: boolean;
  readonly banner?: string;
  readonly screen?: string;
  readonly reason?: string;
}

function killProcessGroup(pid: number, signal: "SIGTERM" | "SIGKILL", platform: NodeJS.Platform) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    if (platform !== "win32") {
      process.kill(-pid, signal);
    } else {
      process.kill(pid, signal);
    }
  } catch {
    // Process group already exited.
  }
}

/**
 * Prepare an isolated HOME for interactive `agy` so `/usage` reads the same Google account as
 * this T3 instance without touching `<profileDirectory>/antigravity-acp/` state or databases.
 * Never reads, copies, moves, or logs the OAuth token file; only symlinks it.
 */
const prepareIsolatedProbeHome = Effect.fn("antigravityUsageLimitsFork.prepareIsolatedProbeHome")(
  function* (input: { readonly profileDirectory: string; readonly platform: NodeJS.Platform }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const acpDir = path.join(input.profileDirectory, "antigravity-acp");
    const acpTokenPath = path.join(acpDir, "antigravity-oauth-token");
    if (!(yield* fs.exists(acpTokenPath).pipe(Effect.orElseSucceed(() => false)))) {
      return undefined;
    }
    const probeRoot = path.join(input.profileDirectory, "limits-probe");
    const probeHome = path.join(probeRoot, "home");
    const probeCliDir = path.join(probeHome, ".gemini", "antigravity-cli");
    const probeCacheDir = path.join(probeCliDir, "cache");
    const scratchCwd = path.join(probeRoot, "cwd");
    const logFile = path.join(probeRoot, "agy-last.log");

    for (const dir of [probeRoot, probeHome, probeCliDir, probeCacheDir, scratchCwd]) {
      yield* fs.makeDirectory(dir, { recursive: true, mode: 0o700 });
    }

    const tokenLink = path.join(probeCliDir, "antigravity-oauth-token");
    yield* fs.remove(tokenLink, { force: true }).pipe(Effect.ignore);
    yield* Effect.tryPromise({
      try: () =>
        NodeFSP.symlink(acpTokenPath, tokenLink, input.platform === "win32" ? "file" : undefined),
      catch: (cause) => new AntigravityLimitsSymlinkError({ cause }),
    });

    // `agy acp` does not mark interactive CLI onboarding complete, so seed the isolated probe cache.
    const probeOnboarding = path.join(probeCacheDir, "onboarding.json");
    yield* fs.writeFileString(probeOnboarding, DEFAULT_ONBOARDING_JSON);

    yield* fs.writeFileString(
      path.join(probeCliDir, "settings.json"),
      `${encodeProbeSettings({ trustedWorkspaces: [scratchCwd] })}\n`,
    );

    return { probeRoot, probeHome, scratchCwd, logFile } as const;
  },
);

export const captureAgyUsageScreen = Effect.fn("antigravityUsageLimitsFork.captureAgyUsageScreen")(
  function* (input: {
    readonly executablePath: string;
    readonly probeHome: string;
    readonly scratchCwd: string;
    readonly logFile: string;
    readonly baseEnv: NodeJS.ProcessEnv;
    readonly timeoutMs?: number;
    readonly settleScale?: number;
  }): Effect.fn.Return<AgyPtyCaptureResult, never, PtyAdapter.PtyAdapter> {
    const ptyAdapter = yield* PtyAdapter.PtyAdapter;
    const platform = yield* HostProcess.Platform;
    const timeoutMs = input.timeoutMs ?? ANTIGRAVITY_LIMITS_DEFAULT_TIMEOUT_MS;
    const scale = input.settleScale ?? 1;
    const scaled = (ms: number) => Math.max(0, Math.round(ms * scale));
    const startMs = yield* Clock.currentTimeMillis;
    const deadlineMs = startMs + timeoutMs;

    const env: NodeJS.ProcessEnv = {
      ...input.baseEnv,
      HOME: input.probeHome,
      ...(platform === "win32" ? { USERPROFILE: input.probeHome } : {}),
      // Match AntigravityDriver so agy reads the profile's file-stored token rather than the OS keyring.
      SSH_CONNECTION: input.baseEnv.SSH_CONNECTION || "127.0.0.1 0 127.0.0.1 0",
      AGY_CLI_DISABLE_AUTO_UPDATE: "true",
      TERM: "xterm-256color",
      COLUMNS: String(PTY_COLS),
      LINES: String(PTY_ROWS),
    };

    const spawned = yield* ptyAdapter
      .spawn({
        shell: input.executablePath,
        args: ["--log-file", input.logFile],
        cwd: input.scratchCwd,
        cols: PTY_COLS,
        rows: PTY_ROWS,
        env,
      })
      .pipe(Effect.result);

    if (spawned._tag === "Failure") {
      return { ok: false, reason: "Failed to start agy in PTY." };
    }
    const pty = spawned.success;
    const vt = new MinimalVtScreen(PTY_ROWS, PTY_COLS);
    let exited = false;
    let notifyUpdate: (() => void) | null = null;
    const exitDeferred = yield* Deferred.make<void>();

    const offData = pty.onData((chunk) => {
      if (chunk.includes("\x1b[6n")) {
        safePtyWrite(pty, "\x1b[1;1R");
      }
      if (chunk.includes("\x1b[c") || chunk.includes("\x1b[0c")) {
        safePtyWrite(pty, "\x1b[?62;c");
      }
      vt.feed(chunk);
      const wake = notifyUpdate;
      notifyUpdate = null;
      wake?.();
    });

    const offExit = pty.onExit(() => {
      exited = true;
      Deferred.doneUnsafe(exitDeferred, Exit.void);
      const wake = notifyUpdate;
      notifyUpdate = null;
      wake?.();
    });

    const waitUntil = Effect.fn("antigravityUsageLimitsFork.waitUntil")(function* (
      limitMs: number,
      predicate: (screen: string) => boolean,
      graceMs = 0,
    ): Effect.fn.Return<boolean> {
      while (true) {
        if (predicate(vt.text())) {
          if (graceMs > 0) {
            const now = yield* Clock.currentTimeMillis;
            const waitMs = Math.min(graceMs, Math.max(0, deadlineMs - now));
            if (waitMs > 0) yield* Effect.sleep(Duration.millis(waitMs));
          }
          return true;
        }
        if (exited) return false;
        const now = yield* Clock.currentTimeMillis;
        const remainingMs = Math.min(limitMs, deadlineMs) - now;
        if (remainingMs <= 0) return false;
        yield* Effect.callback<void>((resume) => {
          notifyUpdate = () => resume(Effect.void);
          return Effect.sync(() => {
            notifyUpdate = null;
          });
        }).pipe(Effect.timeoutOption(Duration.millis(Math.min(100, remainingMs))), Effect.asVoid);
      }
    });

    const cleanup = Effect.gen(function* () {
      if (!exited) {
        safePtyWrite(pty, "\x1b");
        const waitMs = scaled(150);
        if (waitMs > 0) {
          yield* Deferred.await(exitDeferred).pipe(
            Effect.timeoutOption(Duration.millis(waitMs)),
            Effect.asVoid,
          );
        }
      }
      if (!exited) {
        safePtyWrite(pty, "\x03");
        const waitMs = scaled(150);
        if (waitMs > 0) {
          yield* Deferred.await(exitDeferred).pipe(
            Effect.timeoutOption(Duration.millis(waitMs)),
            Effect.asVoid,
          );
        }
      }
      if (!exited) {
        safePtyWrite(pty, "\x03");
        const waitMs = scaled(2_000);
        if (waitMs > 0) {
          yield* Deferred.await(exitDeferred).pipe(
            Effect.timeoutOption(Duration.millis(waitMs)),
            Effect.asVoid,
          );
        }
      }
      if (!exited) {
        killProcessGroup(pty.pid, "SIGTERM", platform);
        safePtyKill(pty, "SIGTERM");
        const waitMs = scaled(1_500);
        if (waitMs > 0) {
          yield* Deferred.await(exitDeferred).pipe(
            Effect.timeoutOption(Duration.millis(waitMs)),
            Effect.asVoid,
          );
        }
      }
      if (!exited) {
        killProcessGroup(pty.pid, "SIGKILL", platform);
        safePtyKill(pty, "SIGKILL");
        const waitMs = scaled(1_000);
        if (waitMs > 0) {
          yield* Deferred.await(exitDeferred).pipe(
            Effect.timeoutOption(Duration.millis(waitMs)),
            Effect.asVoid,
          );
        }
      }
      offData();
      offExit();
    });

    const run = Effect.gen(function* () {
      const startupLimit = Math.min(deadlineMs, startMs + Math.min(10_000, timeoutMs * 0.5));
      const ready = yield* waitUntil(
        startupLimit,
        (text) => Boolean(detectUnexpectedAgyPrompt(text)) || /for shortcuts/i.test(text),
        scaled(250),
      );
      const initialScreen = vt.text();
      const initialUnexpected = detectUnexpectedAgyPrompt(initialScreen);
      if (initialUnexpected) {
        return { ok: false, reason: `agy showed ${initialUnexpected}` };
      }
      if (!ready) {
        return { ok: false, reason: "agy did not reach ready prompt before timeout" };
      }

      const nowAfterReady = yield* Clock.currentTimeMillis;
      yield* waitUntil(
        Math.min(deadlineMs, nowAfterReady + scaled(1_500)),
        (text) => Boolean(detectUnexpectedAgyPrompt(text)) || /@[^\s]+\s+\([^()]{2,}\)/.test(text),
        scaled(100),
      );
      const bannerText = vt.text();
      const bannerUnexpected = detectUnexpectedAgyPrompt(bannerText);
      if (bannerUnexpected) {
        return { ok: false, reason: `agy showed ${bannerUnexpected}` };
      }

      // Never send anything other than `/usage` + Enter.
      if (!safePtyWrite(pty, "/usage")) {
        return { ok: false, reason: "agy exited before /usage could be sent" };
      }
      const enterDelayMs = scaled(250);
      if (enterDelayMs > 0) {
        yield* Effect.sleep(Duration.millis(enterDelayMs));
      }
      if (!safePtyWrite(pty, "\r")) {
        return { ok: false, reason: "agy exited while opening /usage" };
      }

      const gotUsage = yield* waitUntil(
        deadlineMs,
        (text) =>
          hasAgyUsageScreen(text) || Boolean(detectUnexpectedAgyPrompt(text, USAGE_ERROR_PATTERNS)),
        scaled(400),
      );
      const usageText = vt.text();
      const usageUnexpected = detectUnexpectedAgyPrompt(usageText, USAGE_ERROR_PATTERNS);
      if (usageUnexpected) {
        return { ok: false, reason: `agy showed ${usageUnexpected}` };
      }
      if (!gotUsage || !hasAgyUsageScreen(usageText)) {
        return { ok: false, reason: "Timed out waiting for agy /usage screen." };
      }
      return { ok: true, banner: bannerText, screen: usageText };
    });

    return yield* run.pipe(Effect.ensuring(cleanup));
  },
);

function limitsFromDiskCache(cache: DiskCachePayload): ServerProviderUsageLimits | undefined {
  if (!cache.checkedAt || !cache.windows || cache.windows.length === 0) return undefined;
  return makeUsageLimits({ checkedAt: cache.checkedAt, windows: cache.windows });
}

export interface AntigravityUsageLimitsProbe {
  readonly probe: Effect.Effect<ServerProviderUsageLimits | undefined>;
  readonly clear: Effect.Effect<void>;
  readonly watchEnabled: Stream.Stream<boolean>;
}

export const makeAntigravityUsageLimitsProbe = Effect.fn("makeAntigravityUsageLimitsProbe")(
  function* (input: {
    readonly profileDirectory: string;
    readonly authMethod: AntigravityAuthMethod;
    readonly binaryPath: string;
    readonly processEnvironment: NodeJS.ProcessEnv;
    readonly resolveExecutable: () => Effect.Effect<
      Pick<AntigravityInstallation.AntigravityExecutable, "executablePath"> | undefined
    >;
    readonly refreshIntervalMs?: number;
    readonly timeoutMs?: number;
    readonly settleScale?: number;
  }): Effect.fn.Return<AntigravityUsageLimitsProbe, never, FileSystem.FileSystem | Path.Path> {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const platform = yield* HostProcess.Platform;
    const ptyAdapterOption = yield* Effect.serviceOption(PtyAdapter.PtyAdapter);
    const serverSettingsOption = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);

    const refreshIntervalMs = resolveAntigravityLimitsRefreshMs(
      input.processEnvironment,
      input.refreshIntervalMs,
    );
    const cacheFile = path.join(input.profileDirectory, "limits-probe", "cache.json");
    const memoryCache = yield* Ref.make<DiskCachePayload | undefined>(undefined);
    const lock = yield* Semaphore.make(1);

    const isOptedIn: Effect.Effect<boolean> = Option.isSome(serverSettingsOption)
      ? serverSettingsOption.value.getSettings.pipe(
          Effect.map((settings) => settings.antigravityUsageLimitsEnabled),
          Effect.orElseSucceed(() => true),
        )
      : Effect.succeed(true);

    const watchEnabled: Stream.Stream<boolean> = Option.isSome(serverSettingsOption)
      ? serverSettingsOption.value.streamChanges.pipe(
          Stream.map((settings) => settings.antigravityUsageLimitsEnabled),
          Stream.changes,
        )
      : Stream.empty;

    const readCache = Effect.gen(function* () {
      const inMemory = yield* Ref.get(memoryCache);
      if (inMemory !== undefined) return inMemory;
      const raw = yield* fs
        .readFileString(cacheFile)
        .pipe(Effect.orElseSucceed((): string | undefined => undefined));
      if (raw === undefined) return undefined;
      const parsed = Option.getOrUndefined(decodeDiskCache(raw));
      if (parsed !== undefined) {
        yield* Ref.set(memoryCache, parsed);
      }
      return parsed;
    });

    const writeCache = (payload: DiskCachePayload) =>
      Ref.set(memoryCache, payload).pipe(
        Effect.andThen(
          writeFileStringAtomically({
            filePath: cacheFile,
            contents: `${encodeDiskCache(payload)}\n`,
          }).pipe(
            Effect.andThen(platform !== "win32" ? fs.chmod(cacheFile, 0o600) : Effect.void),
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
            Effect.ignore,
          ),
        ),
      );

    const probe: Effect.Effect<ServerProviderUsageLimits | undefined> = Effect.gen(function* () {
      if (input.authMethod !== "oauth-personal") return undefined;
      if (!(yield* isOptedIn)) return undefined;
      if (Option.isNone(ptyAdapterOption)) return undefined;

      const executable = yield* input.resolveExecutable();
      if (!executable) return undefined;

      const probeDirs = yield* prepareIsolatedProbeHome({
        profileDirectory: input.profileDirectory,
        platform,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.orElseSucceed(() => undefined),
      );
      if (!probeDirs) return undefined;

      const nowMs = yield* Clock.currentTimeMillis;
      const cached = yield* readCache;
      if (cached?.fetchedAtMs !== undefined && nowMs - cached.fetchedAtMs < refreshIntervalMs) {
        const cachedLimits = limitsFromDiskCache(cached);
        if (cachedLimits) return cachedLimits;
      }
      if (cached !== undefined && nowMs - cached.lastAttemptAtMs < refreshIntervalMs) {
        const staleLimits = limitsFromDiskCache(cached);
        if (staleLimits) return staleLimits;
        return makeUnavailableUsageLimits({
          checkedAt: DateTime.formatIso(DateTime.makeUnsafe(cached.lastAttemptAtMs)),
          reason: "probeFailed",
          ...(cached.lastError ? { message: cached.lastError } : {}),
        });
      }

      const capture = yield* captureAgyUsageScreen({
        executablePath: executable.executablePath,
        probeHome: probeDirs.probeHome,
        scratchCwd: probeDirs.scratchCwd,
        logFile: probeDirs.logFile,
        baseEnv: input.processEnvironment,
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
        ...(input.settleScale !== undefined ? { settleScale: input.settleScale } : {}),
      }).pipe(
        Effect.provideService(PtyAdapter.PtyAdapter, ptyAdapterOption.value),
        Effect.provideService(HostProcess.Platform, platform),
      );

      const doneMs = yield* Clock.currentTimeMillis;
      const checkedAt = DateTime.formatIso(DateTime.makeUnsafe(doneMs));

      if (!capture.ok || !capture.screen) {
        const reason = capture.reason ?? "Could not read Antigravity usage limits.";
        yield* writeCache({
          ...cached,
          version: 1,
          lastAttemptAtMs: doneMs,
          lastError: reason,
        });
        return (
          (cached ? limitsFromDiskCache(cached) : undefined) ??
          makeUnavailableUsageLimits({ checkedAt, reason: "probeFailed", message: reason })
        );
      }

      const parsed = parseAgyUsageScreen(capture.screen, {
        ...(capture.banner !== undefined ? { bannerText: capture.banner } : {}),
        nowMs: doneMs,
      });
      if (!parsed.ok) {
        const reason = parsed.error ?? "Could not parse Antigravity usage limits.";
        yield* writeCache({
          ...cached,
          version: 1,
          lastAttemptAtMs: doneMs,
          lastError: reason,
        });
        return (
          (cached ? limitsFromDiskCache(cached) : undefined) ??
          makeUnavailableUsageLimits({ checkedAt, reason: "probeFailed", message: reason })
        );
      }

      const limits = makeUsageLimits({ checkedAt, windows: parsed.windows });
      yield* writeCache({
        version: 1,
        fetchedAtMs: doneMs,
        lastAttemptAtMs: doneMs,
        checkedAt: limits.checkedAt,
        windows: limits.windows,
      });
      return limits;
    }).pipe(lock.withPermits(1));

    const clear: Effect.Effect<void> = Ref.set(memoryCache, undefined).pipe(
      Effect.andThen(fs.remove(cacheFile, { force: true }).pipe(Effect.ignore)),
    );

    return { probe, clear, watchEnabled } satisfies AntigravityUsageLimitsProbe;
  },
);

const PublishingUsage = Context.Reference<boolean>("t3/provider/AntigravityForkPublishingUsage", {
  defaultValue: () => false,
});

/**
 * Coordinates background Antigravity limits probes without blocking readiness or session startup.
 * Keeps the hook inside `AntigravityProvider.ts` minimal for cheap upstream merges.
 */
export const makeAntigravityUsageLimitsController = Effect.fn(
  "makeAntigravityUsageLimitsController",
)(function* <State extends { readonly draft: ServerProviderDraft }>(input: {
  readonly enabled: boolean;
  readonly metadata: SubscriptionRef.SubscriptionRef<State>;
  readonly probeUsage?: Effect.Effect<ServerProviderUsageLimits | undefined>;
  readonly clearUsage?: Effect.Effect<void>;
  readonly watchEnabled?: Stream.Stream<boolean>;
}): Effect.fn.Return<
  {
    readonly refresh: Effect.Effect<void>;
    readonly reset: Effect.Effect<void>;
    readonly onSignedIn: Effect.Effect<void>;
    readonly bindRepublish: (effect: Effect.Effect<ServerProvider>) => Effect.Effect<void>;
  },
  never,
  Scope.Scope
> {
  const usageRead = yield* FiberHandle.make();
  const republish = yield* Deferred.make<Effect.Effect<ServerProvider>>();
  const scope = yield* Effect.scope;

  const triggerRepublish = Deferred.await(republish).pipe(
    Effect.flatten,
    Effect.provideService(PublishingUsage, true),
    Effect.ignoreCause({ log: true }),
    Effect.forkIn(scope),
  );

  const refresh = Effect.fn("AntigravityUsageLimitsController.refresh")(function* () {
    if (!input.enabled || !input.probeUsage || (yield* PublishingUsage)) return;
    yield* FiberHandle.run(
      usageRead,
      input.probeUsage.pipe(
        Effect.flatMap((probed) =>
          SubscriptionRef.update(input.metadata, (state) => {
            if (probed === undefined) {
              if (state.draft.usageLimits === undefined) return state;
              const { usageLimits: _cleared, ...rest } = state.draft;
              return { ...state, draft: rest };
            }
            return {
              ...state,
              draft: {
                ...state.draft,
                usageLimits: resolveUsageLimitsAfterProbe({
                  published: state.draft.usageLimits,
                  probed,
                }),
              },
            };
          }),
        ),
        Effect.andThen(triggerRepublish),
      ),
      { onlyIfMissing: true, startImmediately: false },
    );
  });

  const reset = Effect.gen(function* () {
    yield* FiberHandle.clear(usageRead);
    if (input.clearUsage) yield* input.clearUsage;
  });

  const clearPublished = SubscriptionRef.update(input.metadata, (state) => {
    if (state.draft.usageLimits === undefined) return state;
    const { usageLimits: _cleared, ...rest } = state.draft;
    return { ...state, draft: rest };
  });

  if (input.enabled && input.watchEnabled) {
    yield* input.watchEnabled.pipe(
      Stream.runForEach((usageLimitsEnabled) =>
        usageLimitsEnabled
          ? refresh()
          : FiberHandle.clear(usageRead).pipe(
              Effect.andThen(clearPublished),
              Effect.andThen(triggerRepublish),
              Effect.asVoid,
            ),
      ),
      Effect.forkScoped,
    );
  }

  return {
    refresh: refresh(),
    reset,
    onSignedIn: reset.pipe(
      Effect.andThen(clearPublished),
      Effect.andThen(
        Deferred.await(republish).pipe(
          Effect.flatten,
          Effect.provideService(PublishingUsage, true),
          Effect.ignoreCause({ log: true }),
        ),
      ),
      Effect.asVoid,
    ),
    bindRepublish: (effect) => Deferred.succeed(republish, effect).pipe(Effect.asVoid),
  };
});
