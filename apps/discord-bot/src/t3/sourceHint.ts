/**
 * Platform provenance for bot-dispatched turn.start.
 *
 * Mirrors `@t3tools/contracts` ClientSourceHint so the Discord overlay can
 * stamp actors without depending on the identity overlay at compile time.
 * When fork/identity is composed, the server resolves platformId via the map
 * into personId/username (e.g. patroza@discord). Without a hint, bot sessions
 * fall back to bare `{ channel: "bot" }` — no person chip in the sidebar.
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

/** Attach sourceHint for servers that understand it (identity overlay). */
export function withTurnSourceHint<T extends { readonly type: "thread.turn.start" }>(
  command: T,
  sourceHint: DiscordClientSourceHint | undefined,
): T {
  if (sourceHint === undefined) return command;
  return { ...command, sourceHint } as T;
}
