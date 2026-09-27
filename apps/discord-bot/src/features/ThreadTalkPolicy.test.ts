import { ProjectId, ThreadId } from "@t3tools/contracts";
import { Discord } from "dfx";
import { describe, expect, it } from "vite-plus/test";

import type { ThreadLink } from "../store/ThreadLinkStore.ts";
import {
  DISCORD_REPLY_MESSAGE_TYPE,
  discordEventMentionsBot,
  formatUnmentionedDiscordPrompt,
  parseThreadTalkCommand,
  shouldAcceptThreadTalkMessage,
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

describe("discordEventMentionsBot", () => {
  const botUserId = "bot-1";
  const botRoleId = "role-1";

  it("tracks Discord MessageType.REPLY", () => {
    expect(DISCORD_REPLY_MESSAGE_TYPE).toBe(Discord.MessageType.REPLY);
  });

  it("treats in-content user and role mentions as addressing the bot", () => {
    expect(
      discordEventMentionsBot({
        content: `hey <@${botUserId}> look`,
        botUserId,
      }),
    ).toBe(true);
    expect(
      discordEventMentionsBot({
        content: "hey",
        mentionRoleIds: [botRoleId],
        botUserId,
        botRoleId,
      }),
    ).toBe(true);
  });

  it("treats the mentions array as addressing the bot on ordinary messages", () => {
    expect(
      discordEventMentionsBot({
        content: "please check this",
        mentions: [{ id: botUserId }],
        botUserId,
      }),
    ).toBe(true);
  });

  it("ignores reply pings that only put the bot in the mentions array", () => {
    expect(
      discordEventMentionsBot({
        content: "quoting this for context",
        mentions: [{ id: botUserId }],
        botUserId,
        messageType: DISCORD_REPLY_MESSAGE_TYPE,
      }),
    ).toBe(false);
  });

  it("still honors an explicit @mention on a reply", () => {
    expect(
      discordEventMentionsBot({
        content: `<@${botUserId}> check the quoted message`,
        mentions: [{ id: botUserId }],
        botUserId,
        messageType: DISCORD_REPLY_MESSAGE_TYPE,
      }),
    ).toBe(true);
    expect(
      discordEventMentionsBot({
        content: "check the quoted message",
        mentionRoleIds: [botRoleId],
        botUserId,
        botRoleId,
        messageType: DISCORD_REPLY_MESSAGE_TYPE,
      }),
    ).toBe(true);
  });
});

describe("shouldAcceptThreadTalkMessage", () => {
  it("accepts unmentioned non-reply messages when thread-talk is on", () => {
    expect(
      shouldAcceptThreadTalkMessage({
        mentioned: false,
        threadTalkEnabled: true,
      }),
    ).toBe(true);
  });

  it("does not consume unmentioned replies even when thread-talk is on", () => {
    expect(
      shouldAcceptThreadTalkMessage({
        mentioned: false,
        threadTalkEnabled: true,
        messageType: DISCORD_REPLY_MESSAGE_TYPE,
      }),
    ).toBe(false);
  });

  it("never thread-talks a message that already mentioned the bot", () => {
    expect(
      shouldAcceptThreadTalkMessage({
        mentioned: true,
        threadTalkEnabled: true,
      }),
    ).toBe(false);
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
