import { Discord } from "dfx";

import { formatOpenInOmegentLink } from "./threadInfoPin.ts";

/** Button label. Starts a new T3 thread in this Discord thread. */
export const START_NEW_THREAD_ANYWAY_LABEL = "start a new thread here anyway";

export const START_NEW_THREAD_ANYWAY_CUSTOM_ID_PREFIX = "t3_new_anyway:";

export function startNewThreadAnywayCustomId(t3ThreadId: string): string {
  return `${START_NEW_THREAD_ANYWAY_CUSTOM_ID_PREFIX}${t3ThreadId}`;
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
