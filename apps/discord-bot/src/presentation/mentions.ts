import { parseProviderModelFlags } from "@t3tools/shared/providerModelSelection";

import { parseLinkThreadCommand, type LinkThreadCommand } from "./t3ThreadRef.ts";

/** How a mid-turn Discord follow-up is delivered to the server queue. */
export type DiscordFollowUpDelivery = "steer" | "queue";

export interface ParsedMentionFlags {
  readonly model?: string;
  readonly provider?: string;
  readonly base?: string;
  readonly local: boolean;
  readonly plan: boolean;
  /**
   * Explicit mid-turn delivery override. When omitted, busy-thread follow-ups
   * **queue** server-side (platform default) and are badged with 📥.
   * `--steer` injects into the active turn immediately; `--queue` forces park.
   */
  readonly followUpDelivery?: DiscordFollowUpDelivery;
  readonly prompt: string;
}

/**
 * Resolve mid-turn delivery. Default is **queue** (server-aligned); `--steer`
 * / `/omegent steer` force injection. Idle threads ignore this (startTurn
 * opens a normal turn).
 */
export function resolveDiscordFollowUpDelivery(
  flags: Pick<ParsedMentionFlags, "followUpDelivery">,
): DiscordFollowUpDelivery {
  return flags.followUpDelivery ?? "queue";
}

export type ParsedMentionIntent =
  | { readonly kind: "interrupt" }
  | { readonly kind: "help" }
  | { readonly kind: "refresh-indicators" }
  | LinkThreadCommand
  | ({ readonly kind: "prompt" } & ParsedMentionFlags);

const INTERRUPT_PROMPTS = new Set(["stop", "cancel", "abort", "interrupt"]);
const HELP_PROMPTS = new Set(["help"]);
const REFRESH_INDICATORS_PROMPTS = new Set([
  "refresh-indicators",
  "refresh indicators",
  "refresh-title",
  "refresh title",
]);

/**
 * Parse optional flags from a bot mention body (after stripping the mention).
 * Flags: --model <slug> --provider <instanceId> --base <branch> --local --plan
 *        --steer --queue
 *
 * `--steer` / `--queue` last-wins when both appear.
 */
export function parseMentionFlags(raw: string): ParsedMentionFlags {
  const providerModel = parseProviderModelFlags(raw);
  const tokens = providerModel.prompt
    .trim()
    .split(/\s+/u)
    .filter((token) => token.length > 0);
  let base: string | undefined;
  let local = false;
  let plan = false;
  let followUpDelivery: DiscordFollowUpDelivery | undefined;
  const promptParts: string[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token === "--local") {
      local = true;
      continue;
    }
    if (token === "--plan") {
      plan = true;
      continue;
    }
    if (token === "--steer") {
      followUpDelivery = "steer";
      continue;
    }
    if (token === "--queue") {
      followUpDelivery = "queue";
      continue;
    }
    if (token === "--base") {
      const next = tokens[index + 1];
      if (next !== undefined && !next.startsWith("--")) {
        base = next;
        index += 1;
        continue;
      }
    }
    promptParts.push(token);
  }

  return {
    ...(providerModel.model === undefined ? {} : { model: providerModel.model }),
    ...(providerModel.provider === undefined ? {} : { provider: providerModel.provider }),
    ...(base === undefined ? {} : { base }),
    local,
    plan,
    ...(followUpDelivery === undefined ? {} : { followUpDelivery }),
    prompt: promptParts.join(" ").trim(),
  };
}

