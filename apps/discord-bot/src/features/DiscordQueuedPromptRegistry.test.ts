import { MessageId, ThreadId } from "@t3tools/contracts";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import {
  clearQueuedPromptBadges,
  createDiscordQueuedPromptRegistry,
  isDiscordReactionAlreadyGone,
  queuedPromptsThatStartedProcessing,
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

describe("queuedPromptsThatStartedProcessing", () => {
  const queued = {
    t3MessageId: "msg-queued",
  };
  const started = {
    t3MessageId: "msg-started",
  };

  it("keeps a prompt while its run is still queued", () => {
    expect(
      queuedPromptsThatStartedProcessing({
        pending: [queued, started],
        runStatuses: [
          { status: "queued", userMessageId: "msg-queued" },
          { status: "queued", userMessageId: "msg-started" },
        ],
      }),
    ).toEqual([]);
  });

  it("selects a prompt once its run leaves the queue", () => {
    expect(
      queuedPromptsThatStartedProcessing({
        pending: [queued, started],
        runStatuses: [
          { status: "queued", userMessageId: "msg-queued" },
          { status: "starting", userMessageId: "msg-started" },
        ],
      }),
    ).toEqual([started]);
  });

  it("leaves a prompt alone until a run is visible", () => {
    expect(
      queuedPromptsThatStartedProcessing({
        pending: [queued],
        runStatuses: [],
      }),
    ).toEqual([]);
  });

  it("keeps the badge when any run for the message is still queued", () => {
    expect(
      queuedPromptsThatStartedProcessing({
        pending: [started],
        runStatuses: [
          { status: "completed", userMessageId: "msg-started" },
          { status: "queued", userMessageId: "msg-started" },
        ],
      }),
    ).toEqual([]);
  });

  it("clears after cancel, failure, or completion", () => {
    expect(
      queuedPromptsThatStartedProcessing({
        pending: [{ t3MessageId: "msg-cancelled" }, { t3MessageId: "msg-failed" }],
        runStatuses: [
          { status: "cancelled", userMessageId: "msg-cancelled" },
          { status: "failed", userMessageId: "msg-failed" },
        ],
      }).map((entry) => entry.t3MessageId),
    ).toEqual(["msg-cancelled", "msg-failed"]);
  });
});

describe("clearQueuedPromptBadges", () => {
  const entry = {
    discordChannelId: "channel-1",
    discordMessageId: "discord-1",
    t3ThreadId: ThreadId.make("thread-1"),
    t3MessageId: MessageId.make("msg-1"),
    authorUserId: null,
  };

  effectIt.effect("forgets the prompt after the reaction delete succeeds", () =>
    Effect.gen(function* () {
      const registry = createDiscordQueuedPromptRegistry();
      registry.remember(entry);
      let deleted = 0;
      yield* clearQueuedPromptBadges({
        registry,
        entries: [entry],
        deleteReaction: () =>
          Effect.sync(() => {
            deleted += 1;
          }),
      });
      expect(deleted).toBe(1);
      expect(registry.getByDiscordMessageId("discord-1")).toBeNull();
    }),
  );

  effectIt.effect("keeps the prompt when the delete fails so a later snapshot can retry", () =>
    Effect.gen(function* () {
      const registry = createDiscordQueuedPromptRegistry();
      registry.remember(entry);
      yield* clearQueuedPromptBadges({
        registry,
        entries: [entry],
        deleteReaction: () => Effect.fail("rate limited"),
      });
      expect(registry.getByDiscordMessageId("discord-1")).toEqual(entry);
    }),
  );

  effectIt.effect("forgets the prompt when Discord says the reaction is already gone", () =>
    Effect.gen(function* () {
      const registry = createDiscordQueuedPromptRegistry();
      registry.remember(entry);
      yield* clearQueuedPromptBadges({
        registry,
        entries: [entry],
        deleteReaction: () => Effect.fail({ response: { status: 404 } }),
      });
      expect(registry.getByDiscordMessageId("discord-1")).toBeNull();
    }),
  );

  effectIt.effect("settles in-flight tracking after success and failure", () =>
    Effect.gen(function* () {
      const registry = createDiscordQueuedPromptRegistry();
      const settled: string[] = [];
      yield* clearQueuedPromptBadges({
        registry,
        entries: [entry],
        deleteReaction: () => Effect.fail("nope"),
        onSettled: (prompt) => {
          settled.push(prompt.discordMessageId);
        },
      });
      expect(settled).toEqual(["discord-1"]);
      expect(isDiscordReactionAlreadyGone({ response: { status: 404 } })).toBe(true);
      expect(isDiscordReactionAlreadyGone({ response: { status: 500 } })).toBe(false);
      expect(isDiscordReactionAlreadyGone("Unknown Emoji")).toBe(true);
    }),
  );
});
