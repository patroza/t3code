/**
 * `/export` transcript. Speakers are only `user-1`, `bot-1`, or `omegent`.
 * Usernames, display names, user ids, and mention tokens are rewritten to
 * those labels.
 */

export const EXPORT_SLASH_COMMAND_NAME = "export" as const;
export const EXPORT_SUBCOMMAND = "export" as const;
/** Discord returns at most this many messages per history request. */
export const EXPORT_HISTORY_PAGE_SIZE = 100;
/**
 * Safety stop for a channel with a huge history. A normal thread finishes
 * before this, and the transcript says when older messages were left out.
 */
export const EXPORT_HISTORY_CAP = 500;
export const EXPORT_MARKDOWN_NAME = "export.md";
export const EXPORT_MESSAGE_LIMIT = 2000;

export type ParsedExportCount =
  | { readonly scope: "all" }
  | { readonly scope: "latest"; readonly count: number };

export interface ExportHistoryCursor {
  readonly limit: number;
  readonly before?: string;
}

export interface ExportParticipant {
  readonly id: string;
  readonly username?: string | null;
  readonly displayName?: string | null;
  readonly bot?: boolean | null;
}

export interface ExportSourceMessage {
  readonly id: string;
  readonly content: string;
  readonly timestamp: string;
  readonly author: ExportParticipant;
  readonly mentions?: ReadonlyArray<ExportParticipant>;
  readonly attachmentNames?: ReadonlyArray<string>;
  readonly stickerNames?: ReadonlyArray<string>;
  readonly replyTo?: ExportParticipant | null;
}

/** Structural slice of a Discord message. Extra REST fields are ignored. */
export interface DiscordExportMessage {
  readonly id: string;
  readonly content: string;
  readonly timestamp: string;
  readonly author: {
    readonly id: string;
    readonly username?: string | null | undefined;
    readonly global_name?: string | null | undefined;
    readonly bot?: boolean | null | undefined;
  };
  readonly mentions?: ReadonlyArray<DiscordExportMessage["author"]> | null | undefined;
  readonly attachments?:
    | ReadonlyArray<{ readonly filename?: string | null | undefined }>
    | null
    | undefined;
  readonly embeds?:
    | ReadonlyArray<{
        readonly title?: string | null | undefined;
        readonly description?: string | null | undefined;
      }>
    | null
    | undefined;
  readonly sticker_items?:
    | ReadonlyArray<{ readonly name?: string | null | undefined }>
    | null
    | undefined;
  readonly referenced_message?:
    | {
        readonly author?: DiscordExportMessage["author"] | null | undefined;
      }
    | null
    | undefined;
}

interface AssignedParticipant {
  readonly id: string;
  readonly label: string;
  readonly publicName: string | null;
  readonly username: string | null;
}

/** Omitted count copies the whole chat. A number keeps that many latest messages. */
export function parseExportCount(raw: unknown): ParsedExportCount | null {
  if (raw === undefined || raw === null || raw === "") return { scope: "all" };
  const value =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && raw.trim() !== ""
        ? Number(raw.trim())
        : Number.NaN;
  if (!Number.isInteger(value) || value < 1 || value > EXPORT_HISTORY_CAP) return null;
  return { scope: "latest", count: value };
}

export function exportHistoryTarget(parsed: ParsedExportCount): number {
  return parsed.scope === "all" ? EXPORT_HISTORY_CAP : parsed.count;
}

export function initialExportHistoryCursor(target: number): ExportHistoryCursor {
  return { limit: Math.min(EXPORT_HISTORY_PAGE_SIZE, Math.max(target, 0)) };
}

/**
 * Discord history pages are newest-first. A short page is the end of the chat.
 * A full page at the target needs one newer probe before calling the export truncated.
 */
export function nextExportHistoryCursor(input: {
  readonly target: number;
  readonly collected: number;
  readonly pageCount: number;
  readonly pageLimit: number;
  readonly oldestId: string | undefined;
}): ExportHistoryCursor | "end" | "maybe-truncated" {
  if (input.pageCount < input.pageLimit || input.oldestId === undefined) return "end";
  if (input.collected >= input.target) return "maybe-truncated";
  return {
    limit: Math.min(EXPORT_HISTORY_PAGE_SIZE, input.target - input.collected),
    before: input.oldestId,
  };
}

