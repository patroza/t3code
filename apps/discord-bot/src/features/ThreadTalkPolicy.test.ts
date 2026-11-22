import { ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ThreadLink } from "../store/ThreadLinkStore.ts";
import {
  formatUnmentionedDiscordPrompt,
  parseThreadTalkCommand,
  threadTalkEnabled,
} from "./ThreadTalkPolicy.ts";

const link = (threadTalkMode?: "all-messages"): ThreadLink => ({
  discordThreadId: "discord-thread-1",
  t3ThreadId: ThreadId.make("thread-1"),
  projectId: ProjectId.make("project-1"),
  channelId: "channel-1",
  guildId: "guild-1",
  createdAt: "2026-07-18T00:00:00.000Z",
  updatedAt: "2026-07-18T00:00:00.000Z",
  lastActivityAt: "2026-07-18T00:00:00.000Z",
  status: "active",
  lastSeenTurnId: null,
  lastFinalizedAssistantId: null,
  lastThreadSnapshotSequence: null,
  lastDeliveredSequence: null,
  ...(threadTalkMode === undefined ? {} : { threadTalkMode }),
});

describe("parseThreadTalkCommand", () => {
  it("parses exact on, off, and status commands", () => {
    expect(parseThreadTalkCommand("thread-talk on")).toEqual({ kind: "set", enabled: true });
    expect(parseThreadTalkCommand(" THREAD-TALK   OFF ")).toEqual({
      kind: "set",
      enabled: false,
    });
    expect(parseThreadTalkCommand("thread-talk status")).toEqual({ kind: "status" });
  });

  it("does not consume ordinary prompts containing the command words", () => {
    expect(parseThreadTalkCommand("please turn thread-talk on")).toBeNull();
    expect(parseThreadTalkCommand("thread-talk on and check this")).toBeNull();
  });
});

describe("threadTalkEnabled", () => {
  it("is disabled for absent and legacy links", () => {
    expect(threadTalkEnabled(null)).toBe(false);
    expect(threadTalkEnabled(link())).toBe(false);
  });

  it("is enabled only for all-messages links", () => {
    expect(threadTalkEnabled(link("all-messages"))).toBe(true);
  });
});

it("labels unmentioned prompts with Discord author and message context", () => {
  expect(
    formatUnmentionedDiscordPrompt({
      content: "check the failing build",
      authorId: "user-1",
      authorName: "Pat",
      messageId: "message-1",
    }),
  ).toBe("Discord message from Pat (user user-1, message message-1):\n\ncheck the failing build");
});
