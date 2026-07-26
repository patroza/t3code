import type { MessageId, ThreadId } from "@t3tools/contracts";

/**
 * Tracks Discord user messages that are parked in the server follow-up queue so
 * we can badge them (📥), remove on delete, and flush via /omegent steernow.
 *
 * In-memory only: process restart drops badges (server queue remains authoritative).
 */
export type PendingQueuedPrompt = {
  readonly discordChannelId: string;
  readonly discordMessageId: string;
  readonly t3ThreadId: ThreadId;
  readonly t3MessageId: MessageId;
  readonly authorUserId: string | null;
};

/** Discord unicode used as the "queued" badge on the user's message. */
export const QUEUED_PROMPT_REACTION_EMOJI = "📥";

export function createDiscordQueuedPromptRegistry() {
  const byDiscordMessageId = new Map<string, PendingQueuedPrompt>();
  const byT3ThreadId = new Map<string, Set<string>>();

  const remember = (entry: PendingQueuedPrompt): void => {
    byDiscordMessageId.set(entry.discordMessageId, entry);
    const key = String(entry.t3ThreadId);
    const set = byT3ThreadId.get(key) ?? new Set<string>();
    set.add(entry.discordMessageId);
    byT3ThreadId.set(key, set);
  };

  const forgetDiscordMessage = (discordMessageId: string): PendingQueuedPrompt | null => {
    const entry = byDiscordMessageId.get(discordMessageId);
    if (entry === undefined) return null;
    byDiscordMessageId.delete(discordMessageId);
    const key = String(entry.t3ThreadId);
    const set = byT3ThreadId.get(key);
    if (set !== undefined) {
      set.delete(discordMessageId);
      if (set.size === 0) byT3ThreadId.delete(key);
    }
    return entry;
  };

  const forgetT3Message = (
    t3ThreadId: ThreadId,
    t3MessageId: MessageId,
  ): PendingQueuedPrompt | null => {
    const key = String(t3ThreadId);
    const set = byT3ThreadId.get(key);
    if (set === undefined) return null;
    for (const discordMessageId of set) {
      const entry = byDiscordMessageId.get(discordMessageId);
      if (entry !== undefined && entry.t3MessageId === t3MessageId) {
        return forgetDiscordMessage(discordMessageId);
      }
    }
    return null;
  };

  const listForThread = (t3ThreadId: ThreadId): ReadonlyArray<PendingQueuedPrompt> => {
    const set = byT3ThreadId.get(String(t3ThreadId));
    if (set === undefined) return [];
    const out: PendingQueuedPrompt[] = [];
    for (const discordMessageId of set) {
      const entry = byDiscordMessageId.get(discordMessageId);
      if (entry !== undefined) out.push(entry);
    }
    return out;
  };

  const getByDiscordMessageId = (discordMessageId: string): PendingQueuedPrompt | null =>
    byDiscordMessageId.get(discordMessageId) ?? null;

  const clearThread = (t3ThreadId: ThreadId): ReadonlyArray<PendingQueuedPrompt> => {
    const listed = listForThread(t3ThreadId);
    for (const entry of listed) {
      forgetDiscordMessage(entry.discordMessageId);
    }
    return listed;
  };

  return {
    remember,
    forgetDiscordMessage,
    forgetT3Message,
    listForThread,
    getByDiscordMessageId,
    clearThread,
  };
}

export type DiscordQueuedPromptRegistry = ReturnType<typeof createDiscordQueuedPromptRegistry>;
