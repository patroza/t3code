import { Discord } from "dfx";

const DISCORD_MESSAGE_LIMIT = 2000;

/** Appended to the tip of in-progress Discord stream messages (italic in Discord markdown). */
export const WORKING_INDICATOR = "_Working.._";
export const WORKING_INDICATOR_SUFFIX = `\n\n${WORKING_INDICATOR}`;
export type WorkingDotCount = 2 | 3 | 4;

/** Cap for the wake summary appended to the Working line. */
export const WORKING_WAKE_NOTE_MAX = 80;

/** Longest Working suffix we reserve room for (dots + wake note + large tool count). */
const WORKING_INDICATOR_MAX = `_Working.... · ${"x".repeat(WORKING_WAKE_NOTE_MAX)} · 9999 tool calls_`;

/**
 * Optional tool-call progress on the Working indicator (Discord only shows a count,
 * not individual tool rows — same cadence as the 10s dot heartbeat).
 */
export function formatWorkingToolCountLabel(toolCallCount: number): string | null {
  if (!Number.isFinite(toolCallCount) || toolCallCount <= 0) return null;
  const n = Math.floor(toolCallCount);
  return n === 1 ? "1 tool call" : `${n} tool calls`;
}

/**
 * One-line wake fact for the Working indicator.
 * Strips markdown that would break the italic marker or the ` · ` separators.
 */
