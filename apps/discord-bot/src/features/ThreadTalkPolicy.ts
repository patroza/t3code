import type { ThreadLink } from "../store/ThreadLinkStore.ts";

export type ThreadTalkCommand =
  | { readonly kind: "set"; readonly enabled: boolean }
  | { readonly kind: "status" };

/** Discord `MessageType.REPLY`. People use these as quotes, not as addressing the bot. */
export const DISCORD_REPLY_MESSAGE_TYPE = 19;

export function parseThreadTalkCommand(raw: string): ThreadTalkCommand | null {
  const normalized = raw.trim().replace(/\s+/gu, " ").toLocaleLowerCase();
  if (normalized === "thread-talk on") return { kind: "set", enabled: true };
  if (normalized === "thread-talk off") return { kind: "set", enabled: false };
  if (normalized === "thread-talk status") return { kind: "status" };
  return null;
}

export function threadTalkEnabled(link: ThreadLink | null): boolean {
  return link?.threadTalkMode === "all-messages";
}

export function isDiscordReplyMessage(messageType: number | undefined): boolean {
  return messageType === DISCORD_REPLY_MESSAGE_TYPE;
}

export function mentionsBotInContent(content: string, botUserId: string): boolean {
  return content.includes(`<@${botUserId}>`) || content.includes(`<@!${botUserId}>`);
}

/**
 * True when the author addressed the bot, not merely reply-pinged it.
 * Discord puts the parent author in `mentions` for a reply ping without `<@id>` in content.
 */
export function discordEventMentionsBot(input: {
  readonly content: string;
  readonly mentions?: ReadonlyArray<{ readonly id?: string }> | null;
  readonly mentionRoleIds?: ReadonlyArray<string> | null;
  readonly botUserId: string;
  readonly botRoleId?: string | null;
  readonly messageType?: number | undefined;
}): boolean {
  if (mentionsBotInContent(input.content, input.botUserId)) return true;
  if (
    input.botRoleId !== null &&
    input.botRoleId !== undefined &&
    (input.mentionRoleIds ?? []).includes(input.botRoleId)
  ) {
    return true;
  }
  if (isDiscordReplyMessage(input.messageType)) return false;
  if (input.content.includes(input.botUserId)) return true;
  return input.mentions?.some((user) => user.id === input.botUserId) ?? false;
}

/** Thread-talk never consumes replies; those are quotes unless they @mention the bot. */
export function shouldAcceptThreadTalkMessage(input: {
  readonly mentioned: boolean;
  readonly threadTalkEnabled: boolean;
  readonly messageType?: number | undefined;
}): boolean {
  return !input.mentioned && input.threadTalkEnabled && !isDiscordReplyMessage(input.messageType);
}

export function formatUnmentionedDiscordPrompt(input: {
  readonly content: string;
  readonly authorId: string;
  readonly authorName: string;
  readonly messageId: string;
}): string {
  return [
    `Discord message from ${input.authorName} (user ${input.authorId}, message ${input.messageId}):`,
    "",
    input.content,
  ].join("\n");
}
