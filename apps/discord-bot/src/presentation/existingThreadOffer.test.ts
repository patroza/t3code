import { describe, expect, it } from "vite-plus/test";

import {
  START_NEW_THREAD_ANYWAY_LABEL,
  existingConversationOfferContent,
  existingConversationOfferFields,
  messageOffersNewThread,
  startNewThreadAnywayCustomId,
} from "./existingThreadOffer.ts";

describe("existing conversation offer", () => {
  it("links the existing Discord thread and the T3 thread", () => {
    expect(
      existingConversationOfferContent({
        title: "Allow Shipping Before Scheduled Pickup",
        discordThreadUrl: "https://discord.com/channels/g/thread",
        webLink: "https://omega.omegent.com/?thread=t-1",
      }),
    ).toBe(
      [
        "There's already a conversation for this: **Allow Shipping Before Scheduled Pickup**",
        "[Open the existing thread](https://discord.com/channels/g/thread)",
        "[Open in Omegent](https://omega.omegent.com/?thread=t-1)",
      ].join("\n"),
    );
  });

  it("links only the T3 thread when the conversation has no Discord home", () => {
    expect(
      existingConversationOfferContent({
        title: "SA-516",
        discordThreadUrl: null,
        webLink: "https://omega.omegent.com/?thread=t-1",
      }),
    ).toBe(
      [
        "There's already a conversation for this: **SA-516**",
        "[Open in Omegent](https://omega.omegent.com/?thread=t-1)",
      ].join("\n"),
    );
  });

  it("adds a button that starts a new thread here", () => {
    const fields = existingConversationOfferFields({
      title: "SA-516",
      discordThreadUrl: null,
      webLink: null,
      t3ThreadId: "thread-123",
    });
    expect(fields.components).toHaveLength(1);
    const button = fields.components[0]?.components[0];
    expect(button?.label).toBe(START_NEW_THREAD_ANYWAY_LABEL);
    expect(button?.label).toBe("start a new thread here anyway");
    expect(button?.custom_id).toBe(startNewThreadAnywayCustomId("thread-123"));
    expect(button?.custom_id).toBe("t3_new_anyway:thread-123");
    expect(button?.style).toBe(1);
  });

  it("recognizes the offer by its button or its text", () => {
    const fields = existingConversationOfferFields({
      title: "SA-516",
      discordThreadUrl: null,
      webLink: null,
      t3ThreadId: "thread-123",
    });
    expect(messageOffersNewThread(fields)).toBe(true);
    expect(
      messageOffersNewThread({
        content: "There's already a conversation for this: **SA-516**",
      }),
    ).toBe(true);
    expect(messageOffersNewThread({ content: "Starting a new thread here." })).toBe(false);
    expect(messageOffersNewThread(null)).toBe(false);
  });
});