export function discordMessageToExportSource(message: DiscordExportMessage): ExportSourceMessage {
  const embedText = (message.embeds ?? []).flatMap((embed) =>
    [embed.title, embed.description].filter(
      (part): part is string => typeof part === "string" && part.trim() !== "",
    ),
  );
  const content = [message.content, ...embedText].filter((part) => part.trim() !== "").join("\n\n");
  const replyAuthor = message.referenced_message?.author;
  return {
    id: message.id,
    content,
    timestamp: message.timestamp,
    author: participantFromDiscord(message.author),
    mentions: (message.mentions ?? []).map(participantFromDiscord),
    attachmentNames: (message.attachments ?? []).flatMap((attachment) => {
      const filename = attachment.filename?.trim() ?? "";
      return filename === "" ? [] : [filename];
    }),
    stickerNames: (message.sticker_items ?? []).flatMap((sticker) => {
      const name = sticker.name?.trim() ?? "";
      return name === "" ? [] : [name];
    }),
    replyTo:
      replyAuthor?.id !== undefined && replyAuthor.id !== ""
        ? participantFromDiscord(replyAuthor)
        : null,
  };
}

export function renderThreadExport(input: {
  readonly messages: ReadonlyArray<DiscordExportMessage>;
  readonly botUserId: string;
  readonly truncated?: boolean;
}): string {
  const messages = [...input.messages]
    .map(discordMessageToExportSource)
    .sort((left, right) => compareSnowflake(left.id, right.id));
  if (messages.length === 0) {
    return ["# Chat export", "", "No messages to export.", ""].join("\n");
  }

  const assigned = assignParticipants(messages, input.botUserId);
  const byId = new Map(assigned.map((entry) => [entry.id, entry]));
  const redact = makeRedactor(assigned);
  const participants = assigned.map((entry) => entry.label).join(", ");
  const blocks = messages.map((message) => renderMessage(message, byId, redact));
  const countLabel = messages.length === 1 ? "1 message" : `${messages.length} messages`;
  const privacy = "Discord usernames, display names, and user ids are omitted.";
  const summary =
    input.truncated === true
      ? `Latest ${countLabel}. Older messages were left out. ${privacy}`
      : `${countLabel}. ${privacy}`;

  return [
    "# Chat export",
    "",
    summary,
    `Participants: ${participants}`,
    "",
    blocks.join("\n\n"),
    "",
  ].join("\n");
}

/** Ephemeral reply body. The file always carries the full transcript. */
export function exportInteractionContent(markdown: string): string {
  if (markdown.length <= EXPORT_MESSAGE_LIMIT) return markdown;
  return `Transcript is longer than Discord's message limit. Copy the attached ${EXPORT_MARKDOWN_NAME}.`;
}

function participantFromDiscord(author: DiscordExportMessage["author"]): ExportParticipant {
  return {
    id: author.id,
    username: author.username ?? null,
    displayName: author.global_name ?? null,
    bot: author.bot ?? null,
  };
}

function assignParticipants(
  messages: ReadonlyArray<ExportSourceMessage>,
  botUserId: string,
): ReadonlyArray<AssignedParticipant> {
  const assigned = new Map<string, AssignedParticipant>();
  let users = 0;
  let bots = 0;

  const visit = (participant: ExportParticipant | null | undefined) => {
    if (participant === null || participant === undefined || participant.id === "") return;
    const existing = assigned.get(participant.id);
    if (existing !== undefined) {
      assigned.set(participant.id, mergeParticipant(existing, participant, botUserId));
      return;
    }
    const omegent = isOmegent(participant, botUserId);
    const label = omegent
      ? "omegent"
      : participant.bot === true
        ? `bot-${++bots}`
        : `user-${++users}`;
    assigned.set(participant.id, {
      id: participant.id,
      label,
      publicName: omegent ? null : publicDisplayName(participant),
      username: cleanHandle(participant.username),
    });
  };

  for (const message of messages) {
    visit(message.author);
    visit(message.replyTo);
    for (const mention of message.mentions ?? []) visit(mention);
  }

  return [...assigned.values()];
}

function mergeParticipant(
  existing: AssignedParticipant,
  participant: ExportParticipant,
  botUserId: string,
): AssignedParticipant {
  if (isOmegent(participant, botUserId) || existing.label === "omegent") {
    return { ...existing, label: "omegent", publicName: null };
  }
  return {
    ...existing,
    publicName: existing.publicName ?? publicDisplayName(participant),
    username: existing.username ?? cleanHandle(participant.username),
  };
}

