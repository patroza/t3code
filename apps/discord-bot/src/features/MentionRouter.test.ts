// @effect-diagnostics nodeBuiltinImport:off - existence contract reads router source on disk.
import * as NodeFS from "node:fs";
import { ProjectId, ProviderDriverKind, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import { it as effectIt } from "@effect/vitest";

import { T3_CONNECT_WAIT_REACTION_EMOJI } from "../t3/T3Session.ts";
import {
  createHandledDiscordMessageTracker,
  findDiscordLinkForT3Target,
  getContinuedConversationModelChangeError,
  isIncompleteDiscordLink,
  isTransientDiscordDispatchError,
  shouldShowThreadBootstrapReaction,
  makeDiscordMessageDispatchQueue,
  retryTransientDiscordOperation,
} from "./MentionRouter.ts";

const mentionRouterSource = NodeFS.readFileSync(
  new URL("./MentionRouter.ts", import.meta.url),
  "utf8",
);

describe("T3 connect-wait queue", () => {
  it("waits for T3 readiness on bridged turns instead of bouncing immediately", () => {
    expect(mentionRouterSource).toContain("waitForT3ReadyForInbound");
    expect(mentionRouterSource).toContain('reason: "startBridgedTurn"');
    expect(mentionRouterSource).toContain("t3.waitUntilReady()");
    expect(mentionRouterSource).toContain(T3_CONNECT_WAIT_REACTION_EMOJI);
  });
});

describe("today-recap slash command", () => {
  it("registers /omegent today-recap and posts the recap in the invoking channel", () => {
    expect(mentionRouterSource).toContain('"today-recap": Effect.gen(function* () {');
    expect(mentionRouterSource).toContain("runTodayRecapTurn");
    expect(mentionRouterSource).toContain("buildTodayRecapPrompt");
    expect(mentionRouterSource).toContain("extractLatestAssistantText");
    expect(mentionRouterSource).toContain("updateOriginalWebhookMessage");
    expect(mentionRouterSource).not.toContain("openTodayRecapThread");
    expect(mentionRouterSource).not.toContain("rest.createThread(input.projectChannelId");
  });
});

describe("shouldShowThreadBootstrapReaction", () => {
  it("marks channel prompts that need a Discord/T3 thread bootstrap", () => {
    expect(
      shouldShowThreadBootstrapReaction({
        inThread: false,
        intentKind: "prompt",
        hasPromptOrAttachment: true,
      }),
    ).toBe(true);
    expect(
      shouldShowThreadBootstrapReaction({
        inThread: false,
        intentKind: "today-recap",
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

  effectIt.effect("retries transient failures without allowing overtaking", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const queue = yield* makeDiscordMessageDispatchQueue([0, 0]);
        const attempts = yield* Ref.make(0);
        const handled = yield* Ref.make<ReadonlyArray<string>>([]);
        const transient = { reason: { _tag: "TransportError" } };

        yield* queue.enqueue({
          channelId: "channel-a",
          handle: Ref.updateAndGet(attempts, (value) => value + 1).pipe(
            Effect.flatMap((attempt) =>
              attempt < 3 ? Effect.fail(transient) : Ref.update(handled, (v) => [...v, "first"]),
            ),
          ),
        });
        yield* queue.enqueue({
          channelId: "channel-a",
          handle: Ref.update(handled, (values) => [...values, "second"]),
        });
        yield* queue.drainKey("channel-a");

        expect(yield* Ref.get(attempts)).toBe(3);
        expect(yield* Ref.get(handled)).toEqual(["first", "second"]);
      }),
    ),
  );

  effectIt.effect("drops a permanent failure and continues the channel queue", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const queue = yield* makeDiscordMessageDispatchQueue([0, 0]);
        const handled = yield* Ref.make<ReadonlyArray<string>>([]);

        yield* queue.enqueue({
          channelId: "channel-a",
          handle: Effect.fail({ _tag: "ErrorResponse", response: { status: 404 } }),
        });
        yield* queue.enqueue({
          channelId: "channel-a",
          handle: Ref.update(handled, (values) => [...values, "after-deletion"]),
        });
        yield* queue.drainKey("channel-a");

        expect(yield* Ref.get(handled)).toEqual(["after-deletion"]);
      }),
    ),
  );

  effectIt.effect("contains defects so they cannot strand later channel work", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const queue = yield* makeDiscordMessageDispatchQueue([]);
        const handled = yield* Ref.make(false);
        yield* queue.enqueue({ channelId: "channel-a", handle: Effect.die("broken handler") });
        yield* queue.enqueue({ channelId: "channel-a", handle: Ref.set(handled, true) });
        yield* queue.drainKey("channel-a");
        expect(yield* Ref.get(handled)).toBe(true);
      }),
    ),
  );
});

describe("isTransientDiscordDispatchError", () => {
  it("distinguishes retryable transport/server errors from permanent Discord responses", () => {
    expect(isTransientDiscordDispatchError({ reason: { _tag: "TransportError" } })).toBe(true);
    expect(isTransientDiscordDispatchError({ response: { status: 503 } })).toBe(true);
    expect(isTransientDiscordDispatchError({ _tag: "RatelimitedResponse" })).toBe(true);
    expect(
      isTransientDiscordDispatchError({ _tag: "ErrorResponse", response: { status: 404 } }),
    ).toBe(false);
    expect(
      isTransientDiscordDispatchError({ _tag: "ErrorResponse", response: { status: 403 } }),
    ).toBe(false);
  });
});

describe("retryTransientDiscordOperation", () => {
  effectIt.effect("replays a transient operation but never replays a permanent one", () =>
    Effect.gen(function* () {
      const transientAttempts = yield* Ref.make(0);
      const value = yield* retryTransientDiscordOperation(
        Ref.updateAndGet(transientAttempts, (attempt) => attempt + 1).pipe(
          Effect.flatMap((attempt) =>
            attempt === 1
              ? Effect.fail({ response: { status: 503 } })
              : Effect.succeed("recovered"),
          ),
        ),
        [0],
      );
      expect(value).toBe("recovered");
      expect(yield* Ref.get(transientAttempts)).toBe(2);

      const permanentAttempts = yield* Ref.make(0);
      yield* retryTransientDiscordOperation(
        Ref.update(permanentAttempts, (attempt) => attempt + 1).pipe(
          Effect.andThen(Effect.fail({ response: { status: 404 } })),
        ),
        [0, 0],
      ).pipe(Effect.flip);
      expect(yield* Ref.get(permanentAttempts)).toBe(1);
    }),
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
