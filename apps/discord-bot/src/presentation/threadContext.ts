// @effect-diagnostics nodeBuiltinImport:off
/**
 * Build initial T3 prompts when the bot is first pulled into a Discord thread.
 * Combines the thread starter (e.g. Sentry alert embed) with the user @mention.
 *
 * Static Discord policy lives in `apps/discord-bot/docs/agent-turn-rules.md`.
 * Per-turn prompts only inject dynamic data plus an absolute path to that doc.
 */

import * as NodePath from "node:path";
import { fileURLToPath } from "node:url";

import {
  formatIdentityAttributionBlock,
  resolveParticipantIdentity,
  type PersonIdentity,
  type ResolvedParticipantIdentity,
} from "../identityMap.ts";
import {
  buildDiscordThreadJumpUrl,
  formatDiscordPrAttributionFooter,
  starterDisplayName,
  starterUserId,
} from "./discordPrAttribution.ts";
import { jiraBrowseUrl, mergeJiraIssueKeys } from "./jiraLinks.ts";

/** Absolute path to the static Discord agent policy document. */
export function resolveAgentTurnRulesPath(): string {
  // presentation/ → src/ → package root → docs/agent-turn-rules.md
  const presentationDir = NodePath.dirname(fileURLToPath(import.meta.url));
  return NodePath.resolve(presentationDir, "../../docs/agent-turn-rules.md");
}

export interface DiscordEmbedLike {
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly url?: string | undefined;
  readonly timestamp?: string | undefined;
  readonly author?: { readonly name?: string | undefined } | undefined;
  readonly footer?: { readonly text?: string | undefined } | undefined;
  readonly fields?:
    | ReadonlyArray<{
        readonly name: string;
        readonly value: string;
      }>
    | undefined;
}

export interface DiscordMessageLike {
  readonly id: string;
  readonly content?: string | null | undefined;
  readonly author?:
    | {
        readonly id?: string | undefined;
        readonly username?: string | undefined;
        readonly displayName?: string | undefined;
        readonly bot?: boolean | undefined;
      }
    | undefined;
  readonly embeds?: ReadonlyArray<DiscordEmbedLike> | undefined;
  readonly timestamp?: string | undefined;
  /** Channel that holds the message (for jump links). */
  readonly channelId?: string | undefined;
}

export interface ThreadBootstrapContext {
  readonly starter: DiscordMessageLike | null;
  readonly mentionMessage?: DiscordMessageLike | undefined;
  /**
   * Message the user replied to / referenced when addressing the bot.
   * Prefer this over inventing context from screenshots or partial text.
   */
  readonly referencedMessage?: DiscordMessageLike | null | undefined;
  /** Jump link for the referenced message when known. */
  readonly referencedMessageUrl?: string | undefined;
  readonly mentionPrompt: string;
  readonly projectShortName: string;
  readonly workspaceRoot: string;
  /** Optional template: use {traceId}, {environment}, {dataset} */
  readonly honeycombTraceUrlTemplate: string | undefined;
  /**
   * Durable Jira issue keys for this Discord thread (first-seen order).
   * Re-injected every turn so later PR/work turns still see earlier ticket links.
   */
  readonly jiraIssueKeys?: ReadonlyArray<string> | undefined;
  /** Browse base for turning keys into links (e.g. https://org.atlassian.net). */
  readonly jiraBrowseBaseUrl?: string | undefined;
  /**
   * Operator identity map (Discord → GitHub/Jira). Used to inject Co-authored-by
   * guidance for the thread starter and current requester.
   */
  readonly identityPeople?: ReadonlyArray<PersonIdentity> | undefined;
  /** Guild snowflake — required to build a real Discord thread jump URL for PR footers. */
  readonly guildId?: string | null | undefined;
  /** Discord thread (or channel) snowflake for the PR footer jump link. */
  readonly discordThreadId?: string | null | undefined;
  /** Discord thread title (channel name) for the PR footer label. */
  readonly discordThreadTitle?: string | null | undefined;
}

function formatDiscordStaticRulesPointer(rulesPath: string): string {
  return `## Discord conversation context
Static policy (reply style, audience, PR/commit attribution, Sentry bootstrap): read \`${rulesPath}\` when committing, opening PRs, or when unsure. Be concise in Discord replies. This message carries only turn-specific data.`;
}

