import { chunkDiscordContent, stripWorkingIndicator } from "./messages.ts";

/** Live tail on the editable watch message. Frozen chunks omit it. */
export const WATCHING_INDICATOR = "_Watching.._";

const WATCHING_SUFFIX = `\n\n${WATCHING_INDICATOR}`;

export type BackgroundDigestWrite = {
  /** Discord content for this slot. Only the live slot includes the Watching line. */
  readonly text: string;
  readonly live: boolean;
};

export type BackgroundDigestPlan = {
  /** Body of the editable slot, without the Watching line. */
  readonly liveText: string;
  /**
   * Ordered writes. The first replaces the current live message when one exists.
   * Later writes are new messages. A non-live first write freezes the message
   * that ran out of room.
   */
  readonly writes: ReadonlyArray<BackgroundDigestWrite>;
};

export type WatchDigestMessage = {
  readonly role: string;
  readonly turnId?: string | null | undefined;
  readonly text?: string | undefined;
  readonly notification?:
    | {
        readonly source?: { readonly kind?: string | undefined } | null | undefined;
        readonly summary?: string | null | undefined;
      }
    | null
    | undefined;
};

export function renderWatchingDigest(body: string): string {
  const trimmed = body.trim();
  if (trimmed === "") return WATCHING_INDICATOR;
  return `${trimmed}${WATCHING_SUFFIX}`;
}

/**
 * Append one watch update to the live Discord message.
 * When the update does not fit under Discord's limit together with the Watching
 * line, the current message is frozen and the update continues in a new one.
 */
export function planBackgroundDigestAppend(input: {
  readonly liveText: string;
  readonly update: string;
  readonly limit: number;
}): BackgroundDigestPlan {
  const update = stripWorkingIndicator(input.update).trim();
  const prior = input.liveText.trim();
  const liveBudget = Math.max(1, input.limit - WATCHING_SUFFIX.length);

  if (update === "") {
    return {
      liveText: prior,
      writes: prior === "" ? [] : [{ text: renderWatchingDigest(prior), live: true }],
    };
  }

  const combined = prior === "" ? update : `${prior}\n\n${update}`;
  if (combined.length <= liveBudget) {
    return {
      liveText: combined,
      writes: [{ text: renderWatchingDigest(combined), live: true }],
    };
  }

  const writes: Array<BackgroundDigestWrite> = [];
  if (prior !== "") writes.push({ text: prior, live: false });
  const pieces = chunkDiscordContent(update, liveBudget);
  for (let index = 0; index < pieces.length; index += 1) {
    const piece = pieces[index] ?? "";
    const live = index === pieces.length - 1;
    writes.push({ text: live ? renderWatchingDigest(piece) : piece, live });
  }
  return { liveText: pieces.at(-1) ?? "", writes };
}

export function pullRequestWatchIsActive(
  pullRequests: ReadonlyArray<{ readonly watch?: unknown }> | null | undefined,
): boolean {
  return (pullRequests ?? []).some((link) => link.watch != null);
}

function watchStopped(message: WatchDigestMessage): boolean {
  const summary = message.notification?.summary ?? "";
  const text = message.text ?? "";
  return /stopped watching/i.test(summary) || /stopped watching/i.test(text);
}

/**
 * A pull-request watch wake folds into the editable digest while the watch is
 * still on. The wake that ends the watch, and any other turn, posts a final.
 */
export function turnFoldsIntoWatchDigest(input: {
  readonly turnId: string | null;
  readonly messages: ReadonlyArray<WatchDigestMessage>;
  readonly pullRequests: ReadonlyArray<{ readonly watch?: unknown }> | null | undefined;
  readonly hasAttachments: boolean;
}): boolean {
  if (input.hasAttachments) return false;
  if (!pullRequestWatchIsActive(input.pullRequests)) return false;
  const turnId = input.turnId?.trim() ?? "";
  if (turnId === "") return false;
  let trigger: WatchDigestMessage | undefined;
  for (let index = input.messages.length - 1; index >= 0; index -= 1) {
    const message = input.messages[index];
    if (message === undefined || message.role !== "user") continue;
    if ((message.turnId?.trim() ?? "") !== turnId) continue;
    trigger = message;
    break;
  }
  if (trigger === undefined) return false;
  if (trigger.notification?.source?.kind !== "monitor") return false;
  return !watchStopped(trigger);
}
