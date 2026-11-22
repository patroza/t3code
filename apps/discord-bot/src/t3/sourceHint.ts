/**
 * Mirrors ClientSourceHint so the Discord overlay can stamp actors without importing the identity overlay.
 * The server maps platformId to a person; without a hint, bot sessions have no person chip.
 */
export type DiscordClientSourceHint = {
  readonly channel: "discord";
  readonly actor?: {
    readonly platformId?: string;
    readonly displayName?: string;
  };
  readonly location?: {
    readonly guildId?: string;
    readonly channelId?: string;
    readonly threadId?: string;
  };
};

export function discordSourceHint(input: {
  readonly authorId?: string | null | undefined;
  readonly authorUsername?: string | null | undefined;
  readonly guildId?: string | null | undefined;
  readonly channelId?: string | null | undefined;
  readonly discordThreadId?: string | null | undefined;
}): DiscordClientSourceHint {
  const platformId = input.authorId?.trim() ?? "";
  const displayName = input.authorUsername?.trim() ?? "";
  const guildId = input.guildId?.trim() ?? "";
  const channelId = input.channelId?.trim() ?? "";
  const threadId = input.discordThreadId?.trim() ?? "";

  return {
    channel: "discord",
    ...(platformId.length > 0 || displayName.length > 0
      ? {
          actor: {
            ...(platformId.length > 0 ? { platformId } : {}),
            ...(displayName.length > 0 ? { displayName } : {}),
          },
        }
      : {}),
    ...(guildId.length > 0 || channelId.length > 0 || threadId.length > 0
      ? {
          location: {
            ...(guildId.length > 0 ? { guildId } : {}),
            ...(channelId.length > 0 ? { channelId } : {}),
            ...(threadId.length > 0 ? { threadId } : {}),
          },
        }
      : {}),
  };
}