function formatRequesterMetadata(message: DiscordMessageLike | undefined): string {
  return JSON.stringify(
    {
      id: message?.author?.id ?? null,
      username: message?.author?.username ?? null,
      displayName: message?.author?.displayName ?? message?.author?.username ?? null,
    },
    null,
    2,
  );
}

/**
 * Format a referenced (reply-to) Discord message for agent context.
 * Includes embeds (e.g. Sentry alert fields) and optional jump link.
 */
export function formatReferencedMessageBlock(input: {
  readonly message: DiscordMessageLike;
  readonly url?: string | undefined;
}): string {
  const parts = ["## Referenced Discord message", formatDiscordMessage(input.message)];
  if (input.url !== undefined && input.url.trim() !== "") {
    parts.push(`Jump link: ${input.url.trim()}`);
  }
  return parts.join("\n");
}

/**
 * Durable per-thread Jira context for agent turns.
 * Omitted when no keys are known so ordinary prompts stay compact.
 */
export function formatLinkedJiraWorkItemsBlock(input: {
  readonly jiraIssueKeys?: ReadonlyArray<string> | undefined;
  readonly jiraBrowseBaseUrl?: string | undefined;
}): string | null {
  const ordered = mergeJiraIssueKeys([], input.jiraIssueKeys);
  if (ordered.length === 0) return null;

  const lines = ordered.map((key) => {
    const url = jiraBrowseUrl(input.jiraBrowseBaseUrl, key);
    return url === null ? `- \`${key}\`` : `- [${key}](${url})`;
  });

  return `### Linked work items (from this Discord thread)
${lines.join("\n")}`;
}

/**
 * Resolve starter + requester against the identity map for prompt injection.
 * Order: thread starter first, then requester (when distinct Discord ids).
 */
export function resolveTurnIdentityParticipants(input: {
  readonly people?: ReadonlyArray<PersonIdentity> | undefined;
  readonly starter?: DiscordMessageLike | null | undefined;
  readonly requester?: DiscordMessageLike | undefined;
}): ReadonlyArray<ResolvedParticipantIdentity> {
  const people = input.people ?? [];
  const out: ResolvedParticipantIdentity[] = [];

  const starterAuthor = input.starter?.author;
  if (starterAuthor !== undefined && starterAuthor.bot !== true) {
    out.push(
      resolveParticipantIdentity({
        role: "thread_starter",
        discordId: starterAuthor.id,
        discordUsername: starterAuthor.username,
        discordDisplayName: starterAuthor.displayName ?? starterAuthor.username,
        people,
      }),
    );
  }

  const requesterAuthor = input.requester?.author;
  if (requesterAuthor !== undefined) {
    // Always list requester role even when same person as starter so the agent
    // sees both roles; trailer dedupe happens in formatIdentityAttributionBlock.
    out.push(
      resolveParticipantIdentity({
        role: "requester",
        discordId: requesterAuthor.id,
        discordUsername: requesterAuthor.username,
        discordDisplayName: requesterAuthor.displayName ?? requesterAuthor.username,
        people,
      }),
    );
  }

  return out;
}

/**
 * Ready-to-paste Discord PR footer for agents (profile + full thread jump URLs).
 * Returns null when starter user id is missing.
 */
export function formatDiscordPrFooterPromptBlock(input: {
  readonly starter?: DiscordMessageLike | null | undefined;
  readonly requester?: DiscordMessageLike | undefined;
  readonly guildId?: string | null | undefined;
  readonly discordThreadId?: string | null | undefined;
  readonly discordThreadTitle?: string | null | undefined;
}): string | null {
  const attributionPerson = input.starter ?? input.requester;
  const userId = starterUserId(attributionPerson ?? null);
  if (userId === null) return null;

  const guildId = input.guildId?.trim() ?? "";
  const threadId = input.discordThreadId?.trim() ?? "";
  const messageId =
    attributionPerson?.id?.trim() ||
    input.requester?.id?.trim() ||
    (threadId.length > 0 ? threadId : "");

  const jumpUrl =
    guildId.length > 0 && threadId.length > 0
      ? buildDiscordThreadJumpUrl({
          guildId,
          discordThreadId: threadId,
          messageId: messageId.length > 0 ? messageId : null,
        })
      : "";

  const footer = formatDiscordPrAttributionFooter({
    starterDisplayName: starterDisplayName(attributionPerson ?? null),
    starterUserId: userId,
    threadTitle: input.discordThreadTitle?.trim() || "Discord thread",
    threadJumpUrl: jumpUrl,
  });

  return `### Discord PR description footer
\`\`\`
${footer}
\`\`\``;
}

