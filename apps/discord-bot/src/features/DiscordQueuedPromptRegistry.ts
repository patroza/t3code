import type { MessageId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/**
 * Tracks Discord user messages that are parked in the server follow-up queue so
 * we can badge them (📥), remove the badge once that run leaves the queue, and
 * remove on delete. Parked prompts start when the active turn finishes.
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

/** One shared in-memory registry for the mention router and the live bridge. */
export class DiscordQueuedPrompts extends Context.Service<
  DiscordQueuedPrompts,
  DiscordQueuedPromptRegistry
>()("@t3tools/discord-bot/features/DiscordQueuedPromptRegistry/DiscordQueuedPrompts") {}

export const discordQueuedPromptsLayer = Layer.effect(
  DiscordQueuedPrompts,
  Effect.sync(createDiscordQueuedPromptRegistry),
);

/**
 * 📥 means the Discord message is still parked. Drop it once every run for
 * that message has left `queued` (started, finished, failed, or cancelled).
 * No run in the snapshot yet means the queue row may not have landed — keep
 * the badge. Any remaining `queued` run keeps it too.
 */
export function queuedPromptsThatStartedProcessing<
  T extends { readonly t3MessageId: string },
>(input: {
  readonly pending: ReadonlyArray<T>;
  readonly runStatuses: ReadonlyArray<{
    readonly status: string;
    readonly userMessageId: string;
  }>;
}): ReadonlyArray<T> {
  const statusesByMessage = new Map<string, Array<string>>();
  for (const run of input.runStatuses) {
    const key = String(run.userMessageId);
    const statuses = statusesByMessage.get(key);
    if (statuses === undefined) statusesByMessage.set(key, [run.status]);
    else statuses.push(run.status);
  }
  return input.pending.filter((entry) => {
    const statuses = statusesByMessage.get(String(entry.t3MessageId));
    if (statuses === undefined || statuses.length === 0) return false;
    return statuses.every((status) => status !== "queued");
  });
}

/** Discord already removed the reaction or the message, so retrying will not help. */
export function isDiscordReactionAlreadyGone(error: unknown): boolean {
  if (discordErrorStatus(error) === 404) return true;
  const text = discordErrorText(error);
  return (
    text.includes("Unknown Emoji") ||
    text.includes("Unknown Message") ||
    text.includes("10008") ||
    text.includes("10014")
  );
}

/**
 * Remove 📥 for prompts whose runs have left the queue.
 * Forgets the registry entry only after Discord accepts the delete, or when
 * the reaction is already gone. A failed delete stays registered so the next
 * snapshot can retry.
 */
export function clearQueuedPromptBadges<E, R>(input: {
  readonly registry: DiscordQueuedPromptRegistry;
  readonly entries: ReadonlyArray<PendingQueuedPrompt>;
  readonly deleteReaction: (entry: PendingQueuedPrompt) => Effect.Effect<void, E, R>;
  readonly onSettled?: (entry: PendingQueuedPrompt) => void;
}): Effect.Effect<void, never, R> {
  return Effect.forEach(
    input.entries,
    (entry) =>
      input.deleteReaction(entry).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            input.registry.forgetT3Message(entry.t3ThreadId, entry.t3MessageId);
          }),
        ),
        Effect.catch((error) => {
          if (isDiscordReactionAlreadyGone(error)) {
            input.registry.forgetT3Message(entry.t3ThreadId, entry.t3MessageId);
            return Effect.void;
          }
          return Effect.logWarning("Failed to clear queued badge after the message started", {
            discordMessageId: entry.discordMessageId,
            t3MessageId: entry.t3MessageId,
            error: String(error),
          });
        }),
        Effect.ensuring(
          Effect.sync(() => {
            input.onSettled?.(entry);
          }),
        ),
      ),
    { concurrency: 4 },
  ).pipe(Effect.asVoid);
}

function discordErrorStatus(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  const record = error as Record<string, unknown>;
  const direct = statusOf(record.response) ?? statusOf(record.reason);
  if (direct !== null) return direct;
  if (typeof record.reason === "object" && record.reason !== null) {
    return statusOf((record.reason as Record<string, unknown>).response);
  }
  return null;
}

function statusOf(value: unknown): number | null {
  if (typeof value !== "object" || value === null) return null;
  const status = (value as Record<string, unknown>).status;
  return typeof status === "number" ? status : null;
}

function discordErrorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null) {
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
}