export function formatWorkingWakeNote(note: string | null | undefined): string | null {
  if (note == null) return null;
  const compact = note
    .replace(/[\r\n]+/g, " ")
    .replace(/[_*`]/g, " ")
    .replace(/·/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  if (compact.length === 0) return null;
  if (compact.length <= WORKING_WAKE_NOTE_MAX) return compact;
  return `${compact.slice(0, WORKING_WAKE_NOTE_MAX - 1).trimEnd()}…`;
}

export function workingIndicator(
  dotCount: WorkingDotCount,
  toolCallCount = 0,
  wakeNote: string | null = null,
): string {
  const dots = ".".repeat(dotCount);
  const note = formatWorkingWakeNote(wakeNote);
  const tools = formatWorkingToolCountLabel(toolCallCount);
  const parts = [`Working${dots}`];
  if (note !== null) parts.push(note);
  if (tools !== null) parts.push(tools);
  // Keep the whole marker italic so Discord renders one clean status line.
  return `_${parts.join(" · ")}_`;
}

export function nextWorkingDotCount(current: WorkingDotCount): WorkingDotCount {
  if (current === 2) return 3;
  if (current === 3) return 4;
  return 2;
}

/** Strip trailing Working.. markers so finalize never leaves them on the final post. */
export function stripWorkingIndicator(content: string): string {
  // Optional wake note, then optional " · N tool call(s)", inside the marker (italic or plain).
  // Notes are sanitized so they contain neither `_` nor `·`.
  const wakeSuffix = "(?:\\s*·\\s*[^_\\r\\n·]+)?";
  const toolSuffix = "(?:\\s*·\\s*\\d+\\s+tool calls?)?";
  const workingTail = new RegExp(
    `(?:\\r?\\n)+\\s*_Working\\.{2,4}${wakeSuffix}${toolSuffix}_\\s*$`,
    "u",
  );
  const workingTailPlain = new RegExp(
    `(?:\\r?\\n)+\\s*Working\\.{2,4}${wakeSuffix}${toolSuffix}\\s*$`,
    "u",
  );
  const workingInline = new RegExp(`\\s*_Working\\.{2,4}${wakeSuffix}${toolSuffix}_\\s*$`, "u");
  const workingInlinePlain = new RegExp(`\\s*Working\\.{2,4}${wakeSuffix}${toolSuffix}\\s*$`, "u");
  return content
    .replace(workingTail, "")
    .replace(workingTailPlain, "")
    .replace(workingInline, "")
    .replace(workingInlinePlain, "")
    .trimEnd();
}

export function chunkDiscordContent(content: string, limit = DISCORD_MESSAGE_LIMIT): string[] {
  const trimmed = content.trimEnd();
  if (trimmed.length === 0) return [""];
  if (trimmed.length <= limit) return [trimmed];

  const chunks: string[] = [];
  let remaining = trimmed;
  while (remaining.length > limit) {
    let splitAt = remaining.lastIndexOf("\n", limit);
    if (splitAt < Math.floor(limit * 0.5)) {
      splitAt = remaining.lastIndexOf(" ", limit);
    }
    if (splitAt < Math.floor(limit * 0.5)) {
      splitAt = limit;
    }
    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

/**
 * Format a stream chunk for Discord. The last (tip) chunk always ends with _Working.._
 * so users can see the turn is still in progress. Optional toolCallCount shows progress
 * without listing individual tools. wakeNote is the orchestration notification summary
 * (e.g. `_Working.. · #516: checks failed · 3 tool calls_`).
 */
export function formatInProgressChunk(
  chunk: string,
  isLastChunk: boolean,
  limit = DISCORD_MESSAGE_LIMIT,
  workingDots: WorkingDotCount = 2,
  toolCallCount = 0,
  wakeNote: string | null = null,
): string {
  if (!isLastChunk) {
    return chunk.length > 0 ? chunk : "…";
  }
  const body = chunk.trimEnd();
  const indicator = workingIndicator(workingDots, toolCallCount, wakeNote);
  const indicatorSuffix = `\n\n${indicator}`;
  if (body.length === 0) return indicator;
  const maxBody = Math.max(0, limit - indicatorSuffix.length);
  const trimmedBody = body.length > maxBody ? body.slice(0, maxBody).trimEnd() : body;
  return `${trimmedBody}${indicatorSuffix}`;
}

/** Chunk limit reserved so the tip can always fit the Working.. suffix (+ note + tool count). */
export function inProgressChunkLimit(limit = DISCORD_MESSAGE_LIMIT): number {
  return Math.max(1, limit - `\n\n${WORKING_INDICATOR_MAX}`.length);
}

type WakeNoteMessage = {
  readonly role: string;
  readonly turnId?: string | null | undefined;
  readonly notification?: { readonly summary?: string | null | undefined } | null | undefined;
  readonly delegatedCompletion?: unknown;
};

type WakeNoteActivity = {
  readonly kind: string;
  readonly summary: string;
  readonly turnId?: string | null;
};

/**
 * Summary for the turn Discord is currently showing as Working.
 * Uses the trigger user message's notification. A delegated completion has no
 * notification on the message; its summary is the notification activity v2 projected.
 * A later human message on the same turn contributes nothing.
 */
export function activeTurnWakeNote(input: {
  readonly latestTurnId: string | null | undefined;
  readonly messages: ReadonlyArray<WakeNoteMessage>;
  readonly activities?: ReadonlyArray<WakeNoteActivity>;
}): string | null {
  const turnId = input.latestTurnId?.trim() ?? "";
  if (turnId === "") return null;
  let trigger: WakeNoteMessage | undefined;
  for (let index = input.messages.length - 1; index >= 0; index -= 1) {
    const message = input.messages[index];
    if (message === undefined || message.role !== "user") continue;
    if ((message.turnId?.trim() ?? "") !== turnId) continue;
    trigger = message;
    break;
  }
  if (trigger === undefined) return null;
  const summary = trigger.notification?.summary?.trim();
  if (summary) return summary;
  if (trigger.delegatedCompletion == null) return null;
  const activities = input.activities ?? [];
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (activity === undefined || activity.kind !== "notification") continue;
    if ((activity.turnId?.trim() ?? "") !== turnId) continue;
    const text = activity.summary.trim();
    if (text !== "" && text !== "notification") return text;
  }
  return null;
}

export function turnStopCustomId(threadId: string): string {
  return `t3_stop:${threadId}`;
}

export function turnContinueCustomId(threadId: string): string {
  return `t3_continue:${threadId}`;
}

/** Bold wake-up status line when a session was interrupted (e.g. server restart). */
export const WAKE_UP_STATUS_LINE = "**This thread needs another message to wake the bot.**";

/**
 * Replace a Working tip body with wake-up status (strip Working.. / Stop context).
 * Keeps any partial stream prose above the status line.
 */
export function formatWakeUpTipContent(tipContent: string): string {
  const body = stripWorkingIndicator(tipContent).trim();
  if (body === "" || body === "…") return WAKE_UP_STATUS_LINE;
  return `${body}\n\n${WAKE_UP_STATUS_LINE}`;
}

export function workingMessageFields(content: string, threadId: string) {
  return {
    content,
    components: [
      [
        {
          type: 2 as const,
          custom_id: turnStopCustomId(threadId),
          label: "Stop",
          style: Discord.ButtonStyleTypes.DANGER,
        },
      ],
    ].map((components) => ({
      type: 1 as const,
      components,
    })),
  };
}

/** Wake-required tip: no Stop; blue Continue to help the user resume. */
export function wakeUpMessageFields(content: string, threadId: string) {
  return {
    content,
    components: [
      [
        {
          type: 2 as const,
          custom_id: turnContinueCustomId(threadId),
          label: "Continue",
          style: Discord.ButtonStyleTypes.PRIMARY,
        },
      ],
    ].map((components) => ({
      type: 1 as const,
      components,
    })),
  };
}

export function idleMessageFields(content: string) {
  return {
    content,
    components: [],
  };
}

export function formatThreadTitle(value: string, max = 100, fallback = "T3 thread"): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length === 0) return fallback;
  if (compact.length <= max) return compact;
  return `${compact.slice(0, max - 1).trimEnd()}…`;
}