export function buildDiscordTurnPrompt(input: {
  readonly mentionPrompt: string;
  readonly requester?: DiscordMessageLike | undefined;
  readonly starter?: DiscordMessageLike | null | undefined;
  readonly referencedMessage?: DiscordMessageLike | null | undefined;
  readonly referencedMessageUrl?: string | undefined;
  readonly jiraIssueKeys?: ReadonlyArray<string> | undefined;
  readonly jiraBrowseBaseUrl?: string | undefined;
  readonly identityPeople?: ReadonlyArray<PersonIdentity> | undefined;
  readonly guildId?: string | null | undefined;
  readonly discordThreadId?: string | null | undefined;
  readonly discordThreadTitle?: string | null | undefined;
  /** Override static rules path (tests). Defaults to package docs path. */
  readonly agentTurnRulesPath?: string | undefined;
}): string {
  const rulesPath = input.agentTurnRulesPath ?? resolveAgentTurnRulesPath();

  const referencedBlock =
    input.referencedMessage !== null && input.referencedMessage !== undefined
      ? `\n\n${formatReferencedMessageBlock({
          message: input.referencedMessage,
          url: input.referencedMessageUrl,
        })}`
      : "";

  const jiraBlock = formatLinkedJiraWorkItemsBlock({
    jiraIssueKeys: input.jiraIssueKeys,
    jiraBrowseBaseUrl: input.jiraBrowseBaseUrl,
  });
  const jiraSection = jiraBlock !== null ? `\n\n${jiraBlock}` : "";

  const identityBlock = formatIdentityAttributionBlock({
    participants: resolveTurnIdentityParticipants({
      people: input.identityPeople,
      starter: input.starter,
      requester: input.requester,
    }),
  });
  // Only inject when the operator map is configured (non-empty). Empty map keeps prompts compact.
  const identitySection =
    input.identityPeople !== undefined && input.identityPeople.length > 0 && identityBlock !== null
      ? `\n\n${identityBlock}`
      : "";

  const prFooterBlock = formatDiscordPrFooterPromptBlock({
    starter: input.starter,
    requester: input.requester,
    guildId: input.guildId,
    discordThreadId: input.discordThreadId,
    discordThreadTitle: input.discordThreadTitle,
  });
  const prFooterSection = prFooterBlock !== null ? `\n\n${prFooterBlock}` : "";

  return `${formatDiscordStaticRulesPointer(rulesPath)}

### Current requester
\`\`\`json
${formatRequesterMetadata(input.requester)}
\`\`\`${jiraSection}${identitySection}${prFooterSection}

## User request
${input.mentionPrompt.trim()}${referencedBlock}`;
}

const SENTRY_ISSUE_ID = /\b([A-Z][A-Z0-9]+(?:-[A-Z0-9]+)+)\b/g;
const SENTRY_URL = /https?:\/\/[^\s)]*sentry\.io\/[^\s)]+/gi;
const TRACE_ID = /\b(?:trace[_-]?id|trace)\s*[:=]\s*([a-f0-9]{16,32})\b/i;
const HEX_TRACE = /\b([a-f0-9]{32})\b/i;

export function formatEmbed(embed: DiscordEmbedLike): string {
  const lines: string[] = [];
  if (embed.author?.name) lines.push(`Author: ${embed.author.name}`);
  if (embed.title) lines.push(`Title: ${embed.title}`);
  if (embed.description) lines.push(embed.description.trim());
  if (embed.url) lines.push(`URL: ${embed.url}`);
  if (embed.fields) {
    for (const field of embed.fields) {
      lines.push(`${field.name}: ${field.value}`);
    }
  }
  if (embed.footer?.text) lines.push(`Footer: ${embed.footer.text}`);
  if (embed.timestamp) lines.push(`Timestamp: ${embed.timestamp}`);
  return lines.join("\n");
}

