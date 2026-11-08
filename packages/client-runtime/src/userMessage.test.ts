import { ComposerContextId, GuestMessageId, ScheduledTaskId } from "@t3tools/contracts";
import { ATTACHMENT_ONLY_BOOTSTRAP_PROMPT } from "@t3tools/shared/composerContextReferences";
import {
  indexUserMessageSources,
  messageSenderCaption,
  userMessageSenderCaption,
  resolveUserMessageFileCards,
  resolveUserMessageGrouping,
  resolveUserMessagePresentation,
} from "./userMessage.ts";
import { describe, expect, it } from "vite-plus/test";

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

describe("resolveUserMessageGrouping", () => {
  const own = { role: "user", text: "hello" };

  it("groups only adjacent own messages", () => {
    expect(resolveUserMessageGrouping(own, own, own)).toEqual({
      groupedWithPrevious: true,
      groupedWithNext: true,
      continuesSteer: false,
    });
    expect(resolveUserMessageGrouping(own, undefined, own)).toMatchObject({
      groupedWithPrevious: false,
      groupedWithNext: true,
    });
    for (const boundary of [
      undefined,
      { ...own, role: "assistant" },
      { ...own, createdBy: "agent" as const },
      { ...own, createdBy: "agent" as const, creationSource: "server" as const },
      { ...own, scheduledTaskId: ScheduledTaskId.make("task") },
      {
        ...own,
        context: {
          guest: { guestMessageId: GuestMessageId.make("guest"), name: "Sam", text: "hi" },
        },
      },
    ]) {
      expect(resolveUserMessageGrouping(own, boundary, boundary)).toEqual({
        groupedWithPrevious: false,
        groupedWithNext: false,
        continuesSteer: false,
      });
      expect(resolveUserMessageGrouping(boundary, own, own)).toEqual({
        groupedWithPrevious: false,
        groupedWithNext: false,
        continuesSteer: false,
      });
    }
  });

  it("shows one label for consecutive steers, including promoted queued messages", () => {
    for (const inputIntent of ["steer", "promoted_queued_to_steer"] as const) {
      const steer = { ...own, inputIntent };
      expect(
        resolveUserMessageGrouping(steer, { ...own, inputIntent: "steer" }, undefined)
          .continuesSteer,
      ).toBe(true);
      expect(
        resolveUserMessageGrouping(
          steer,
          { ...own, inputIntent: "promoted_queued_to_steer" },
          undefined,
        ).continuesSteer,
      ).toBe(true);
      expect(resolveUserMessageGrouping(steer, own, undefined).continuesSteer).toBe(false);
      expect(resolveUserMessageGrouping(own, steer, undefined).continuesSteer).toBe(false);
    }
  });
});

describe("resolveUserMessageFileCards", () => {
  const file = {
    type: "file" as const,
    id: "report",
    name: "report.pdf",
    mimeType: "application/pdf",
    sizeBytes: 1024,
  };
  const record = {
    ...file,
    version: 1 as const,
    kind: "file" as const,
    contextId: ComposerContextId.make("report"),
    label: file.name,
    attachmentId: file.id,
  };
  const context = { version: 1 as const, records: [record] };
  const reference = "[report.pdf](t3-context://v1/file/report)";

  it("shows file cards for bare attachments and bound file references", () => {
    for (const text of ["", " \n", reference]) {
      expect(resolveUserMessageFileCards({ text, attachments: [file], context })).toEqual([file]);
    }
    expect(
      resolveUserMessageFileCards({
        text: `${reference}\n${reference}`,
        attachments: [file],
        context,
      }),
    ).toEqual([file]);
  });

  it("keeps words and unavailable or non-file references in the bubble", () => {
    for (const text of [
      `read ${reference}`,
      "[missing.pdf](t3-context://v1/file/missing)",
      "[report.pdf](t3-context://v1/mention/report)",
    ]) {
      expect(resolveUserMessageFileCards({ text, attachments: [file], context })).toBeNull();
    }
    expect(resolveUserMessageFileCards({ text: reference, attachments: [file] })).toBeNull();
    expect(
      resolveUserMessageFileCards({
        text: reference,
        attachments: [file],
        context: {
          version: 1,
          records: [
            {
              version: 1,
              kind: "file",
              contextId: record.contextId,
              label: file.name,
              payload: {},
            },
          ],
        },
      }),
    ).toBeNull();
    expect(
      resolveUserMessageFileCards({
        text: reference,
        attachments: [{ ...file, id: "other" }],
        context,
      }),
    ).toBeNull();
  });

  it("keeps media, unknown attachments, and empty messages out of the file cards", () => {
    const media = [
      { ...file, type: "image" as const, name: "photo.png", mimeType: "image/png" },
      { ...file, name: "photo.png", mimeType: "application/octet-stream" },
      { ...file, name: "clip.mp4", mimeType: "video/mp4" },
      { ...file, name: "clip.mov", mimeType: "application/octet-stream" },
      { ...file, name: "voice.mp3", mimeType: "audio/mpeg" },
      { ...file, type: "future" },
    ];
    expect(resolveUserMessageFileCards({ text: "", attachments: [] })).toBeNull();
    for (const attachment of media) {
      expect(resolveUserMessageFileCards({ text: "", attachments: [attachment] })).toBeNull();
      expect(resolveUserMessageFileCards({ text: "", attachments: [file, attachment] })).toBeNull();
    }
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