function isOmegent(participant: ExportParticipant, botUserId: string): boolean {
  if (participant.id === botUserId) return true;
  if (participant.bot !== true) return false;
  const username = participant.username?.trim() ?? "";
  const displayName = participant.displayName?.trim() ?? "";
  return /^omegent$/i.test(username) || /^omegent$/i.test(displayName);
}

function publicDisplayName(participant: ExportParticipant): string | null {
  const name = participant.displayName?.trim() ?? "";
  if (name === "" || /^\d{17,20}$/.test(name)) return null;
  const handle = participant.username?.trim().toLowerCase() ?? "";
  if (handle !== "" && name.toLowerCase().includes(handle)) return null;
  return name;
}

function cleanHandle(username: string | null | undefined): string | null {
  const handle = username?.trim() ?? "";
  return handle === "" ? null : handle;
}

function renderMessage(
  message: ExportSourceMessage,
  byId: ReadonlyMap<string, AssignedParticipant>,
  redact: (text: string) => string,
): string {
  const author = byId.get(message.author.id);
  const speaker = author === undefined ? "user" : author.label;
  const when = formatTimestamp(message.timestamp);
  const reply = message.replyTo?.id ? byId.get(message.replyTo.id) : undefined;
  const replyNote = reply === undefined ? "" : ` (reply to ${reply.label})`;
  const heading = when === null ? `${speaker}${replyNote}` : `${speaker}, ${when}${replyNote}`;
  return `${heading}\n${composeBody(message, redact)}`;
}

function composeBody(message: ExportSourceMessage, redact: (text: string) => string): string {
  const parts: string[] = [];
  if (message.content.trim() !== "") parts.push(redact(message.content).trim());
  for (const name of message.attachmentNames ?? []) {
    const safe = redact(name).trim();
    if (safe !== "") parts.push(`[file: ${safe}]`);
  }
  for (const name of message.stickerNames ?? []) {
    const safe = redact(name).trim();
    if (safe !== "") parts.push(`[sticker: ${safe}]`);
  }
  return parts.length === 0 ? "[no text]" : parts.join("\n");
}

function makeRedactor(assigned: ReadonlyArray<AssignedParticipant>): (text: string) => string {
  const byId = new Map(assigned.map((entry) => [entry.id, entry.label]));
  const handles = assigned.flatMap((entry) =>
    entry.username === null ? [] : [{ username: entry.username, label: entry.label }],
  );
  handles.sort((left, right) => right.username.length - left.username.length);

  return (text: string) => {
    let next = text;
    next = next.replace(/<@!?(\d+)>/g, (_match, id: string) => byId.get(id) ?? "user");
    next = next.replace(/<@&\d+>/g, "role");
    next = next.replace(/<#\d+>/g, "channel");
    next = next.replace(/<a?:([A-Za-z0-9_]+):\d+>/g, ":$1:");
    next = next.replace(
      /https?:\/\/(?:discord(?:app)?\.com)\/users\/(\d+)/gi,
      (_match, id: string) => byId.get(id) ?? "user",
    );
    next = next.replace(/@(everyone|here)\b/gi, "$1");
    for (const handle of handles) {
      const escaped = escapeRegExp(handle.username);
      next = next.replace(
        new RegExp(`(?<![A-Za-z0-9_.])@${escaped}(?![A-Za-z0-9_.])`, "gi"),
        handle.label,
      );
      if (shouldRedactBareUsername(handle.username)) {
        next = next.replace(
          new RegExp(`(?<![A-Za-z0-9_.])${escaped}(?![A-Za-z0-9_.])`, "gi"),
          handle.label,
        );
      }
    }
    const displayNames = assigned.flatMap((entry) => {
      const name = entry.publicName;
      if (name === null || name.length < 3) return [];
      return [{ name, label: entry.label }];
    });
    displayNames.sort((left, right) => right.name.length - left.name.length);
    for (const displayName of displayNames) {
      const escaped = escapeRegExp(displayName.name);
      next = next.replace(
        new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, "gi"),
        displayName.label,
      );
    }
    next = next.replace(/\b\d{17,20}\b/g, (id) => byId.get(id) ?? id);
    return next;
  };
}

function shouldRedactBareUsername(username: string): boolean {
  return username.length >= 6 || /[0-9._]/.test(username);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatTimestamp(timestamp: string): string | null {
  const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})/.exec(timestamp.trim());
  if (match === null) return null;
  return `${match[1]} ${match[2]}:${match[3]} UTC`;
}

function compareSnowflake(left: string, right: string): number {
  if (left.length !== right.length) return left.length - right.length;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