export function formatDiscordMessage(message: DiscordMessageLike): string {
  const who =
    message.author?.username !== undefined
      ? `${message.author.username}${message.author.bot === true ? " [bot]" : ""}`
      : "unknown";
  const parts = [`From: ${who}`, `Message id: ${message.id}`];
  const content = (message.content ?? "").trim();
  if (content.length > 0) parts.push(content);
  if (message.embeds && message.embeds.length > 0) {
    parts.push("Embeds:");
    message.embeds.forEach((embed, index) => {
      parts.push(`--- embed ${index + 1} ---`, formatEmbed(embed));
    });
  }
  return parts.join("\n");
}

export function extractSentryHints(text: string): {
  readonly issueIds: ReadonlyArray<string>;
  readonly sentryUrls: ReadonlyArray<string>;
  readonly possibleTraceIds: ReadonlyArray<string>;
} {
  const issueIds = new Set<string>();
  for (const match of text.matchAll(SENTRY_ISSUE_ID)) {
    const id = match[1];
    if (id === undefined || !id.includes("-") || id.length < 8) continue;
    // Sentry short ids are typically PROJECT-CODE (letters + hyphens, sometimes digits).
    // Skip pure hex-ish tokens (trace/event ids).
    if (/^[a-f0-9-]+$/i.test(id) && !/[g-zG-Z]/.test(id)) continue;
    if (!/[A-Z]/.test(id)) continue;
    issueIds.add(id);
  }
  const sentryUrls = [...text.matchAll(SENTRY_URL)].map((m) => m[0]!);
  const possibleTraceIds: string[] = [];
  const labeled = TRACE_ID.exec(text);
  if (labeled?.[1]) possibleTraceIds.push(labeled[1]);
  const hex = HEX_TRACE.exec(text);
  if (hex?.[1] && !possibleTraceIds.includes(hex[1])) possibleTraceIds.push(hex[1]);
  return {
    issueIds: [...issueIds],
    sentryUrls: [...new Set(sentryUrls)],
    possibleTraceIds,
  };
}

function collectMessageText(message: DiscordMessageLike | null | undefined): string {
  if (message === null || message === undefined) return "";
  const parts: string[] = [message.content ?? "", message.author?.username ?? ""];
  for (const embed of message.embeds ?? []) {
    parts.push(formatEmbed(embed));
    if (embed.url) parts.push(embed.url);
  }
  return parts.join("\n");
}

/** True when starter/mention/referenced message clearly references Sentry (avoid burning tokens otherwise). */
export function looksLikeSentryContext(input: {
  readonly starter: DiscordMessageLike | null;
  readonly mentionPrompt: string;
  readonly referencedMessage?: DiscordMessageLike | null | undefined;
}): boolean {
  const parts: string[] = [
    input.mentionPrompt,
    collectMessageText(input.starter),
    collectMessageText(input.referencedMessage),
  ];
  const text = parts.join("\n");
  if (/sentry/i.test(text)) return true;
  if (/sentry\.io/i.test(text)) return true;
  const hints = extractSentryHints(text);
  return hints.sentryUrls.length > 0;
}

/**
 * Choose first-turn prompt:
 * - Sentry-like context → full investigation bootstrap (Sentry + Honeycomb instructions)
 * - Non-Sentry with a distinct starter and/or referenced message → short context + user request
 * - Otherwise → user request only (still includes referenced message when present)
 */
export function buildFirstTurnPrompt(input: ThreadBootstrapContext): string {
  if (looksLikeSentryContext(input)) {
    return buildSentryBootstrapPrompt(input);
  }

  const turnPrompt = buildDiscordTurnPrompt({
    mentionPrompt: input.mentionPrompt,
    requester: input.mentionMessage,
    starter: input.starter,
    referencedMessage: input.referencedMessage,
    referencedMessageUrl: input.referencedMessageUrl,
    jiraIssueKeys: input.jiraIssueKeys,
    jiraBrowseBaseUrl: input.jiraBrowseBaseUrl,
    identityPeople: input.identityPeople,
    guildId: input.guildId,
    discordThreadId: input.discordThreadId,
    discordThreadTitle: input.discordThreadTitle,
  });

  if (input.starter !== null) {
    const starterText = formatDiscordMessage(input.starter).trim();
    const mention = input.mentionPrompt.trim();
    // Avoid doubling the same text when the mention is the starter.
    if (starterText.length > 0 && !starterText.includes(mention)) {
      // Skip starter block when it is the same message the user referenced.
      const starterIsReferenced =
        input.referencedMessage !== null &&
        input.referencedMessage !== undefined &&
        input.referencedMessage.id === input.starter.id;
      if (!starterIsReferenced) {
        return `${turnPrompt}

## Discord thread starter
${starterText}
`;
      }
    }
  }

  return turnPrompt;
}

