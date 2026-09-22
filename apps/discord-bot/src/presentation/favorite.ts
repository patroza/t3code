/**
 * `/favorite` copies the current Discord thread link to the invoker's rambling channel.
 *
 * Destination resolution:
 * 1. `channel:` option on this invocation (also persisted)
 * 2. last channel saved via `/favorite channel:`
 * 3. `ramblingChannelId` on the identity-map person
 */
export const FAVORITE_MISSING_DESTINATION_MESSAGE =
  "Set your rambling channel first: `/favorite channel:#your-channel`. Then `/favorite` in a thread copies the thread link there.";

export const FAVORITE_NOT_IN_THREAD_MESSAGE =
  "Run `/favorite` inside a Discord thread to send that thread's link to your rambling channel.";

const DISCORD_SNOWFLAKE = /^\d{1,32}$/u;
const CHANNEL_MENTION = /^<#(\d{1,32})>$/u;
const CHANNEL_URL =
  /^https?:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/channels\/(?:\d+|@me)\/(\d{1,32})(?:\/\d+)?\/?$/iu;

/** Extract a Discord channel/thread snowflake from a slash value, mention, or jump URL. */
export function parseDiscordChannelId(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (DISCORD_SNOWFLAKE.test(trimmed)) return trimmed;
  const mention = CHANNEL_MENTION.exec(trimmed);
  if (mention?.[1] !== undefined) return mention[1];
  const url = CHANNEL_URL.exec(trimmed);
  if (url?.[1] !== undefined) return url[1];
  return null;
}

export function discordThreadJumpUrl(guildId: string | null | undefined, threadId: string): string {
  return `https://discord.com/channels/${guildId ?? "@me"}/${threadId}`;
}

export function formatFavoritePost(input: {
  readonly guildId: string | null | undefined;
  readonly threadId: string;
  readonly threadName?: string | null | undefined;
}): string {
  const url = discordThreadJumpUrl(input.guildId, input.threadId);
  const title = input.threadName?.trim() ?? "";
  return title.length > 0 ? `${title}\n${url}` : url;
}

export type FavoriteDestination =
  | { readonly kind: "option" | "stored" | "identity"; readonly channelId: string }
  | { readonly kind: "missing" };

/**
 * Pick the rambling channel: slash option, then the saved override, then identity map.
 */
export function resolveFavoriteDestination(input: {
  readonly optionChannelId?: string | null | undefined;
  readonly storedChannelId?: string | null | undefined;
  readonly identityChannelId?: string | null | undefined;
}): FavoriteDestination {
  const option = parseDiscordChannelId(input.optionChannelId);
  if (option !== null) return { kind: "option", channelId: option };
  const stored = parseDiscordChannelId(input.storedChannelId);
  if (stored !== null) return { kind: "stored", channelId: stored };
  const identity = parseDiscordChannelId(input.identityChannelId);
  if (identity !== null) return { kind: "identity", channelId: identity };
  return { kind: "missing" };
}

export function formatFavoriteAck(input: {
  readonly destinationChannelId: string;
  readonly saved: boolean;
  readonly posted: boolean;
}): string {
  const dest = `<#${input.destinationChannelId}>`;
  if (input.saved && input.posted) {
    return `Saved ${dest} as your rambling channel and sent this thread there.`;
  }
  if (input.saved) {
    return `Saved ${dest} as your rambling channel. Run \`/favorite\` inside a thread to send a link.`;
  }
  return `Sent to ${dest}`;
}

export function formatFavoritePostError(destinationChannelId: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `Couldn't post to <#${destinationChannelId}>. Give Omegent Send Messages there. (${detail})`;
}
