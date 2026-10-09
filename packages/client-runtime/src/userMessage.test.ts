import { ScheduledTaskId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  indexUserMessageSources,
  messageSenderCaption,
  resolveUserMessagePresentation,
  userMessageSenderCaption,
} from "./userMessage.ts";

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

  it("removes attribution from legacy scheduled prompts", () => {
    expect(
      resolveUserMessagePresentation({ role: "user", createdBy: "agent", text: legacyText }),
    ).toEqual({ text: "Check for crashes.\n", isAutomation: true, scheduledTaskId: undefined });
  });

  it("uses task metadata without changing the prompt", () => {
    expect(
      resolveUserMessagePresentation({
        role: "user",
        createdBy: "agent",
        scheduledTaskId: ScheduledTaskId.make("task-1"),
        text: legacyText,
      }),
    ).toEqual({ text: legacyText, isAutomation: true, scheduledTaskId: "task-1" });
  });

  it("preserves user-written and assistant-quoted schedule headers", () => {
    for (const message of [
      { role: "user", createdBy: "user" as const },
      { role: "user" },
      { role: "assistant", createdBy: "agent" as const },
    ]) {
      expect(resolveUserMessagePresentation({ ...message, text: legacyText })).toEqual({
        text: legacyText,
        isAutomation: false,
        scheduledTaskId: undefined,
      });
    }
  });

  it("leaves other agent prompts and embedded headers intact", () => {
    for (const text of [
      "Review this area",
      `Quoted prompt:\n${legacyText}`,
      "[Triggered by schedule task: Daily audit]",
    ]) {
      expect(resolveUserMessagePresentation({ role: "user", createdBy: "agent", text })).toEqual({
        text,
        isAutomation: false,
        scheduledTaskId: undefined,
      });
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
        isAutomation: true,
        scheduledTaskId: "task:daily-audit",
      });
    }
  });
});
