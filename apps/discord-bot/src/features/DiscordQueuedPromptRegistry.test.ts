import { MessageId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  createDiscordQueuedPromptRegistry,
  formatSteernowEmptyQueueMessage,
  resolveSteernowMessageIds,
} from "./DiscordQueuedPromptRegistry.ts";

describe("DiscordQueuedPromptRegistry", () => {
  it("remembers entries by Discord message and thread", () => {
    const registry = createDiscordQueuedPromptRegistry();
    const entry = {
      discordChannelId: "channel-1",
      discordMessageId: "discord-1",
      t3ThreadId: ThreadId.make("thread-1"),
      t3MessageId: MessageId.make("msg-1"),
      authorUserId: "user-1",
    };
    registry.remember(entry);
    expect(registry.getByDiscordMessageId("discord-1")).toEqual(entry);
    expect(registry.listForThread(ThreadId.make("thread-1"))).toEqual([entry]);
  });

  it("forgets by Discord message id and by T3 message id", () => {
    const registry = createDiscordQueuedPromptRegistry();
    registry.remember({
      discordChannelId: "channel-1",
      discordMessageId: "discord-1",
      t3ThreadId: ThreadId.make("thread-1"),
      t3MessageId: MessageId.make("msg-1"),
      authorUserId: null,
    });
    registry.remember({
      discordChannelId: "channel-1",
      discordMessageId: "discord-2",
      t3ThreadId: ThreadId.make("thread-1"),
      t3MessageId: MessageId.make("msg-2"),
      authorUserId: null,
    });

    expect(registry.forgetDiscordMessage("discord-1")?.t3MessageId).toBe("msg-1");
    expect(registry.getByDiscordMessageId("discord-1")).toBeNull();
    expect(registry.listForThread(ThreadId.make("thread-1"))).toHaveLength(1);

    expect(
      registry.forgetT3Message(ThreadId.make("thread-1"), MessageId.make("msg-2"))
        ?.discordMessageId,
    ).toBe("discord-2");
    expect(registry.listForThread(ThreadId.make("thread-1"))).toEqual([]);
  });

  it("clears an entire thread", () => {
    const registry = createDiscordQueuedPromptRegistry();
    registry.remember({
      discordChannelId: "channel-1",
      discordMessageId: "discord-1",
      t3ThreadId: ThreadId.make("thread-1"),
      t3MessageId: MessageId.make("msg-1"),
      authorUserId: null,
    });
    const cleared = registry.clearThread(ThreadId.make("thread-1"));
    expect(cleared).toHaveLength(1);
    expect(registry.listForThread(ThreadId.make("thread-1"))).toEqual([]);
  });
});

describe("resolveSteernowMessageIds", () => {
  it("prefers the server queue when present", () => {
    const result = resolveSteernowMessageIds({
      serverQueued: [
        { messageId: MessageId.make("server-1") },
        { messageId: MessageId.make("server-2") },
      ],
      localPending: [{ t3MessageId: MessageId.make("local-1") }],
      detailLoaded: true,
    });
    expect(result).toEqual({
      messageIds: [MessageId.make("server-1"), MessageId.make("server-2")],
      source: "server",
      snapshotMissing: false,
    });
  });

  it("falls back to the local registry when the server queue is empty", () => {
    const result = resolveSteernowMessageIds({
      serverQueued: [],
      localPending: [
        { t3MessageId: MessageId.make("local-1") },
        { t3MessageId: MessageId.make("local-1") },
        { t3MessageId: MessageId.make("local-2") },
      ],
      detailLoaded: false,
    });
    expect(result).toEqual({
      messageIds: [MessageId.make("local-1"), MessageId.make("local-2")],
      source: "local",
      snapshotMissing: true,
    });
  });

  it("reports empty with snapshotMissing when both sources are empty and detail failed", () => {
    expect(
      resolveSteernowMessageIds({
        serverQueued: [],
        localPending: [],
        detailLoaded: false,
      }),
    ).toEqual({
      messageIds: [],
      source: "empty",
      snapshotMissing: true,
    });
  });
});

describe("formatSteernowEmptyQueueMessage", () => {
  it("mentions steer path when the queue is truly empty", () => {
    const text = formatSteernowEmptyQueueMessage({ snapshotMissing: false });
    expect(text).toContain("Nothing is queued");
    expect(text).toContain("/agent steer");
    expect(text).toContain("/agent steernow");
  });

  it("mentions snapshot failure when the HTTP detail is missing", () => {
    const text = formatSteernowEmptyQueueMessage({ snapshotMissing: true });
    expect(text).toContain("thread snapshot unavailable");
    expect(text).toContain("/agent steer");
  });
});
