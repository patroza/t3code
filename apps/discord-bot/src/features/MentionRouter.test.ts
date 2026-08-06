// @effect-diagnostics nodeBuiltinImport:off - existence contract reads router source on disk.
import * as NodeFS from "node:fs";
import { ProjectId, ProviderDriverKind, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import { it as effectIt } from "@effect/vitest";

import {
  createHandledDiscordMessageTracker,
  findDiscordLinkForT3Target,
  getContinuedConversationModelChangeError,
  isIncompleteDiscordLink,
  shouldShowThreadBootstrapReaction,
  makeDiscordMessageDispatchQueue,
} from "./MentionRouter.ts";

const mentionRouterSource = NodeFS.readFileSync(
  new URL("./MentionRouter.ts", import.meta.url),
  "utf8",
);

describe("shouldShowThreadBootstrapReaction", () => {
  it("marks channel prompts that need a Discord/T3 thread bootstrap", () => {
    expect(
      shouldShowThreadBootstrapReaction({
        inThread: false,
        intentKind: "prompt",
        hasPromptOrAttachment: true,
      }),
    ).toBe(true);
  });

  it("does not mark existing threads, commands, or empty mentions", () => {
    expect(
      shouldShowThreadBootstrapReaction({
        inThread: true,
        intentKind: "prompt",
        hasPromptOrAttachment: true,
      }),
    ).toBe(false);
    expect(
      shouldShowThreadBootstrapReaction({
        inThread: false,
        intentKind: "help",
        hasPromptOrAttachment: true,
      }),
    ).toBe(false);
    expect(
      shouldShowThreadBootstrapReaction({
        inThread: false,
        intentKind: "prompt",
        hasPromptOrAttachment: false,
      }),
    ).toBe(false);
  });

  it("wires 👀 addition to channel intake and removal to initial-pin success", () => {
    expect(mentionRouterSource).toContain(
      ".addMyMessageReaction(\n              pendingReadyReaction.channelId",
    );
    expect(mentionRouterSource).toContain(
      "Effect.tap(() =>\n            input.pendingReadyReaction === undefined",
    );
    expect(mentionRouterSource).toContain(
      ".deleteMyMessageReaction(\n                    input.pendingReadyReaction.channelId",
    );
    expect(mentionRouterSource).toContain("const discordThread = yield* openOrReuseThread(");
  });
});

describe("createHandledDiscordMessageTracker", () => {
  it("marks handled messages and evicts the oldest ids beyond the limit", () => {
    const tracker = createHandledDiscordMessageTracker(2);

    tracker.mark("message-1");
    tracker.mark("message-2");

    expect(tracker.has("message-1")).toBe(true);
    expect(tracker.has("message-2")).toBe(true);

    tracker.mark("message-3");

    expect(tracker.has("message-1")).toBe(false);
    expect(tracker.has("message-2")).toBe(true);
    expect(tracker.has("message-3")).toBe(true);
  });

  it("claims a message id only once so create/update races cannot double-route", () => {
    const tracker = createHandledDiscordMessageTracker(8);

    expect(tracker.claim("message-1")).toBe(true);
    expect(tracker.claim("message-1")).toBe(false);
    expect(tracker.has("message-1")).toBe(true);

    tracker.mark("message-2");
    expect(tracker.claim("message-2")).toBe(false);
  });
});

describe("makeDiscordMessageDispatchQueue", () => {
  effectIt.effect("keeps same-channel events FIFO while other channels remain independent", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const queue = yield* makeDiscordMessageDispatchQueue();
        const releaseFirst = yield* Deferred.make<void>();
        const firstStarted = yield* Deferred.make<void>();
        const handled = yield* Ref.make<ReadonlyArray<string>>([]);
        const record = (value: string) => Ref.update(handled, (values) => [...values, value]);

        yield* queue.enqueue({
          channelId: "channel-a",
          handle: Deferred.succeed(firstStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseFirst)),
            Effect.andThen(record("first")),
          ),
        });
        yield* Deferred.await(firstStarted);
        yield* queue.enqueue({ channelId: "channel-a", handle: record("second") });
        yield* queue.enqueue({ channelId: "channel-b", handle: record("other-channel") });
        yield* queue.drainKey("channel-b");

        expect(yield* Ref.get(handled)).toEqual(["other-channel"]);

        yield* Deferred.succeed(releaseFirst, undefined);
        yield* queue.drainKey("channel-a");
        expect(yield* Ref.get(handled)).toEqual(["other-channel", "first", "second"]);
      }),
    ),
  );
});

describe("isIncompleteDiscordLink", () => {
  it("is incomplete when the thread-info pin was never stored", () => {
    expect(isIncompleteDiscordLink({})).toBe(true);
    expect(isIncompleteDiscordLink({ infoDiscordMessageId: undefined })).toBe(true);
    expect(isIncompleteDiscordLink({ infoDiscordMessageId: "" })).toBe(true);
  });

  it("is complete when a pin message id exists", () => {
    expect(isIncompleteDiscordLink({ infoDiscordMessageId: "msg-1" })).toBe(false);
  });
});

it("reuses a Discord link for the same canonical worktree", () => {
  const linkedThreadId = ThreadId.make("linked-thread");
  const targetThreadId = ThreadId.make("github-thread");
  const link = {
    discordThreadId: "discord-thread",
    t3ThreadId: linkedThreadId,
    projectId: ProjectId.make("project"),
    channelId: "channel",
    guildId: "guild",
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:00.000Z",
    lastActivityAt: "2026-07-19T00:00:00.000Z",
    status: "active" as const,
    lastSeenTurnId: null,
    lastFinalizedAssistantId: null,
    lastThreadSnapshotSequence: null,
    lastDeliveredSequence: null,
  };
  expect(
    findDiscordLinkForT3Target({
      links: [link],
      threads: [
        { id: linkedThreadId, worktreePath: "/Worktrees/PR-42/" },
        { id: targetThreadId, worktreePath: "/worktrees/pr-42" },
      ],
      target: { id: targetThreadId, worktreePath: "/worktrees/pr-42" },
    }),
  ).toBe(link);
});

describe("getContinuedConversationModelChangeError", () => {
  const providers = [
    {
      driver: ProviderDriverKind.make("codex"),
      instanceId: ProviderInstanceId.make("codex"),
    },
    {
      driver: ProviderDriverKind.make("claudeAgent"),
      instanceId: ProviderInstanceId.make("claudeAgent"),
    },
    {
      driver: ProviderDriverKind.make("grok"),
      instanceId: ProviderInstanceId.make("grok"),
      requiresNewThreadForModelChange: true,
    },
  ];

  it("allows switching models mid-conversation within the same provider", () => {
    expect(
      getContinuedConversationModelChangeError({
        providers,
        currentModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
        nextModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.5",
        },
      }),
    ).toBeNull();
  });

  it("rejects switching providers mid-conversation", () => {
    expect(
      getContinuedConversationModelChangeError({
        providers,
        currentModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
        nextModelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-6",
        },
      }),
    ).toContain("within the same provider");
  });

  it("rejects Grok model switches mid-conversation", () => {
    expect(
      getContinuedConversationModelChangeError({
        providers,
        currentModelSelection: {
          instanceId: ProviderInstanceId.make("grok"),
          model: "grok-build",
        },
        nextModelSelection: {
          instanceId: ProviderInstanceId.make("grok"),
          model: "grok-other",
        },
      }),
    ).toContain("does not allow switching models");
  });
});
