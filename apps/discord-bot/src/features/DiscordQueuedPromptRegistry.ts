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

/**
 * Resolve which message ids `/omegent steernow` should inject.
 *
 * Prefer the server queue (authoritative after restart). Fall back to the
 * in-memory Discord registry when the HTTP snapshot is missing/lagging so a
 * just-queued mid-turn follow-up is still steerable.
 */
export function resolveSteernowMessageIds(input: {
  readonly serverQueued: ReadonlyArray<{ readonly messageId: MessageId }>;
  readonly localPending: ReadonlyArray<{ readonly t3MessageId: MessageId }>;
  /** True when `fetchThreadDetail` returned a snapshot (even if queue empty). */
  readonly detailLoaded: boolean;
}): {
  readonly messageIds: ReadonlyArray<MessageId>;
  readonly source: "server" | "local" | "empty";
  readonly snapshotMissing: boolean;
} {
  if (input.serverQueued.length > 0) {
    // Dedupe while preserving server order.
    const seen = new Set<string>();
    const messageIds: MessageId[] = [];
    for (const entry of input.serverQueued) {
      const key = String(entry.messageId);
      if (seen.has(key)) continue;
      seen.add(key);
      messageIds.push(entry.messageId);
    }
    return { messageIds, source: "server", snapshotMissing: false };
  }

  if (input.localPending.length > 0) {
    const seen = new Set<string>();
    const messageIds: MessageId[] = [];
    for (const entry of input.localPending) {
      const key = String(entry.t3MessageId);
      if (seen.has(key)) continue;
      seen.add(key);
      messageIds.push(entry.t3MessageId);
    }
    return {
      messageIds,
      source: "local",
      snapshotMissing: !input.detailLoaded,
    };
  }

  return {
    messageIds: [],
    source: "empty",
    snapshotMissing: !input.detailLoaded,
  };
}

/** User-facing reply when steernow has nothing to inject. */
export function formatSteernowEmptyQueueMessage(input: {
  readonly snapshotMissing: boolean;
}): string {
  if (input.snapshotMissing) {
    return [
      "Could not load the server queue (thread snapshot unavailable), and nothing is parked in this bot process.",
      "Use `/agent steer prompt:…` (or `@Omegent --steer …`) to inject mid-turn, then try `/agent steernow` again if you park follow-ups.",
    ].join(" ");
  }
  return [
    "Nothing is queued on this thread.",
    "Mid-turn follow-ups park with 📥 by default — then `/agent steernow` flushes them.",
    "To inject immediately, use `/agent steer prompt:…` or `@Omegent --steer …`.",
  ].join(" ");
}

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
