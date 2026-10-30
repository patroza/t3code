import { describe, expect, it } from "vite-plus/test";

import {
  indexUserMessageSources,
  messageSenderCaption,
  resolveUserMessagePresentation,
  userMessageSenderCaption,
} from "./userMessage.ts";
import { GuestMessageId } from "@t3tools/contracts";
import { ATTACHMENT_ONLY_BOOTSTRAP_PROMPT } from "@t3tools/shared/composerContextReferences";

const patrickDesktop = {
  personId: "patroza",
  username: "patroza",
  channel: "desktop",
  identityReady: true,
};

describe("messageSenderCaption", () => {
  it("hides a message from this client", () => {
    expect(
      messageSenderCaption({
        source: { channel: "desktop", personId: "patroza", username: "patroza" },
        viewer: patrickDesktop,
      }),
    ).toBeUndefined();
  });

  it("shows only the source when the same person sent it from somewhere else", () => {
    expect(
      messageSenderCaption({
        source: { channel: "discord", personId: "patroza", username: "patroza" },
        viewer: patrickDesktop,
      }),
    ).toBe("discord");
    expect(
      messageSenderCaption({
        source: { channel: "mobile", username: "Patroza" },
        viewer: patrickDesktop,
      }),
    ).toBe("mobile");
  });

  it("shows username@source for someone else", () => {
    expect(
      messageSenderCaption({
        source: {
          channel: "bot",
          personId: "andreasimonecosta",
          username: "andreasimonecosta",
          actor: { displayName: "Andrea" },
        },
        viewer: patrickDesktop,
      }),
    ).toBe("andreasimonecosta@bot");
  });

  it("uses the first word of the display name when the username is missing", () => {
    expect(
      messageSenderCaption({
        source: {
          channel: "discord",
          personId: "andreasimonecosta",
          actor: { displayName: "Andrea Simone Costa" },
        },
        viewer: patrickDesktop,
      }),
    ).toBe("Andrea@discord");
  });

  it("shows only the source for an unnamed sender on another channel", () => {
    expect(
      messageSenderCaption({
        source: { channel: "bot" },
        viewer: patrickDesktop,
      }),
    ).toBe("bot");
    expect(
      messageSenderCaption({
        source: { channel: "desktop" },
        viewer: patrickDesktop,
      }),
    ).toBeUndefined();
  });

  it("holds the caption for this channel until the viewer claim has loaded", () => {
    expect(
      messageSenderCaption({
        source: { channel: "desktop", username: "patroza" },
        viewer: { channel: "desktop", identityReady: false },
      }),
    ).toBeUndefined();
    expect(
      messageSenderCaption({
        source: { channel: "discord", username: "patroza" },
        viewer: { channel: "desktop", identityReady: false },
      }),
    ).toBe("patroza@discord");
  });
});

describe("userMessageSenderCaption", () => {
  it("keeps the generic line for an agent message with no sender", () => {
    expect(userMessageSenderCaption({ createdBy: "agent" })).toBe("Sent by another agent");
    expect(userMessageSenderCaption({ createdBy: "user" })).toBeUndefined();
  });

  it("prefers the message source over the thread origin", () => {
    expect(
      userMessageSenderCaption({
        createdBy: "agent",
        source: { channel: "bot", username: "andreasimonecosta" },
        originSource: { channel: "discord", username: "patroza" },
        viewer: patrickDesktop,
      }),
    ).toBe("andreasimonecosta@bot");
  });

  it("uses the thread origin for an agent message that has no source of its own", () => {
    expect(
      userMessageSenderCaption({
        createdBy: "agent",
        originSource: { channel: "discord", username: "patroza" },
        viewer: patrickDesktop,
      }),
    ).toBe("discord");
    expect(
      userMessageSenderCaption({
        createdBy: "user",
        originSource: { channel: "discord", username: "patroza" },
        viewer: patrickDesktop,
      }),
    ).toBeUndefined();
  });
});

describe("indexUserMessageSources", () => {
  it("keeps user messages that have a source", () => {
    const sources = indexUserMessageSources([
      { id: "user", role: "user", source: { channel: "discord", username: "patroza" } },
      { id: "plain", role: "user" },
      { id: "assistant", role: "assistant", source: { channel: "bot", username: "patroza" } },
    ]);
    expect(sources.get("user")?.channel).toBe("discord");
    expect(sources.has("plain")).toBe(false);
    expect(sources.has("assistant")).toBe(false);
  });
});

describe("resolveUserMessagePresentation", () => {
  const legacyText = "[Triggered by schedule task: Daily audit]\n\nCheck for crashes.\n";

  it("preserves user-written and assistant-quoted schedule headers", () => {
    for (const message of [
      { role: "user", createdBy: "user" as const },
      { role: "user" },
      { role: "assistant", createdBy: "agent" as const },
    ]) {
      expect(resolveUserMessagePresentation({ ...message, text: legacyText })).toEqual({
        text: legacyText,
        attribution: null,
        scheduledTaskId: undefined,
      });
    }
  });

  it("hides the prompt that stands in for an attachment-only message", () => {
    for (const text of [
      ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
      `Ultrathink:\n${ATTACHMENT_ONLY_BOOTSTRAP_PROMPT}`,
    ]) {
      expect(resolveUserMessagePresentation({ role: "user", text })).toEqual({
        text: "",
        attribution: null,
        scheduledTaskId: undefined,
      });
    }
  });

  it("shows a guest's own words and name, not the attributed text the agent reads", () => {
    expect(
      resolveUserMessagePresentation({
        role: "user",
        createdBy: "user",
        text: "Message from guest Sam, sent by the owner:\n\nWhy?",
        context: {
          guest: {
            guestMessageId: GuestMessageId.make("guest-message:one"),
            name: "Sam",
            text: "Why?",
          },
        },
      }),
    ).toEqual({ text: "Why?", attribution: "guest", scheduledTaskId: undefined, guestName: "Sam" });
  });

  it("attributes older server-sent restart continuations to T3 Code, not another agent", () => {
    const text = "Note: the T3 server restarted.";
    expect(
      resolveUserMessagePresentation({
        role: "user",
        createdBy: "agent",
        creationSource: "server",
        text,
      }),
    ).toMatchObject({ attribution: "t3code" });
    for (const creationSource of ["mcp", "provider"] as const) {
      expect(
        resolveUserMessagePresentation({ role: "user", createdBy: "agent", creationSource, text }),
      ).toMatchObject({ attribution: "agent" });
    }
  });

  it("recovers the triggering automation from older scheduler message ids", () => {
    for (const trigger of ["scheduled", "manual"]) {
      expect(
        resolveUserMessagePresentation({
          id: `scheduled-task-message:task:daily-audit:1788661140000:${trigger}`,
          role: "user",
          createdBy: "user",
          text: legacyText,
        }),
      ).toEqual({
        text: "Check for crashes.\n",
        attribution: "automation",
        scheduledTaskId: "task:daily-audit",
      });
    }
  });
});