export function truncateTitle(value: string, max = 100): string {
  return formatThreadTitle(value, max);
}

/**
 * Discord thread title badges are two independent optional columns (like the T3 client):
 *   `| PR status | Working status | Title`
 *
 * Either column may be absent. Single emoji (+ space) so columns stay aligned.
 */
const DISCORD_THREAD_TITLE_PR_PREFIX = {
  initialized: "▫️ ",
  open: "🔀 ",
  /** Open PR with failing checks — single ❌ (no dual ❌ 🔀). */
  openFailing: "❌ ",
  merged: "✔️ ",
  closed: "✖️ ",
} as const;

const DISCORD_THREAD_TITLE_ACTIVITY_PREFIX = {
  /** Session interrupted (Wake Required). */
  wakeRequired: "❗ ",
  /** Turn in progress (Discord shows Working..). */
  busy: "⏳ ",
} as const;

/** PR / change-request column (optional). */
export type DiscordThreadPrDecorState = "initialized" | "open" | "merged" | "closed" | null;

/** Working / lifecycle column (optional). */
export type DiscordThreadActivityDecorState = "busy" | "wake-required" | null;

/** Composed title decoration — both slots optional. */
export type DiscordThreadTitleDecorParts = {
  readonly pr?: DiscordThreadPrDecorState;
  readonly activity?: DiscordThreadActivityDecorState;
  readonly hasFailingChecks?: boolean;
};

/**
 * Legacy single-slot state (exclusive PR *or* activity). Prefer `DiscordThreadTitleDecorParts`.
 * Kept so existing call sites / tests keep compiling during the dual-slot transition.
 */
export type DiscordThreadTitleDecorState =
  | DiscordThreadPrDecorState
  | DiscordThreadActivityDecorState;

// Standalone ❌ = open+failing; also strip legacy "❌ 🔀" and normal PR icons.
const DISCORD_THREAD_PR_PREFIX_RE = /^(?:❌\s+🔀\s+|❌\s+|(?:🍴|✅|·|▫️|🔀|✓|✔️|✕|✖️)\s+)/u;
const DISCORD_THREAD_ACTIVITY_PREFIX_RE = /^(?:❗|⏳)\s+/u;

