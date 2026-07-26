// @effect-diagnostics globalDate:off
import { formatJiraLinksForDiscord } from "./jiraLinks.ts";
import { formatPullRequestLinksForDiscord } from "./prLinks.ts";

/** Stable marker so we can find/update the pinned thread-info message after restarts. */
export const THREAD_INFO_PIN_MARKER = "Omegent Info";

/**
 * Markers the bot used before the Omegent rebrand. Detection matches these too so an
 * existing pre-rebrand pin is found and rewritten in place instead of orphaned.
 */
export const LEGACY_THREAD_INFO_PIN_MARKERS = ["T3 Thread Info"] as const;

export type ThreadInfoPinRenderInput = {
  readonly modelLine: string | null;
  readonly worktreeLine: string | null;
  readonly webLink: string | null;
  readonly extraLines?: ReadonlyArray<string | null | undefined>;
  readonly jiraIssueKeys?: ReadonlyArray<string>;
  readonly jiraBrowseBaseUrl?: string | undefined;
  readonly prUrls?: ReadonlyArray<string>;
  /** Channel / project GitHub repo (`owner/repo`) for PR label disambiguation. */
  readonly channelGithubRepoSlug?: string | null | undefined;
};

/** Durable model history for the pinned thread-info message. */
export type ThreadModelHistory = {
  readonly initialModelLine: string | null;
  readonly currentModelLine: string | null;
  /** ISO timestamp when `currentModelLine` became active (if different from initial). */
  readonly modelSinceAt: string | null;
};

export function formatModelSelectionLine(input: {
  readonly instanceId: string;
  readonly model: string;
}): string {
  return `${input.instanceId}/${input.model}`;
}

/** Germany local time for pin text: `2026-07-20 at 10:05` (no timezone label). */
const GERMANY_TIME_ZONE = "Europe/Berlin";

export function formatModelSinceLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;

  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: GERMANY_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);

  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";

  const yyyy = get("year");
  const mm = get("month");
  const dd = get("day");
  const hh = get("hour");
  const min = get("minute");
  return `${yyyy}-${mm}-${dd} at ${hh}:${min}`;
}

/**
 * Merge an observed model into durable history.
 * - First observation sets initial + current.
 * - Later changes update current and stamp modelSinceAt.
 */
export function applyModelHistoryUpdate(
  existing: ThreadModelHistory | null | undefined,
  nextModelLine: string | null | undefined,
  nowIso: string = new Date().toISOString(),
): ThreadModelHistory {
  const next =
    nextModelLine === null || nextModelLine === undefined || nextModelLine.trim() === ""
      ? null
      : nextModelLine.trim();

  if (next === null) {
    return {
      initialModelLine: existing?.initialModelLine ?? null,
      currentModelLine: existing?.currentModelLine ?? null,
      modelSinceAt: existing?.modelSinceAt ?? null,
    };
  }

  const initial = existing?.initialModelLine ?? next;
  const previousCurrent = existing?.currentModelLine ?? null;

  if (previousCurrent === null) {
    return {
      initialModelLine: initial,
      currentModelLine: next,
      modelSinceAt: next === initial ? null : (existing?.modelSinceAt ?? nowIso),
    };
  }

  if (previousCurrent === next) {
    return {
      initialModelLine: initial,
      currentModelLine: next,
      modelSinceAt: next === initial ? null : (existing?.modelSinceAt ?? null),
    };
  }

  // Model changed relative to last known current.
  return {
    initialModelLine: initial,
    currentModelLine: next,
    modelSinceAt: next === initial ? null : nowIso,
  };
}

/**
 * `Model: \`current\`` or
 * `Model: \`current\` (since YYYY-MM-DD at HH:MM, started with \`initial\`)`
 * when the current model differs from the original (time is Europe/Berlin, no zone label).
 */
export function formatThreadInfoModelLine(history: ThreadModelHistory): string | null {
  const current = history.currentModelLine?.trim() || null;
  if (current === null) return null;

  const initial = history.initialModelLine?.trim() || null;
  if (
    initial === null ||
    initial === current ||
    history.modelSinceAt === null ||
    history.modelSinceAt === undefined
  ) {
    return `Model: \`${current}\``;
  }

  return `Model: \`${current}\` (since ${formatModelSinceLabel(history.modelSinceAt)}, started with \`${initial}\`)`;
}

/**
 * Render the per-thread status message (Model / worktree / Open in Omegent / Jira / PRs).
 * Always includes the marker as the first line for pin discovery.
 */
export function renderThreadInfoPin(input: ThreadInfoPinRenderInput): string {
  const lines: string[] = [`**${THREAD_INFO_PIN_MARKER}**`];

  if (input.modelLine !== null && input.modelLine.trim() !== "") {
    lines.push(
      input.modelLine.startsWith("Model:") ? input.modelLine : `Model: \`${input.modelLine}\``,
    );
  }

  for (const extra of input.extraLines ?? []) {
    if (extra !== null && extra !== undefined && extra.trim() !== "") {
      lines.push(extra);
    }
  }

  if (input.worktreeLine !== null && input.worktreeLine.trim() !== "") {
    lines.push(input.worktreeLine);
  }

  if (input.webLink !== null && input.webLink.trim() !== "") {
    // Accept either prefix (callers pass the pre-labelled form; legacy used "Open in T3:")
    // so re-rendering an old value never double-prefixes; emit the Omegent label otherwise.
    const alreadyLabelled =
      input.webLink.startsWith("Open in Omegent:") || input.webLink.startsWith("Open in T3:");
    lines.push(alreadyLabelled ? input.webLink : `Open in Omegent: ${input.webLink}`);
  }

  const jiraSection = formatJiraLinksForDiscord(input.jiraIssueKeys ?? [], input.jiraBrowseBaseUrl);
  if (jiraSection !== null) {
    lines.push("");
    lines.push(jiraSection);
  }

  const prSection = formatPullRequestLinksForDiscord(input.prUrls ?? [], {
    channelRepoSlug: input.channelGithubRepoSlug ?? null,
  });
  if (prSection !== null) {
    lines.push("");
    lines.push(prSection);
  }

  return lines.join("\n");
}

export function isThreadInfoPinContent(content: string | null | undefined): boolean {
  if (content === null || content === undefined || content.length === 0) return false;
  if (content.includes(THREAD_INFO_PIN_MARKER)) return true;
  if (LEGACY_THREAD_INFO_PIN_MARKERS.some((marker) => content.includes(marker))) return true;
  // Legacy pre-marker messages from the bot (Model: `…` first line + Open-in link).
  return /^Model:\s*`[^`]+`/mu.test(content.trim()) && /Open in (?:T3|Omegent):/u.test(content);
}
