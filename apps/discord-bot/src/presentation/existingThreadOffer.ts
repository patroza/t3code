import { Discord } from "dfx";

import { formatOpenInOmegentLink } from "./threadInfoPin.ts";

/** Button label. Starts a new T3 thread in this Discord thread. */
export const START_NEW_THREAD_ANYWAY_LABEL = "start a new thread here anyway";

export const START_NEW_THREAD_ANYWAY_CUSTOM_ID_PREFIX = "t3_new_anyway:";

/** Posted again when someone talks in a thread that is still waiting on the button. */
export const NEW_THREAD_OFFER_HOLD_MESSAGE =
  "This Discord thread stays unlinked until you click **start a new thread here anyway**.";

const OFFER_CONTENT_MARKER = "There's already a conversation for this:";

export function startNewThreadAnywayCustomId(t3ThreadId: string): string {
  return `${START_NEW_THREAD_ANYWAY_CUSTOM_ID_PREFIX}${t3ThreadId}`;
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
}) {
  return {
    content: existingConversationOfferContent(input),
    components: [
      [
        {
          type: 2 as const,
          custom_id: startNewThreadAnywayCustomId(input.t3ThreadId),
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