export function buildSentryBootstrapPrompt(input: ThreadBootstrapContext): string {
  const starterText =
    input.starter === null ? "(no starter message available)" : formatDiscordMessage(input.starter);
  const referencedText =
    input.referencedMessage === null || input.referencedMessage === undefined
      ? null
      : formatDiscordMessage(input.referencedMessage);
  const referencedIsDistinctStarter =
    referencedText !== null &&
    input.referencedMessage !== null &&
    input.referencedMessage !== undefined &&
    (input.starter === null || input.referencedMessage.id !== input.starter.id);

  const combinedForHints = [
    starterText,
    referencedText ?? "",
    input.mentionPrompt,
    input.starter?.embeds?.map(formatEmbed).join("\n") ?? "",
    input.referencedMessage?.embeds?.map(formatEmbed).join("\n") ?? "",
  ].join("\n");
  const hints = extractSentryHints(combinedForHints);

  const honeycombHelp =
    input.honeycombTraceUrlTemplate !== undefined && input.honeycombTraceUrlTemplate.trim() !== ""
      ? `When you have a trace id, build the Honeycomb URL from this template (substitute placeholders):
\`${input.honeycombTraceUrlTemplate}\`
Placeholders: {traceId}, {environment}, {dataset}, {team}`
      : `When you have a trace id, post a Honeycomb deep link using the team's usual Honeycomb UI
(environment/dataset from the alert if present). Prefer a direct trace URL if you know the team layout.`;

  const hintBlock = [
    hints.issueIds.length > 0
      ? `Detected Sentry-looking issue ids: ${hints.issueIds.join(", ")}`
      : null,
    hints.sentryUrls.length > 0
      ? `Detected Sentry URLs:\n${hints.sentryUrls.map((u) => `- ${u}`).join("\n")}`
      : null,
    hints.possibleTraceIds.length > 0
      ? `Possible trace ids already in the message: ${hints.possibleTraceIds.join(", ")}`
      : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");

  const primaryContextNote = referencedIsDistinctStarter
    ? "Prefer the **referenced Discord message** (what the user replied to) as the primary incident context when present; otherwise use the thread starter. The user's @mention is the request to act on that context."
    : "Treat the **original thread starter** as the primary incident context (a Sentry alert). The user's @mention is the request to act on that context.";

  const referencedSection =
    referencedIsDistinctStarter && referencedText !== null
      ? `
### Referenced Discord message (user reply target)
${referencedText}
${
  input.referencedMessageUrl !== undefined && input.referencedMessageUrl.trim() !== ""
    ? `Jump link: ${input.referencedMessageUrl.trim()}`
    : ""
}
`
      : "";

  return `## Discord investigation bootstrap

${buildDiscordTurnPrompt({
  mentionPrompt: input.mentionPrompt,
  requester: input.mentionMessage,
  starter: input.starter,
  // Referenced / starter bodies are rendered in dedicated bootstrap sections below.
  jiraIssueKeys: input.jiraIssueKeys,
  jiraBrowseBaseUrl: input.jiraBrowseBaseUrl,
  identityPeople: input.identityPeople,
  guildId: input.guildId,
  discordThreadId: input.discordThreadId,
  discordThreadTitle: input.discordThreadTitle,
})}

You were pulled into an existing Discord thread for project **${input.projectShortName}**
(\`${input.workspaceRoot}\`).

${primaryContextNote}
Follow Sentry investigation steps in the static rules doc (path above).
${referencedSection}
### Original Discord thread starter
${starterText}

### Detected hints (may be incomplete — verify with tools)
${hintBlock.length > 0 ? hintBlock : "(none auto-detected)"}

### Honeycomb
${honeycombHelp}
`;
}

/** @deprecated Use buildFirstTurnPrompt / buildSentryBootstrapPrompt */
export const buildThreadBootstrapPrompt = buildSentryBootstrapPrompt;