export function parseMentionIntent(raw: string): ParsedMentionIntent {
  const linkThread = parseLinkThreadCommand(raw);
  if (linkThread !== null) return linkThread;

  const parsed = parseMentionFlags(raw);
  const normalizedPrompt = parsed.prompt
    .trim()
    .toLocaleLowerCase()
    .replace(/^[\s.,!?;:()[\]{}"'`~*_#-]+|[\s.,!?;:()[\]{}"'`~*_#-]+$/gu, "");

  if (INTERRUPT_PROMPTS.has(normalizedPrompt)) {
    return { kind: "interrupt" };
  }

  if (HELP_PROMPTS.has(normalizedPrompt)) {
    return { kind: "help" };
  }

  if (REFRESH_INDICATORS_PROMPTS.has(normalizedPrompt)) {
    return { kind: "refresh-indicators" };
  }

  return { kind: "prompt", ...parsed };
}

export function parseTopicShortName(topic: string | null | undefined): string | null {
  if (topic === null || topic === undefined) return null;
  const match = /\bt3-([a-z0-9]+(?:-[a-z0-9]+)*)\b/i.exec(topic);
  return match?.[1]?.toLowerCase() ?? null;
}

/** Read Discord channel.topic when present (threads usually have none). */
export function readChannelTopic(channel: unknown): string | null | undefined {
  if (channel === null || channel === undefined || typeof channel !== "object") return null;
  if (!("topic" in channel)) return null;
  return (channel as { readonly topic?: string | null | undefined }).topic;
}

/**
 * Result of resolving the project-binding topic for a mention/slash command.
 * Distinguishes a missing `t3-*` tag from a failed parent-channel fetch (Discord outage).
 */
export type ProjectTopicLookup =
  | {
      readonly kind: "resolved";
      readonly topic: string | null | undefined;
      readonly parentChannelId: string | null;
    }
  | {
      readonly kind: "parent-unavailable";
      readonly parentChannelId: string;
      readonly cause: string;
    };

/**
 * Pure merge of thread channel + optional parent GET outcome into a topic lookup.
 * When `parentId` is set, the parent response is authoritative; a failed parent GET
 * must not be confused with "channel has no t3-* tag".
 */
export function projectTopicFromParentLookup(input: {
  readonly channel: unknown;
  readonly parentId: string | null;
  readonly parent:
    | { readonly ok: true; readonly channel: unknown }
    | { readonly ok: false; readonly cause: string }
    | null;
}): ProjectTopicLookup {
  if (input.parentId === null) {
    return {
      kind: "resolved",
      topic: readChannelTopic(input.channel),
      parentChannelId: null,
    };
  }
  if (input.parent === null || !input.parent.ok) {
    return {
      kind: "parent-unavailable",
      parentChannelId: input.parentId,
      cause: input.parent === null ? "parent channel not fetched" : input.parent.cause,
    };
  }
  return {
    kind: "resolved",
    topic: readChannelTopic(input.parent.channel),
    parentChannelId: input.parentId,
  };
}

/** User-facing copy when we cannot bind a Discord channel to a T3 project. */
export function missingProjectBindingMessage(input: {
  readonly inThread: boolean;
  readonly parentUnavailable: boolean;
}): string {
  if (input.parentUnavailable) {
    return input.inThread
      ? "Couldn't read the parent channel topic (Discord API may be degraded). Please try again in a moment."
      : "Couldn't read the channel topic (Discord API may be degraded). Please try again in a moment.";
  }
  return input.inThread
    ? "This channel is not linked to a T3 project. Set the parent channel topic to include `t3-<shortName>` (e.g. `t3-example-project`)."
    : "This channel is not linked to a T3 project. Set the channel topic to include `t3-<shortName>` (e.g. `t3-example-project`).";
}

/**
 * Error string when topic-based project resolution fails for a bridged turn.
 * Prefers an existing Discord↔T3 link over a misleading "no topic tag" during outages.
 */
export function bridgedTurnTopicResolutionError(input: {
  readonly topicError: string;
  readonly parentUnavailable: boolean;
  readonly hasExistingLink: boolean;
  readonly recoveredFromLink: boolean;
}): string | null {
  if (input.recoveredFromLink) return null;
  if (input.parentUnavailable) {
    return input.hasExistingLink
      ? "Couldn't read the parent channel topic and could not recover the linked T3 project. Please try again in a moment."
      : "Couldn't read the parent channel topic (Discord API may be degraded). Please try again in a moment.";
  }
  return input.topicError;
}

export function normalizeWorkspacePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/\/+$/u, "").toLocaleLowerCase();
}
