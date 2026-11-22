import { Discord } from "dfx";

import { formatOpenInOmegentLink } from "./threadInfoPin.ts";

/** Button label. Starts a new T3 thread in this Discord thread. */
export const START_NEW_THREAD_ANYWAY_LABEL = "start a new thread here anyway";

export const START_NEW_THREAD_ANYWAY_CUSTOM_ID_PREFIX = "t3_new_anyway:";

/** Posted again when someone talks in a thread that is still waiting on the button. */
export const NEW_THREAD_OFFER_HOLD_MESSAGE =
  "This Discord thread stays unlinked until you click **start a new thread here anyway**.";

const OFFER_CONTENT_MARKER = "There's already a conversation for this:";

export function startNewThreadAnywayCustomId(t3ThreadId: string, alertMessageId?: string): string {
  const base = `${START_NEW_THREAD_ANYWAY_CUSTOM_ID_PREFIX}${t3ThreadId}`;
  if (alertMessageId === undefined || alertMessageId.length === 0) return base;
  return `${base}:${alertMessageId}`;
}

/** Sentry alert id stashed after the T3 thread id when the offer is not in a thread. */
export function alertMessageIdFromNewThreadCustomId(customId: string): string | null {
  if (!customId.startsWith(START_NEW_THREAD_ANYWAY_CUSTOM_ID_PREFIX)) return null;
  const suffix = customId.slice(START_NEW_THREAD_ANYWAY_CUSTOM_ID_PREFIX.length);
  const splitAt = suffix.indexOf(":");
  if (splitAt < 0) return null;
  const messageId = suffix.slice(splitAt + 1);
  return /^\d{15,22}$/u.test(messageId) ? messageId : null;
}

export function referencedDiscordMessageId(message: unknown): string | null {
  if (typeof message !== "object" || message === null || !("message_reference" in message)) {
    return null;
  }
  const reference = message.message_reference;
  if (typeof reference !== "object" || reference === null || !("message_id" in reference)) {
    return null;
  }
  const id = reference.message_id;
  return typeof id === "string" && /^\d{15,22}$/u.test(id) ? id : null;
}

/** Alert a channel-level Sentry offer should open a thread from. */
export function alertMessageIdFromOffer(message: unknown, customId: string): string | null {
  return alertMessageIdFromNewThreadCustomId(customId) ?? referencedDiscordMessageId(message);
}

/**
 * True when this Discord message is the offer. Later mentions must not link
 * the thread or start a turn while one of these is still in the channel.
 */
export function messageOffersNewThread(message: unknown): boolean {
  if (typeof message !== "object" || message === null) return false;
  if ("content" in message && typeof message.content === "string") {
    if (message.content.includes(OFFER_CONTENT_MARKER)) return true;
  }
  if (!("components" in message) || !Array.isArray(message.components)) return false;
  for (const row of message.components) {
    if (typeof row !== "object" || row === null || !("components" in row)) continue;
    if (!Array.isArray(row.components)) continue;
    for (const child of row.components) {
      if (typeof child !== "object" || child === null || !("custom_id" in child)) continue;
      if (
        typeof child.custom_id === "string" &&
        child.custom_id.startsWith(START_NEW_THREAD_ANYWAY_CUSTOM_ID_PREFIX)
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Discord reply when a new thread names a Jira issue or GitHub PR that already
 * has a T3 conversation. The link is the existing Discord thread when one is
 * active, and the T3 thread otherwise. The button is the only way to start a
 * separate conversation here.
 */
export function existingConversationOfferContent(input: {
  readonly title: string;
  readonly discordThreadUrl: string | null;
  readonly webLink: string | null;
}): string {
  const title = input.title.replace(/[*_`]/g, "").replace(/\s+/g, " ").trim() || "Untitled";
  const lines = [`There's already a conversation for this: **${title}**`];
  if (input.discordThreadUrl !== null && input.discordThreadUrl.length > 0) {
    lines.push(`[Open the existing thread](${input.discordThreadUrl})`);
  }
  if (input.webLink !== null && input.webLink.trim().length > 0) {
    lines.push(formatOpenInOmegentLink(input.webLink));
  }
  return lines.join("\n");
}

export function existingConversationOfferFields(input: {
  readonly title: string;
  readonly discordThreadUrl: string | null;
  readonly webLink: string | null;
  readonly t3ThreadId: string;
  /** Set when the offer is a channel reply, so the button can open that alert. */
  readonly alertMessageId?: string;
}) {
  return {
    content: existingConversationOfferContent(input),
    components: [
      [
        {
          type: 2 as const,
          custom_id: startNewThreadAnywayCustomId(input.t3ThreadId, input.alertMessageId),
          label: START_NEW_THREAD_ANYWAY_LABEL,
          style: Discord.ButtonStyleTypes.PRIMARY,
        },
      ],
    ].map((components) => ({
      type: 1 as const,
      components,
    })),
  };
}