/** Strip every known badge prefix (any order / legacy single-slot titles). */
export function stripDiscordThreadTitlePrefixes(title: string): string {
  let remaining = title.trimStart();
  for (let i = 0; i < 4; i += 1) {
    const next = remaining
      .replace(DISCORD_THREAD_PR_PREFIX_RE, "")
      .replace(DISCORD_THREAD_ACTIVITY_PREFIX_RE, "");
    if (next === remaining) break;
    remaining = next;
  }
  return remaining;
}

function prPrefixFor(pr: DiscordThreadPrDecorState, hasFailingChecks: boolean): string {
  if (pr === "initialized") return DISCORD_THREAD_TITLE_PR_PREFIX.initialized;
  if (pr === "open") {
    return hasFailingChecks
      ? DISCORD_THREAD_TITLE_PR_PREFIX.openFailing
      : DISCORD_THREAD_TITLE_PR_PREFIX.open;
  }
  if (pr === "merged") return DISCORD_THREAD_TITLE_PR_PREFIX.merged;
  if (pr === "closed") return DISCORD_THREAD_TITLE_PR_PREFIX.closed;
  return "";
}

function activityPrefixFor(activity: DiscordThreadActivityDecorState): string {
  if (activity === "wake-required") return DISCORD_THREAD_TITLE_ACTIVITY_PREFIX.wakeRequired;
  if (activity === "busy") return DISCORD_THREAD_TITLE_ACTIVITY_PREFIX.busy;
  return "";
}

function normalizeDecorParts(
  stateOrParts: DiscordThreadTitleDecorState | DiscordThreadTitleDecorParts,
  hasFailingChecks: boolean,
): {
  readonly pr: DiscordThreadPrDecorState;
  readonly activity: DiscordThreadActivityDecorState;
  readonly hasFailingChecks: boolean;
} {
  if (stateOrParts === null || stateOrParts === undefined) {
    return { pr: null, activity: null, hasFailingChecks: false };
  }
  if (typeof stateOrParts === "string") {
    if (stateOrParts === "busy" || stateOrParts === "wake-required") {
      return { pr: null, activity: stateOrParts, hasFailingChecks: false };
    }
    return { pr: stateOrParts, activity: null, hasFailingChecks };
  }
  return {
    pr: stateOrParts.pr ?? null,
    activity: stateOrParts.activity ?? null,
    hasFailingChecks: stateOrParts.hasFailingChecks ?? hasFailingChecks,
  };
}

/**
 * Decorate a Discord thread title.
 *
 * Preferred: `decorateDiscordThreadTitle(title, { pr: "open", activity: "busy" })`
 * → `🔀 ⏳ Title`
 *
 * Legacy single-slot still works: `decorateDiscordThreadTitle(title, "open")` → `🔀 Title`.
 */
export function decorateDiscordThreadTitle(
  title: string,
  stateOrParts: DiscordThreadTitleDecorState | DiscordThreadTitleDecorParts = null,
  max = 100,
  hasFailingChecks = false,
): string {
  const parts = normalizeDecorParts(stateOrParts, hasFailingChecks);
  const baseTitle = truncateTitle(stripDiscordThreadTitlePrefixes(title), max);
  const prefix = `${prPrefixFor(parts.pr, parts.hasFailingChecks)}${activityPrefixFor(parts.activity)}`;
  return truncateTitle(`${prefix}${baseTitle}`, max);
}

export function stripBotMention(
  content: string,
  botUserId: string,
  botRoleId?: string | null,
): string {
  const userMention = new RegExp(`<@!?${botUserId}>`, "g");
  const withoutUserMention = content.replace(userMention, " ");
  const withoutManagedRoleMention =
    botRoleId === undefined || botRoleId === null
      ? withoutUserMention
      : withoutUserMention.replace(new RegExp(`<@&${botRoleId}>`, "g"), " ");
  return withoutManagedRoleMention.replace(/\s+/g, " ").trim();
}
