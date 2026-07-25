import { MessageId, TurnId, type VcsStatusResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  activeStreamTipIdsForDelivery,
  activeStreamTipText,
  assistantMessagesThisTurn,
  bridgeNeedsHttpReconcile,
  isDeliveryBehindOrchestration,
  isStreamTipDisplacedByForeignMessage,
  isDiscordContentMessageType,
  pickLatestContentMessageId,
  deliveryFailureBackoffSeconds,
  shouldRetryDeliveryFailure,
  BRIDGE_DELIVERY_FAILURE_MAX_RETRIES,
  findAlreadyPostedFinalChunkIds,
  isAssistantAlreadyFinalizedOnDiscord,
  normalizeDiscordContentForIdempotency,
  resolveSubscribeAfterSequence,
  resolveThreadSubscribeSeed,
  trimOrchestrationThreadForDiscordMemory,
  DISCORD_DELIVERED_MESSAGE_MEMORY_BUFFER,
  SUBSCRIBE_SEQUENCE_BUFFER,
  classifyUserMessageIngress,
  DISCORD_EXTERNAL_ECHO_SURFACES,
  discordBridgeOwnedMessageIds,
  externalUserMessagesToEcho,
  isDiscordOriginatedUserPrompt,
  isDiscordTasksSidePostContent,
  isGitHubOriginatedUserPrompt,
  isInternalAgentScaffoldingUserText,
  shouldEchoUserMessageToDiscord,
  shouldSuppressExternalUserEcho,
  firstSnapshotBridgeAction,
  pickLatestContentMessage,
  nextBridgeStateAfterAdoptWorkingAck,
  planStreamTipFreezeOnDisplacement,
  resolveThreadTitleChangeRequestFromStatus,
  rewriteInlinePathCodeSpansForDiscord,
  rewriteMarkdownLocalFileLinksForDiscord,
  resolveTaskMessageAction,
  seedStreamMessageIds,
  shouldArchiveStreamHistory,
  shouldDropSeededWorkingAckOnInitialSnapshot,
  shouldHoldFreshWorkingAck,
  shouldPreserveStreamTipsOnBridgeStop,
  shouldPublishRehydrateResumeTip,
  shouldRecreateStreamTipOnUpdateFailure,
  shouldSkipAlreadyDeliveredAssistant,
  shouldReopenFinalizedDelivery,
  shouldPublishAssistantUpdate,
  startsNewStreamDelivery,
  streamTipBodyForHeartbeat,
  finalAnswerText,
  parseDiscordThreadTitleBadgeState,
  parseDiscordThreadTitleBadges,
  resolveDiscordThreadActivityBadgeState,
  resolveDiscordThreadTitleBadgeState,
  resolveDiscordThreadTitleBadges,
  resolveDiscordTitlePrEvidence,
  resolveSettledDiscordThreadTitleUpgrade,
  resolveTemporaryDiscordThreadTitleBadge,
  resolveThreadChangeRequestLookupCwds,
  mergeStickyTitlePr,
  nextMirroredThreadTitleAfterApply,
  planDiscordThreadTitleApply,
  shouldApplyDiscordThreadPrBadge,
  shouldApplyDiscordThreadTitleBadge,
  shouldConvertWorkingTipsToWakeUp,
  summarizeExternalUserInput,
  threadTitleChangeRequestState,
  toStickyTitlePrEvidence,
} from "./ResponseBridge.ts";

const asMessageId = (value: string): MessageId => MessageId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);
const assistantMessage = (
  id = "assistant-1",
  overrides?: Partial<{
    readonly text: string;
    readonly turnId: TurnId | null;
  }>,
) => ({
  id: asMessageId(id),
  role: "assistant" as const,
  text: overrides?.text ?? "",
  turnId: overrides?.turnId === undefined ? null : overrides.turnId,
  streaming: false,
  createdAt: "2026-07-19T00:00:00.000Z",
  updatedAt: "2026-07-19T00:00:00.000Z",
});
const userMessage = (id: string) => ({
  id: asMessageId(id),
  role: "user" as const,
  text: "follow-up",
  turnId: null,
  streaming: false,
  createdAt: "2026-07-19T00:00:00.000Z",
  updatedAt: "2026-07-19T00:00:00.000Z",
});

const statusWithPr = (overrides?: Partial<VcsStatusResult>): VcsStatusResult => ({
  isRepo: true,
  hasPrimaryRemote: true,
  isDefaultRef: false,
  refName: "feature/thread-title",
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
  hasUpstream: true,
  aheadCount: 0,
  behindCount: 0,
  aheadOfDefaultCount: 0,
  pr: {
    number: 42,
    title: "Thread title badges",
    state: "merged",
    headRef: "feature/thread-title",
    baseRef: "main",
    url: "https://github.com/acme/widgets/pull/42",
  },
  ...overrides,
});

describe("finalAnswerText", () => {
  const threadWithTurnBubbles = (texts: ReadonlyArray<string>) => {
    const turnId = asTurnId("turn-answer");
    return {
      latestTurn: {
        turnId,
        state: "completed" as const,
        requestedAt: "2026-07-20T09:00:00.000Z",
        startedAt: "2026-07-20T09:00:00.000Z",
        completedAt: "2026-07-20T09:10:00.000Z",
        assistantMessageId: asMessageId(`assistant-${texts.length - 1}`),
      },
      session: null,
      messages: [
        userMessage("user-1"),
        ...texts.map((text, index) => assistantMessage(`assistant-${index}`, { text, turnId })),
      ],
    };
  };

  it("prefers a substantial last bubble over an earlier longer Findings (draft PR case)", () => {
    const findings = "A".repeat(2811);
    const draftPr =
      "**Draft PR:** https://github.com/example-org/scanner/pull/1950\n\n" +
      "### Approach\n" +
      "B".repeat(900);
    expect(finalAnswerText(threadWithTurnBubbles([findings, draftPr]) as never)).toBe(draftPr);
  });

  it("keeps long Findings when the last bubble is only a short trailer", () => {
    const findings = "Findings:\n" + "C".repeat(3200);
    const trailer = "Done.";
    expect(finalAnswerText(threadWithTurnBubbles([findings, trailer]) as never)).toBe(findings);
  });

  it("returns the only bubble when the turn has a single answer", () => {
    const only = "**Draft PR:** https://example.com/pull/1";
    expect(finalAnswerText(threadWithTurnBubbles([only]) as never)).toBe(only);
  });
});

describe("assistantMessagesThisTurn", () => {
  it("keeps pre-steer assistant progress when a mid-turn user message arrives", () => {
    const turnId = asTurnId("turn-1");
    const preSteer = assistantMessage("assistant-pre", {
      text: "long pre-steer findings…",
      turnId,
    });
    const postSteer = assistantMessage("assistant-post", {
      text: "ack of follow-up",
      turnId,
    });
    const thread = {
      latestTurn: {
        turnId,
        state: "running" as const,
        requestedAt: "2026-07-19T00:00:00.000Z",
        startedAt: "2026-07-19T00:00:00.000Z",
        completedAt: null,
        assistantMessageId: asMessageId("assistant-post"),
      },
      session: {
        threadId: "thread-1" as never,
        status: "running" as const,
        providerName: "codex",
        runtimeMode: "default" as const,
        activeTurnId: turnId,
        lastError: null,
        updatedAt: "2026-07-19T00:00:00.000Z",
      },
      messages: [userMessage("user-1"), preSteer, userMessage("user-steer"), postSteer],
    };

    // Heuristic "after last user" would drop preSteer; turnId matching keeps it.
    expect(assistantMessagesThisTurn(thread as never).map((message) => message.id)).toEqual([
      asMessageId("assistant-pre"),
      asMessageId("assistant-post"),
    ]);
  });

  it("falls back to after-last-user when turn ids are missing", () => {
    const pre = assistantMessage("assistant-old", { text: "old" });
    const post = assistantMessage("assistant-new", { text: "new" });
    const thread = {
      latestTurn: null,
      session: null,
      messages: [userMessage("user-1"), pre, userMessage("user-2"), post],
    };
    expect(assistantMessagesThisTurn(thread as never).map((message) => message.id)).toEqual([
      asMessageId("assistant-new"),
    ]);
  });

  it("returns empty for a new turn with no assistants yet (does not reuse prior turn bubbles)", () => {
    const turn1 = asTurnId("turn-1");
    const turn2 = asTurnId("turn-2");
    const priorAnswer = assistantMessage("assistant-prior", {
      text: "Mako Demo is live with the fix…",
      turnId: turn1,
    });
    const thread = {
      latestTurn: {
        turnId: turn2,
        state: "running" as const,
        requestedAt: "2026-07-21T08:30:00.000Z",
        startedAt: "2026-07-21T08:30:00.000Z",
        completedAt: null,
        assistantMessageId: null,
      },
      session: {
        threadId: "thread-1" as never,
        status: "running" as const,
        providerName: "codex",
        runtimeMode: "default" as const,
        activeTurnId: turn2,
        lastError: null,
        updatedAt: "2026-07-21T08:30:00.000Z",
      },
      messages: [
        userMessage("user-1"),
        priorAnswer,
        userMessage("user-2"), // "so we good, don't care about gist"
      ],
    };

    expect(assistantMessagesThisTurn(thread as never)).toEqual([]);
    expect(finalAnswerText(thread as never)).toBe("");
  });
});

describe("seedStreamMessageIds", () => {
  it("keeps persisted stream tips active instead of marking them stale", () => {
    expect(
      seedStreamMessageIds({
        workingAckMessageId: "ack-new",
        persistedStreamMessageIds: ["tip-1", "tip-2"],
      }),
    ).toEqual({
      discordMessageIds: ["tip-1", "tip-2", "ack-new"],
      staleStreamMessageIds: [],
      orphanTipIdsToDelete: [],
    });
  });

  it("dedupes when the working ack is already persisted", () => {
    expect(
      seedStreamMessageIds({
        workingAckMessageId: "tip-2",
        persistedStreamMessageIds: ["tip-1", "tip-2"],
      }),
    ).toEqual({
      discordMessageIds: ["tip-1", "tip-2"],
      staleStreamMessageIds: [],
      orphanTipIdsToDelete: [],
    });
  });

  it("works with no working ack", () => {
    expect(
      seedStreamMessageIds({
        workingAckMessageId: null,
        persistedStreamMessageIds: ["tip-1"],
      }),
    ).toEqual({
      discordMessageIds: ["tip-1"],
      staleStreamMessageIds: [],
      orphanTipIdsToDelete: [],
    });
  });

  it("discards persisted tips on a fresh Working turn so old bodies are not reused", () => {
    expect(
      seedStreamMessageIds({
        workingAckMessageId: "ack-new",
        persistedStreamMessageIds: ["tip-1", "tip-2"],
        discardPersistedTips: true,
      }),
    ).toEqual({
      discordMessageIds: ["ack-new"],
      staleStreamMessageIds: [],
      orphanTipIdsToDelete: ["tip-1", "tip-2"],
    });
  });

  it("does not discard persisted tips without a fresh Working ack", () => {
    expect(
      seedStreamMessageIds({
        workingAckMessageId: null,
        persistedStreamMessageIds: ["tip-1"],
        discardPersistedTips: true,
      }),
    ).toEqual({
      discordMessageIds: ["tip-1"],
      staleStreamMessageIds: [],
      orphanTipIdsToDelete: [],
    });
  });
});

describe("activeStreamTipText", () => {
  it("returns full text when there is no break", () => {
    expect(activeStreamTipText("hello world", "")).toBe("hello world");
  });

  it("returns only the suffix after a frozen break prefix", () => {
    expect(activeStreamTipText("hello world\n\nmore", "hello world")).toBe("more");
  });

  it("falls back to full text when progress no longer starts with the prefix", () => {
    expect(activeStreamTipText("rewritten", "hello")).toBe("rewritten");
  });
});

describe("firstSnapshotBridgeAction", () => {
  it("rehydrates a running turn even when the stream looks like it is still streaming", () => {
    // Historical bug: isAssistantStreaming is true for any running turn, so
    // gating on !streaming made rehydrate-resume dead code.
    expect(
      firstSnapshotBridgeAction({
        mode: "rehydrate",
        turnInProgress: true,
        hasContent: true,
        alreadyFinalizedOnDiscord: false,
        hasOpenTips: true,
      }),
    ).toBe("rehydrate-resume");
  });

  it("catch-up finalizes offline-completed turns with open tips", () => {
    expect(
      firstSnapshotBridgeAction({
        mode: "rehydrate",
        turnInProgress: false,
        hasContent: true,
        alreadyFinalizedOnDiscord: true,
        hasOpenTips: true,
      }),
    ).toBe("catch-up-finalize");
  });

  it("adopts completed assistants without re-post on interactive open", () => {
    expect(
      firstSnapshotBridgeAction({
        mode: "interactive",
        turnInProgress: false,
        hasContent: true,
        alreadyFinalizedOnDiscord: true,
        hasOpenTips: false,
      }),
    ).toBe("adopt-completed");
  });
});

describe("shouldDropSeededWorkingAckOnInitialSnapshot", () => {
  it("keeps the pre-posted working marker through the first prior-completed snapshot", () => {
    expect(
      shouldDropSeededWorkingAckOnInitialSnapshot({
        adoptedInitialSnapshot: false,
        seededWorkingAckPending: true,
        streaming: false,
        turnInProgress: false,
      }),
    ).toBe(false);
  });

  it("keeps the working marker once the new turn is actually running", () => {
    expect(
      shouldDropSeededWorkingAckOnInitialSnapshot({
        adoptedInitialSnapshot: false,
        seededWorkingAckPending: true,
        streaming: true,
        turnInProgress: true,
      }),
    ).toBe(false);
  });

  it("does not re-run after the initial snapshot has already been adopted", () => {
    expect(
      shouldDropSeededWorkingAckOnInitialSnapshot({
        adoptedInitialSnapshot: true,
        seededWorkingAckPending: true,
        streaming: false,
        turnInProgress: false,
      }),
    ).toBe(false);
  });
});

describe("shouldReopenFinalizedDelivery", () => {
  it("reopens when the same turn emits a new assistant segment after finalize", () => {
    expect(
      shouldReopenFinalizedDelivery({
        finalizedTurnId: "turn-1",
        currentAssistantMessageId: "assistant-1",
        turnId: "turn-1",
        nextAssistantMessageId: "assistant-2",
      }),
    ).toBe(true);
  });

  it("keeps duplicate snapshots of the finalized assistant closed", () => {
    expect(
      shouldReopenFinalizedDelivery({
        finalizedTurnId: "turn-1",
        currentAssistantMessageId: "assistant-1",
        turnId: "turn-1",
        nextAssistantMessageId: "assistant-1",
      }),
    ).toBe(false);
  });
});

describe("resolveTaskMessageAction", () => {
  it("updates the persisted task message when tasks change across turns", () => {
    expect(
      resolveTaskMessageAction({
        taskDiscordMessageId: "task-message-1",
        lastTasksKey: "old-turn-tasks",
        nextTasksKey: "new-turn-tasks",
      }),
    ).toBe("update");
  });

  it("creates only when no task message has ever been persisted", () => {
    expect(
      resolveTaskMessageAction({
        taskDiscordMessageId: null,
        lastTasksKey: "",
        nextTasksKey: "first-tasks",
      }),
    ).toBe("create");
  });

  it("skips unchanged task content", () => {
    expect(
      resolveTaskMessageAction({
        taskDiscordMessageId: "task-message-1",
        lastTasksKey: "same-tasks",
        nextTasksKey: "same-tasks",
      }),
    ).toBe("skip");
  });
});

describe("Discord Tasks side-channel (special treatment)", () => {
  it("never classifies Tasks side-post bodies as external-echoable user input", () => {
    const tasksBody = "**Tasks 1/3**\n◐ Fix the bridge\n○ Add tests\n✅ Ship it";
    expect(isDiscordTasksSidePostContent(tasksBody)).toBe(true);
    expect(classifyUserMessageIngress(tasksBody)).toBe("internal");
    expect(
      shouldEchoUserMessageToDiscord({
        text: tasksBody,
        messageId: "t1",
        seenUserMessageIds: [],
        sentDiscordUserMessageIds: [],
      }),
    ).toBe(false);
  });

  it("includes taskDiscordMessageId among owned ids so Tasks never freeze Working", () => {
    const owned = discordBridgeOwnedMessageIds({
      discordMessageIds: ["working-tip"],
      taskDiscordMessageId: "tasks-msg",
      infoDiscordMessageId: "info-pin",
    });
    expect(owned).toContain("tasks-msg");
    expect(owned).toContain("working-tip");
    expect(
      isStreamTipDisplacedByForeignMessage({
        latestMessageId: "tasks-msg",
        streamTipId: "working-tip",
        ownedMessageIds: owned,
        latestAuthorIsSelfBot: false,
      }),
    ).toBe(false);
  });
});

describe("shouldPublishAssistantUpdate", () => {
  it("suppresses only live progress in final-only mode", () => {
    expect(shouldPublishAssistantUpdate({ presentationMode: "final-only", streaming: true })).toBe(
      false,
    );
    expect(shouldPublishAssistantUpdate({ presentationMode: "final-only", streaming: false })).toBe(
      true,
    );
  });

  it("keeps live progress in full mode", () => {
    expect(shouldPublishAssistantUpdate({ presentationMode: "full", streaming: true })).toBe(true);
  });
});

describe("isStreamTipDisplacedByForeignMessage / content message types", () => {
  it("treats Default and Reply as content; channel rename/pin as system", () => {
    expect(isDiscordContentMessageType(0)).toBe(true);
    expect(isDiscordContentMessageType(19)).toBe(true);
    expect(isDiscordContentMessageType(undefined)).toBe(true);
    expect(isDiscordContentMessageType(4)).toBe(false); // CHANNEL_NAME_CHANGE
    expect(isDiscordContentMessageType(6)).toBe(false); // CHANNEL_PINNED_MESSAGE
  });

  it("picks the latest content message, skipping channel renames", () => {
    // newest-first
    expect(
      pickLatestContentMessageId([
        { id: "rename-2", type: 4 },
        { id: "rename-1", type: 4 },
        { id: "tip-1", type: 0 },
        { id: "older", type: 0 },
      ]),
    ).toBe("tip-1");
  });

  it("is not displaced when the tip is still the channel tip", () => {
    expect(
      isStreamTipDisplacedByForeignMessage({
        latestMessageId: "tip-1",
        streamTipId: "tip-1",
        ownedMessageIds: ["task-1"],
      }),
    ).toBe(false);
  });

  it("is not displaced when latest is a live Tasks message (bot-owned)", () => {
    expect(
      isStreamTipDisplacedByForeignMessage({
        latestMessageId: "task-1",
        streamTipId: "tip-1",
        ownedMessageIds: ["task-1", "tip-1"],
      }),
    ).toBe(false);
  });

  it("is displaced when a human message is newer than the tip", () => {
    expect(
      isStreamTipDisplacedByForeignMessage({
        latestMessageId: "user-1",
        streamTipId: "tip-1",
        ownedMessageIds: ["task-1", "tip-1"],
      }),
    ).toBe(true);
  });

  it("is not displaced when latest is another owned stream chunk", () => {
    expect(
      isStreamTipDisplacedByForeignMessage({
        latestMessageId: "tip-2",
        streamTipId: "tip-1",
        ownedMessageIds: ["tip-1", "tip-2"],
      }),
    ).toBe(false);
  });
});

describe("shouldArchiveStreamHistory", () => {
  it("never archives progress for final-only conversational turns", () => {
    expect(
      shouldArchiveStreamHistory({
        presentationMode: "final-only",
        hasStreamMessages: true,
      }),
    ).toBe(false);
  });

  it("archives tracked progress in full mode", () => {
    expect(shouldArchiveStreamHistory({ presentationMode: "full", hasStreamMessages: true })).toBe(
      true,
    );
  });
});

describe("finalize accept-without-ack idempotency", () => {
  it("normalizes Working markers and whitespace", () => {
    expect(normalizeDiscordContentForIdempotency("Hello\n\n_Working.._\n")).toBe("Hello");
    expect(normalizeDiscordContentForIdempotency("  a   b  ")).toBe("a b");
  });

  it("finds contiguous bot final chunks among recent messages", () => {
    const ids = findAlreadyPostedFinalChunkIds({
      botUserId: "bot",
      finalChunks: ["Part one", "Part two"],
      // newest first (Discord listMessages order)
      recentMessages: [
        { id: "m3", authorId: "bot", content: "Part two" },
        { id: "m2", authorId: "bot", content: "Part one" },
        { id: "m1", authorId: "user", content: "hi" },
      ],
    });
    expect(ids).toEqual(["m2", "m3"]);
  });

  it("returns null when chunks are incomplete or in the wrong order", () => {
    expect(
      findAlreadyPostedFinalChunkIds({
        botUserId: "bot",
        finalChunks: ["Part one", "Part two"],
        recentMessages: [{ id: "m1", authorId: "bot", content: "Part one" }],
      }),
    ).toBeNull();
    // Wrong chronological order among bot messages (two then one).
    expect(
      findAlreadyPostedFinalChunkIds({
        botUserId: "bot",
        finalChunks: ["Part one", "Part two"],
        recentMessages: [
          { id: "m2", authorId: "bot", content: "Part one" },
          { id: "m1", authorId: "bot", content: "Part two" },
        ],
      }),
    ).toBeNull();
  });

  it("ignores human messages between bot final chunks when bot order is correct", () => {
    expect(
      findAlreadyPostedFinalChunkIds({
        botUserId: "bot",
        finalChunks: ["Part one", "Part two"],
        recentMessages: [
          { id: "m3", authorId: "bot", content: "Part two" },
          { id: "m-x", authorId: "user", content: "interrupt" },
          { id: "m2", authorId: "bot", content: "Part one" },
        ],
      }),
    ).toEqual(["m2", "m3"]);
  });

  it("excludes stream tip ids from adoption", () => {
    expect(
      findAlreadyPostedFinalChunkIds({
        botUserId: "bot",
        finalChunks: ["Answer"],
        excludeMessageIds: ["tip-1"],
        recentMessages: [
          { id: "tip-1", authorId: "bot", content: "Answer" },
          { id: "final-1", authorId: "bot", content: "Answer" },
        ],
      }),
    ).toEqual(["final-1"]);
  });

  it("detects durable or in-memory finalize markers", () => {
    expect(
      isAssistantAlreadyFinalizedOnDiscord({
        assistantId: "a1",
        finalizedTurnId: "t1",
        turnId: "t1",
        lastFinalizedAssistantId: null,
        durableLastFinalizedAssistantId: null,
      }),
    ).toBe(true);
    expect(
      isAssistantAlreadyFinalizedOnDiscord({
        assistantId: "a1",
        finalizedTurnId: null,
        turnId: "t1",
        lastFinalizedAssistantId: null,
        durableLastFinalizedAssistantId: "a1",
      }),
    ).toBe(true);
    expect(
      isAssistantAlreadyFinalizedOnDiscord({
        assistantId: "a1",
        finalizedTurnId: null,
        turnId: "t1",
        lastFinalizedAssistantId: null,
        durableLastFinalizedAssistantId: "a0",
      }),
    ).toBe(false);
  });
});

describe("trimOrchestrationThreadForDiscordMemory", () => {
  const thread = (messageIds: ReadonlyArray<string>) =>
    ({
      id: "t1",
      messages: messageIds.map((id) => ({
        id,
        role: id.startsWith("u") ? "user" : "assistant",
        text: id,
        turnId: null,
      })),
    }) as unknown as Parameters<typeof trimOrchestrationThreadForDiscordMemory>[0]["thread"];

  it("keeps full transcript when nothing is finalized", () => {
    const input = thread(["u1", "a1", "u2", "a2"]);
    expect(
      trimOrchestrationThreadForDiscordMemory({
        thread: input,
        lastFinalizedAssistantId: null,
      }).messages.map((m) => m.id),
    ).toEqual(["u1", "a1", "u2", "a2"]);
  });

  it("drops messages before finalize watermark minus buffer", () => {
    const input = thread(["u0", "a0", "u1", "a1", "u2", "a2"]);
    expect(
      trimOrchestrationThreadForDiscordMemory({
        thread: input,
        lastFinalizedAssistantId: "a1",
        buffer: DISCORD_DELIVERED_MESSAGE_MEMORY_BUFFER,
      }).messages.map((m) => m.id),
    ).toEqual(["a0", "u1", "a1", "u2", "a2"]);
  });
});

describe("resolveThreadSubscribeSeed", () => {
  const warmThread = { id: "t1", messages: [] } as never;
  it("prefers warm cache over HTTP", () => {
    expect(
      resolveThreadSubscribeSeed({
        warm: { snapshotSequence: 50, thread: warmThread },
        afterSequence: 40,
      }),
    ).toEqual({ kind: "warm", thread: warmThread, afterSequence: 50 });
  });

  it("falls back to HTTP when warm is missing", () => {
    expect(
      resolveThreadSubscribeSeed({
        warm: null,
        afterSequence: 40,
      }),
    ).toEqual({ kind: "http", afterSequence: 40 });
  });

  it("is cold when neither seed is available", () => {
    expect(resolveThreadSubscribeSeed({ warm: null, afterSequence: null })).toEqual({
      kind: "cold",
    });
  });
});

describe("deliveryFailureBackoffSeconds / shouldRetryDeliveryFailure", () => {
  it("backs off exponentially and caps at 30s", () => {
    expect(deliveryFailureBackoffSeconds(1)).toBe(2);
    expect(deliveryFailureBackoffSeconds(2)).toBe(4);
    expect(deliveryFailureBackoffSeconds(3)).toBe(8);
    expect(deliveryFailureBackoffSeconds(4)).toBe(16);
    expect(deliveryFailureBackoffSeconds(5)).toBe(30);
    expect(deliveryFailureBackoffSeconds(10)).toBe(30);
  });

  it("retries up to the max then stops", () => {
    expect(shouldRetryDeliveryFailure({ failureCount: 1 })).toBe(true);
    expect(
      shouldRetryDeliveryFailure({
        failureCount: BRIDGE_DELIVERY_FAILURE_MAX_RETRIES,
      }),
    ).toBe(true);
    expect(
      shouldRetryDeliveryFailure({
        failureCount: BRIDGE_DELIVERY_FAILURE_MAX_RETRIES + 1,
      }),
    ).toBe(false);
  });
});

describe("isDeliveryBehindOrchestration", () => {
  it("is not lagging when neither cursor is set", () => {
    expect(
      isDeliveryBehindOrchestration({
        lastDeliveredSequence: null,
        lastThreadSnapshotSequence: null,
      }),
    ).toBe(false);
  });

  it("does not treat unknown delivery cursor as lag (legacy links / first write)", () => {
    expect(
      isDeliveryBehindOrchestration({
        lastDeliveredSequence: null,
        lastThreadSnapshotSequence: 10,
      }),
    ).toBe(false);
  });

  it("lags when delivery sequence is strictly behind orchestration", () => {
    expect(
      isDeliveryBehindOrchestration({
        lastDeliveredSequence: 5,
        lastThreadSnapshotSequence: 10,
      }),
    ).toBe(true);
  });

  it("is caught up when cursors match", () => {
    expect(
      isDeliveryBehindOrchestration({
        lastDeliveredSequence: 10,
        lastThreadSnapshotSequence: 10,
      }),
    ).toBe(false);
  });

  it("is caught up when delivery is ahead (HTTP seed race)", () => {
    expect(
      isDeliveryBehindOrchestration({
        lastDeliveredSequence: 12,
        lastThreadSnapshotSequence: 10,
      }),
    ).toBe(false);
  });
});

describe("resolveSubscribeAfterSequence", () => {
  it("returns null when no durable cursors exist (cold subscribe)", () => {
    expect(
      resolveSubscribeAfterSequence({
        lastDeliveredSequence: null,
        lastThreadSnapshotSequence: null,
      }),
    ).toBeNull();
  });

  it("prefers delivery cursor so already-synced events are not re-walked", () => {
    expect(
      resolveSubscribeAfterSequence({
        lastDeliveredSequence: 100,
        lastThreadSnapshotSequence: 150,
        buffer: 2,
      }),
    ).toBe(98);
  });

  it("falls back to orchestration cursor when delivery is unknown", () => {
    expect(
      resolveSubscribeAfterSequence({
        lastDeliveredSequence: null,
        lastThreadSnapshotSequence: 40,
        buffer: 2,
      }),
    ).toBe(38);
  });

  it("does not go below zero when buffer exceeds the anchor", () => {
    expect(
      resolveSubscribeAfterSequence({
        lastDeliveredSequence: 1,
        lastThreadSnapshotSequence: 1,
        buffer: 5,
      }),
    ).toBe(0);
  });

  it("uses the default buffer when omitted", () => {
    expect(
      resolveSubscribeAfterSequence({
        lastDeliveredSequence: 10,
        lastThreadSnapshotSequence: 10,
      }),
    ).toBe(10 - SUBSCRIBE_SEQUENCE_BUFFER);
  });
});

describe("bridgeNeedsHttpReconcile", () => {
  const idle = {
    openStreamTipCount: 0,
    seededWorkingAckPending: false,
    turnInProgress: false,
    awaitingDiscordFinal: false,
  };

  it("is idle when nothing is outstanding", () => {
    expect(bridgeNeedsHttpReconcile(idle)).toBe(false);
  });

  it("reconciles while Working tips are open (stuck Working recovery)", () => {
    expect(bridgeNeedsHttpReconcile({ ...idle, openStreamTipCount: 1 })).toBe(true);
  });

  it("reconciles while a fresh Working ack is pending", () => {
    expect(bridgeNeedsHttpReconcile({ ...idle, seededWorkingAckPending: true })).toBe(true);
  });

  it("reconciles while the T3 turn is still running", () => {
    expect(bridgeNeedsHttpReconcile({ ...idle, turnInProgress: true })).toBe(true);
  });

  it("reconciles until Discord has finalized a Discord-originated turn", () => {
    expect(bridgeNeedsHttpReconcile({ ...idle, awaitingDiscordFinal: true })).toBe(true);
  });

  it("reconciles when dual-cursor delivery lags orchestration", () => {
    expect(bridgeNeedsHttpReconcile({ ...idle, deliveryLagging: true })).toBe(true);
  });
});

describe("shouldPreserveStreamTipsOnBridgeStop", () => {
  it("preserves tips when the turn is still running", () => {
    expect(
      shouldPreserveStreamTipsOnBridgeStop({ turnInProgress: true, openStreamTipCount: 1 }),
    ).toBe(true);
  });

  it("does not preserve when the turn is idle (safe to clear leftovers)", () => {
    expect(
      shouldPreserveStreamTipsOnBridgeStop({ turnInProgress: false, openStreamTipCount: 2 }),
    ).toBe(false);
  });

  it("does not preserve when there are no open tips", () => {
    expect(
      shouldPreserveStreamTipsOnBridgeStop({ turnInProgress: true, openStreamTipCount: 0 }),
    ).toBe(false);
  });
});

describe("streamTipBodyForHeartbeat", () => {
  it("suppresses prior-turn body while a fresh Working ack is pending", () => {
    expect(
      streamTipBodyForHeartbeat({
        seededWorkingAckPending: true,
        lastAssistantText: "previous final answer",
        streamBreakPrefix: "",
      }),
    ).toBe("");
  });

  it("uses current stream body once the Working ack has been claimed by a stream write", () => {
    expect(
      streamTipBodyForHeartbeat({
        seededWorkingAckPending: false,
        lastAssistantText: "live progress",
        streamBreakPrefix: "",
      }),
    ).toContain("live progress");
  });
});

/**
 * Behaviour contracts for Working-tip lifecycle.
 * These encode the product intent so regressions (prior-turn leak, dark Discord after
 * restart, 10008 tip edits) fail tests instead of only showing up in Discord.
 */
describe("Working tip lifecycle contracts", () => {
  describe("new user turn on reused bridge (no prior-turn leak)", () => {
    it("holds only while Working is pending and the new turn has no assistants yet", () => {
      expect(
        shouldHoldFreshWorkingAck({
          mode: "interactive",
          seededWorkingAckPending: true,
          currentTurnAssistantCount: 0,
        }),
      ).toBe(true);
    });

    it("does not hold once the new turn has assistant content (stream it)", () => {
      expect(
        shouldHoldFreshWorkingAck({
          mode: "interactive",
          seededWorkingAckPending: true,
          currentTurnAssistantCount: 1,
        }),
      ).toBe(false);
    });

    it("does not hold on rehydrate (must catch-up / resume immediately)", () => {
      expect(
        shouldHoldFreshWorkingAck({
          mode: "rehydrate",
          seededWorkingAckPending: true,
          currentTurnAssistantCount: 0,
        }),
      ).toBe(false);
    });

    it("does not hold once stream has claimed the Working ack", () => {
      expect(
        shouldHoldFreshWorkingAck({
          mode: "interactive",
          seededWorkingAckPending: false,
          currentTurnAssistantCount: 0,
        }),
      ).toBe(false);
    });

    it("skips re-post when the latest assistant was already finalized and turn is idle", () => {
      expect(
        shouldSkipAlreadyDeliveredAssistant({
          assistantId: "assistant-prior",
          lastFinalizedAssistantId: "assistant-prior",
          turnInProgress: false,
        }),
      ).toBe(true);
    });

    it("skips the same finalized assistant even while a new turn is running", () => {
      // Time-query race: turnInProgress=true with snapshot still showing prior bubble.
      expect(
        shouldSkipAlreadyDeliveredAssistant({
          assistantId: "assistant-prior",
          lastFinalizedAssistantId: "assistant-prior",
          turnInProgress: true,
        }),
      ).toBe(true);
    });

    it("does not skip a new assistant after the previous one was finalized", () => {
      expect(
        shouldSkipAlreadyDeliveredAssistant({
          assistantId: "assistant-new",
          lastFinalizedAssistantId: "assistant-prior",
          turnInProgress: false,
        }),
      ).toBe(false);
    });

    it("adopt Working ack resets prior body and tip ids to only the new ack", () => {
      const next = nextBridgeStateAfterAdoptWorkingAck({
        priorDiscordMessageIds: ["old-tip-1", "old-tip-2"],
        priorStaleStreamMessageIds: ["stale-a"],
        workingAckMessageId: "new-working-ack",
      });
      expect(next.discordMessageIds).toEqual(["new-working-ack"]);
      expect(next.lastAssistantText).toBe("");
      expect(next.streamBreakPrefix).toBe("");
      expect(next.currentTurnId).toBeNull();
      expect(next.finalizedTurnId).toBeNull();
      expect(next.seededWorkingAckPending).toBe(true);
      // Prior tips are frozen as channel history (not live/stale tips).
      expect(next.orphanTipsToDelete).toEqual(["old-tip-1", "old-tip-2"]);
      expect(next.staleStreamMessageIds).toEqual(["stale-a"]);
    });

    it("mid-turn Working ack adoption freezes old tips and starts a new delivery epoch", () => {
      // Expected Discord UX: old tip loses Working+Stop, new Working appears under
      // the human mid-turn message, stream continues on the new tip only.
      const next = nextBridgeStateAfterAdoptWorkingAck({
        priorDiscordMessageIds: ["working-above-user"],
        priorStaleStreamMessageIds: [],
        workingAckMessageId: "working-below-user",
      });
      expect(next.discordMessageIds).toEqual(["working-below-user"]);
      expect(next.orphanTipsToDelete).toEqual(["working-above-user"]);
      expect(next.seededWorkingAckPending).toBe(true);
      expect(
        startsNewStreamDelivery({
          currentTurnId: "same-turn",
          nextTurnId: "same-turn",
          reopensFinalizedDelivery: false,
          seededWorkingAckPending: next.seededWorkingAckPending,
        }),
      ).toBe(true);
    });

    it("heartbeat never shows previous final answer under a fresh Working ack", () => {
      const previousFinal = "**You are right** — fixed and pushed to PR #99";
      expect(
        streamTipBodyForHeartbeat({
          seededWorkingAckPending: true,
          lastAssistantText: previousFinal,
          streamBreakPrefix: "",
        }),
      ).toBe("");
    });

    it("starts a new stream delivery when Working ack is pending (not mid-turn edit)", () => {
      expect(
        startsNewStreamDelivery({
          currentTurnId: "turn-1",
          nextTurnId: "turn-1",
          reopensFinalizedDelivery: false,
          seededWorkingAckPending: true,
        }),
      ).toBe(true);
    });

    it("starts a new stream delivery when turn id changes", () => {
      expect(
        startsNewStreamDelivery({
          currentTurnId: "turn-1",
          nextTurnId: "turn-2",
          reopensFinalizedDelivery: false,
          seededWorkingAckPending: false,
        }),
      ).toBe(true);
    });

    it("continues the same delivery mid-turn without a fresh Working ack", () => {
      expect(
        startsNewStreamDelivery({
          currentTurnId: "turn-2",
          nextTurnId: "turn-2",
          reopensFinalizedDelivery: false,
          seededWorkingAckPending: false,
        }),
      ).toBe(false);
    });

    it("on new delivery keeps only the newest tip slot (avoids 10008 on prior tips)", () => {
      const tips = activeStreamTipIdsForDelivery({
        startsNewDelivery: true,
        discordMessageIds: ["prior-turn-tip", "fresh-working-ack"],
        staleStreamMessageIds: [],
      });
      expect(tips.discordMessageIds).toEqual(["fresh-working-ack"]);
      expect(tips.staleStreamMessageIds).toEqual(["prior-turn-tip"]);
    });

    it("mid-turn delivery keeps the full tip history for multi-chunk streams", () => {
      const tips = activeStreamTipIdsForDelivery({
        startsNewDelivery: false,
        discordMessageIds: ["chunk-0", "chunk-1"],
        staleStreamMessageIds: ["frozen"],
      });
      expect(tips.discordMessageIds).toEqual(["chunk-0", "chunk-1"]);
      expect(tips.staleStreamMessageIds).toEqual(["frozen"]);
    });
  });

  describe("bot restart / rehydrate while turn still running", () => {
    it("preserves open tips on bridge stop when the turn is in progress", () => {
      expect(
        shouldPreserveStreamTipsOnBridgeStop({
          turnInProgress: true,
          openStreamTipCount: 1,
        }),
      ).toBe(true);
    });

    it("does not treat preserve-on-stop as an excuse to repaint prior final text", () => {
      // Preserve keeps the Discord message id; heartbeat must still not inject old body
      // once a *new* Working ack is pending after the next user message.
      expect(
        shouldPreserveStreamTipsOnBridgeStop({
          turnInProgress: true,
          openStreamTipCount: 1,
        }),
      ).toBe(true);
      expect(
        streamTipBodyForHeartbeat({
          seededWorkingAckPending: true,
          lastAssistantText: "old final from before restart",
          streamBreakPrefix: "",
        }),
      ).toBe("");
    });

    it("rehydrate of a running turn resumes streaming (not catch-up finalize)", () => {
      expect(
        firstSnapshotBridgeAction({
          mode: "rehydrate",
          turnInProgress: true,
          hasContent: false, // tasks-only / tools only — still resume
          alreadyFinalizedOnDiscord: false,
          hasOpenTips: false, // tips may have been wiped
        }),
      ).toBe("rehydrate-resume");
    });

    it("publishes a rehydrate resume tip even with empty progress (Working-only)", () => {
      expect(
        shouldPublishRehydrateResumeTip({
          presentationMode: "full",
          turnInProgress: true,
        }),
      ).toBe(true);
    });

    it("does not publish rehydrate resume tips in final-only presentation", () => {
      expect(
        shouldPublishRehydrateResumeTip({
          presentationMode: "final-only",
          turnInProgress: true,
        }),
      ).toBe(false);
    });

    it("catch-up finalizes when the turn completed offline with open tips", () => {
      expect(
        firstSnapshotBridgeAction({
          mode: "rehydrate",
          turnInProgress: false,
          hasContent: true,
          alreadyFinalizedOnDiscord: false,
          hasOpenTips: true,
        }),
      ).toBe("catch-up-finalize");
    });

    it("HTTP reconcile stays armed while Working tips are open or turn is running", () => {
      expect(
        bridgeNeedsHttpReconcile({
          openStreamTipCount: 1,
          seededWorkingAckPending: false,
          turnInProgress: false,
          awaitingDiscordFinal: false,
        }),
      ).toBe(true);
      expect(
        bridgeNeedsHttpReconcile({
          openStreamTipCount: 0,
          seededWorkingAckPending: false,
          turnInProgress: true,
          awaitingDiscordFinal: false,
        }),
      ).toBe(true);
    });
  });

  describe("Discord 10008 Unknown Message on tip update", () => {
    it("recreates the tip when update fails and the turn is still running", () => {
      expect(
        shouldRecreateStreamTipOnUpdateFailure({
          turnInProgress: true,
          updateFailed: true,
        }),
      ).toBe(true);
    });

    it("does not recreate when the turn is idle (avoid ghost Working after settle)", () => {
      expect(
        shouldRecreateStreamTipOnUpdateFailure({
          turnInProgress: false,
          updateFailed: true,
        }),
      ).toBe(false);
    });

    it("does not recreate when the update succeeded", () => {
      expect(
        shouldRecreateStreamTipOnUpdateFailure({
          turnInProgress: true,
          updateFailed: false,
        }),
      ).toBe(false);
    });
  });

  describe("seedStreamMessageIds for fresh vs rehydrate", () => {
    it("fresh Working turn discards persisted prior-turn tip ids as orphans", () => {
      const seeded = seedStreamMessageIds({
        workingAckMessageId: "new-ack",
        persistedStreamMessageIds: ["old-1", "old-2"],
        discardPersistedTips: true,
      });
      expect(seeded.discordMessageIds).toEqual(["new-ack"]);
      expect(seeded.orphanTipIdsToDelete).toEqual(["old-1", "old-2"]);
    });

    it("rehydrate keeps persisted tip ids active so mid-turn resume can edit them", () => {
      const seeded = seedStreamMessageIds({
        workingAckMessageId: null,
        persistedStreamMessageIds: ["running-tip"],
        discardPersistedTips: false,
      });
      expect(seeded.discordMessageIds).toEqual(["running-tip"]);
      expect(seeded.orphanTipIdsToDelete).toEqual([]);
    });
  });
});

describe("rewriteMarkdownLocalFileLinksForDiscord", () => {
  it("rewrites GitHub-backed local file links to GitHub URLs", () => {
    const text =
      "[githubLinks.ts](/var/lib/t3/worktrees/t3code/t3-discord-1dd39f28/apps/discord-bot/src/presentation/githubLinks.ts:96)";
    const rewritten = rewriteMarkdownLocalFileLinksForDiscord({
      text,
      githubUrlsBySrc: new Map([
        [
          "/var/lib/t3/worktrees/t3code/t3-discord-1dd39f28/apps/discord-bot/src/presentation/githubLinks.ts:96",
          "https://github.com/example-org/example-repo/blob/main/apps/discord-bot/src/presentation/githubLinks.ts#L96",
        ],
      ]),
    });
    expect(rewritten).toBe(
      "[githubLinks.ts](https://github.com/example-org/example-repo/blob/main/apps/discord-bot/src/presentation/githubLinks.ts#L96)",
    );
  });

  it("keeps attachment fallback text for non-GitHub local files in final messages", () => {
    const rewritten = rewriteMarkdownLocalFileLinksForDiscord({
      text: "[report.csv](/tmp/report.csv)",
      githubUrlsBySrc: new Map(),
      attachedFileNames: new Set(["report.csv"]),
      oversizedByName: new Set(),
    });
    expect(rewritten).toBe("report.csv (attached below)");
  });

  it("keeps attachable documents as attachments even when source refs become links", () => {
    const rewritten = rewriteMarkdownLocalFileLinksForDiscord({
      text: [
        "[ResponseBridge.ts](/repo/apps/discord-bot/src/features/ResponseBridge.ts:12)",
        "[plan.md](/repo/tmp/plan.md)",
      ].join("\n"),
      githubUrlsBySrc: new Map([
        [
          "/repo/apps/discord-bot/src/features/ResponseBridge.ts:12",
          "https://github.com/example-org/example-repo/blob/main/apps/discord-bot/src/features/ResponseBridge.ts#L12",
        ],
      ]),
      attachedFileNames: new Set(["plan.md"]),
      oversizedByName: new Set(),
    });
    expect(rewritten).toContain(
      "[ResponseBridge.ts](https://github.com/example-org/example-repo/blob/main/apps/discord-bot/src/features/ResponseBridge.ts#L12)",
    );
    expect(rewritten).toContain("plan.md (attached below)");
  });
});

describe("rewriteInlinePathCodeSpansForDiscord", () => {
  it("rewrites inline tracked repo file references to GitHub links", () => {
    const rewritten = rewriteInlinePathCodeSpansForDiscord({
      text: [
        "**Files:** `api/src/EasyLife/Standard/resources/RealPacking.ts:37-44`,",
        "`api/src/EasyLife/Standard/core/packingCompletion.ts:36-45`",
      ].join(" "),
      githubUrlsByToken: new Map([
        [
          "api/src/EasyLife/Standard/resources/RealPacking.ts:37-44",
          "https://github.com/example-org/example-repo/blob/main/api/src/EasyLife/Standard/resources/RealPacking.ts#L37",
        ],
        [
          "api/src/EasyLife/Standard/core/packingCompletion.ts:36-45",
          "https://github.com/example-org/example-repo/blob/main/api/src/EasyLife/Standard/core/packingCompletion.ts#L36",
        ],
      ]),
    });
    expect(rewritten).toContain(
      "[`api/src/EasyLife/Standard/resources/RealPacking.ts:37-44`](https://github.com/example-org/example-repo/blob/main/api/src/EasyLife/Standard/resources/RealPacking.ts#L37)",
    );
    expect(rewritten).toContain(
      "[`api/src/EasyLife/Standard/core/packingCompletion.ts:36-45`](https://github.com/example-org/example-repo/blob/main/api/src/EasyLife/Standard/core/packingCompletion.ts#L36)",
    );
  });

  it("leaves unmatched inline references untouched", () => {
    const text = "**Files:** `tmp/generated-report.html:1-10`";
    expect(
      rewriteInlinePathCodeSpansForDiscord({
        text,
        githubUrlsByToken: new Map(),
      }),
    ).toBe(text);
  });
});

describe("externalUserMessagesToEcho", () => {
  it("includes unseen user messages from other clients", () => {
    const messages = externalUserMessagesToEcho({
      messages: [
        {
          id: MessageId.make("user-1"),
          role: "user",
          text: "sent from github",
          turnId: null,
          streaming: false,
          createdAt: "2026-07-18T00:00:00.000Z",
          updatedAt: "2026-07-18T00:00:00.000Z",
        },
        {
          id: MessageId.make("assistant-1"),
          role: "assistant",
          text: "ack",
          turnId: null,
          streaming: false,
          createdAt: "2026-07-18T00:00:01.000Z",
          updatedAt: "2026-07-18T00:00:01.000Z",
        },
      ],
      observedInitialUserSnapshot: true,
      seenUserMessageIds: [],
      sentDiscordUserMessageIds: [],
    });
    expect(messages.map((message) => message.id)).toEqual(["user-1"]);
  });

  it("suppresses user messages that the Discord bot just sent into T3", () => {
    const messages = externalUserMessagesToEcho({
      messages: [
        {
          id: MessageId.make("user-1"),
          role: "user",
          text: "from discord",
          turnId: null,
          streaming: false,
          createdAt: "2026-07-18T00:00:00.000Z",
          updatedAt: "2026-07-18T00:00:00.000Z",
        },
      ],
      observedInitialUserSnapshot: true,
      seenUserMessageIds: [],
      sentDiscordUserMessageIds: ["user-1"],
    });
    expect(messages).toEqual([]);
  });

  it("suppresses Discord-originated prompts even when sentDiscordUserMessageIds is missing", () => {
    // Regression: idle rehydrate / id mismatch used to echo buildDiscordTurnPrompt
    // back into Discord as External User Input, freeze the Working tip under that
    // bot side-post, and leave the channel desynced while T3 kept working.
    const discordPrompt = `## Discord conversation context
- This turn originated from a Discord thread.

### Current requester
\`\`\`json
{"id":"1"}
\`\`\`

## User request
fix the bridge desync`;
    expect(isDiscordOriginatedUserPrompt(discordPrompt)).toBe(true);
    const messages = externalUserMessagesToEcho({
      messages: [
        {
          id: MessageId.make("user-discord-1"),
          role: "user",
          text: discordPrompt,
          turnId: null,
          streaming: false,
          createdAt: "2026-07-18T00:00:00.000Z",
          updatedAt: "2026-07-18T00:00:00.000Z",
        },
        {
          id: MessageId.make("user-external-1"),
          role: "user",
          text: "plain input from the web app",
          turnId: null,
          streaming: false,
          createdAt: "2026-07-18T00:00:01.000Z",
          updatedAt: "2026-07-18T00:00:01.000Z",
        },
      ],
      observedInitialUserSnapshot: true,
      seenUserMessageIds: [],
      sentDiscordUserMessageIds: [],
    });
    expect(messages.map((message) => message.id)).toEqual(["user-external-1"]);
  });

  it("suppresses system-reminder / background-task scaffolding as external input", () => {
    // Regression: agent harness injects <system-reminder>Background task …</system-reminder>
    // as user-role text; mirroring it as External User Input is noise and freezes tips.
    const systemReminder = `<system-reminder>
Background task "call-caf23c75-09ca-4fc6-a98e-daa9bcaa8e80-41" completed (exit code: 0).
Command: # High-signal PRs for resume/restart/wake continuity
for n in 3677 4229; do gh api "repos/pingdotgg/t3code/pulls/$n"; done
| Duration: 15.2s
Use get_command_or_subagent_output("call-caf23c75-09ca-4fc6-a98e-daa9bcaa8e80-41") to see the full output.
</system-reminder>`;
    expect(isInternalAgentScaffoldingUserText(systemReminder)).toBe(true);
    expect(shouldSuppressExternalUserEcho(systemReminder)).toBe(true);
    const messages = externalUserMessagesToEcho({
      messages: [
        {
          id: MessageId.make("user-sys-1"),
          role: "user",
          text: systemReminder,
          turnId: null,
          streaming: false,
          createdAt: "2026-07-18T00:00:00.000Z",
          updatedAt: "2026-07-18T00:00:00.000Z",
        },
        {
          id: MessageId.make("user-real-1"),
          role: "user",
          text: "please also check PR 42",
          turnId: null,
          streaming: false,
          createdAt: "2026-07-18T00:00:01.000Z",
          updatedAt: "2026-07-18T00:00:01.000Z",
        },
      ],
      observedInitialUserSnapshot: true,
      seenUserMessageIds: [],
      sentDiscordUserMessageIds: [],
    });
    expect(messages.map((message) => message.id)).toEqual(["user-real-1"]);
  });

  it("whitelists github + t3-client only (never same-surface discord or internal)", () => {
    // Cross-surface policy: Discord echoes other surfaces, not its own ingress or harness.
    expect(DISCORD_EXTERNAL_ECHO_SURFACES).toEqual(new Set(["github", "t3-client"]));

    const github = `<!--
## GitHub pull request context
Repository: acme/widgets
-->

From GH [octocat](https://github.com/octocat) on [PR #42](https://github.com/acme/widgets/pull/42): investigate the failing check`;
    const discord = `## Discord conversation context
### Current requester
## User request
hi from discord`;
    const internal = `<system-reminder>Background task "x" completed (exit code: 0).</system-reminder>`;
    const client = "plain note from the web app";

    expect(classifyUserMessageIngress(github)).toBe("github");
    expect(classifyUserMessageIngress(discord)).toBe("discord");
    expect(classifyUserMessageIngress(internal)).toBe("internal");
    expect(classifyUserMessageIngress(client)).toBe("t3-client");
    expect(isGitHubOriginatedUserPrompt(github)).toBe(true);

    expect(
      shouldEchoUserMessageToDiscord({
        text: github,
        messageId: "g1",
        seenUserMessageIds: [],
        sentDiscordUserMessageIds: [],
      }),
    ).toBe(true);
    expect(
      shouldEchoUserMessageToDiscord({
        text: client,
        messageId: "c1",
        seenUserMessageIds: [],
        sentDiscordUserMessageIds: [],
      }),
    ).toBe(true);
    expect(
      shouldEchoUserMessageToDiscord({
        text: discord,
        messageId: "d1",
        seenUserMessageIds: [],
        sentDiscordUserMessageIds: [],
      }),
    ).toBe(false);
    expect(
      shouldEchoUserMessageToDiscord({
        text: internal,
        messageId: "i1",
        seenUserMessageIds: [],
        sentDiscordUserMessageIds: [],
      }),
    ).toBe(false);

    const messages = externalUserMessagesToEcho({
      messages: [
        {
          id: MessageId.make("g1"),
          role: "user",
          text: github,
          turnId: null,
          streaming: false,
          createdAt: "2026-07-18T00:00:00.000Z",
          updatedAt: "2026-07-18T00:00:00.000Z",
        },
        {
          id: MessageId.make("d1"),
          role: "user",
          text: discord,
          turnId: null,
          streaming: false,
          createdAt: "2026-07-18T00:00:01.000Z",
          updatedAt: "2026-07-18T00:00:01.000Z",
        },
        {
          id: MessageId.make("i1"),
          role: "user",
          text: internal,
          turnId: null,
          streaming: false,
          createdAt: "2026-07-18T00:00:02.000Z",
          updatedAt: "2026-07-18T00:00:02.000Z",
        },
        {
          id: MessageId.make("c1"),
          role: "user",
          text: client,
          turnId: null,
          streaming: false,
          createdAt: "2026-07-18T00:00:03.000Z",
          updatedAt: "2026-07-18T00:00:03.000Z",
        },
      ],
      observedInitialUserSnapshot: true,
      seenUserMessageIds: [],
      sentDiscordUserMessageIds: [],
    });
    expect(messages.map((message) => message.id)).toEqual(["g1", "c1"]);
  });

  it("does not replay already-seen external user messages after resubscribe", () => {
    const messages = externalUserMessagesToEcho({
      messages: [
        {
          id: MessageId.make("user-1"),
          role: "user",
          text: "already mirrored",
          turnId: null,
          streaming: false,
          createdAt: "2026-07-18T00:00:00.000Z",
          updatedAt: "2026-07-18T00:00:00.000Z",
        },
      ],
      observedInitialUserSnapshot: true,
      seenUserMessageIds: ["user-1"],
      sentDiscordUserMessageIds: [],
    });
    expect(messages).toEqual([]);
  });

  it("does not replay historical external user messages from the initial snapshot", () => {
    const messages = externalUserMessagesToEcho({
      messages: [
        {
          id: MessageId.make("user-1"),
          role: "user",
          text: "historical message",
          turnId: null,
          streaming: false,
          createdAt: "2026-07-18T00:00:00.000Z",
          updatedAt: "2026-07-18T00:00:00.000Z",
        },
      ],
      observedInitialUserSnapshot: false,
      seenUserMessageIds: [],
      sentDiscordUserMessageIds: [],
    });
    expect(messages).toEqual([]);
  });
});

describe("planStreamTipFreezeOnDisplacement", () => {
  it("does not hide in-flight body when freezing an empty Working tip (mid-turn human reply)", () => {
    // Production: Working.. never got prose painted; human mid-turn mention displaced the
    // tip. Old code set breakPrefix = fullDisplayText so post-break tip was empty forever.
    const plan = planStreamTipFreezeOnDisplacement({
      previousFullDisplayText: "",
      previousTipBody: "",
      previousLastAssistantText: "",
    });
    expect(plan.freezeContent).toBeNull();
    expect(plan.nextBreakPrefix).toBe("");
    expect(plan.nextLastAssistantText).toBe("");
    // Current write must paint fully under the user message.
    expect(activeStreamTipText("I'll find how the web UI handles…", plan.nextBreakPrefix)).toBe(
      "I'll find how the web UI handles…",
    );
  });

  it("freezes already-shown prose and only posts the delta post-break", () => {
    const shown = "I'll find how the web UI handles the wake-up status.";
    const plan = planStreamTipFreezeOnDisplacement({
      previousFullDisplayText: shown,
      previousTipBody: shown,
      previousLastAssistantText: shown,
    });
    expect(plan.freezeContent).toBe(shown);
    expect(plan.nextBreakPrefix).toBe(shown);
    expect(plan.nextLastAssistantText).toBe(shown);
    const next = `${shown}\n\nUpdated plan: add a blue Continue button.`;
    expect(activeStreamTipText(next, plan.nextBreakPrefix)).toBe(
      "Updated plan: add a blue Continue button.",
    );
  });
});

describe("isStreamTipDisplacedByForeignMessage self-bot side posts", () => {
  it("does not freeze the Working tip when the latest content message is our bot", () => {
    // External User Input / Tasks echoes are bot-authored; without this guard they
    // stole tip ownership and left Discord on a frozen Working body while T3 advanced.
    expect(
      isStreamTipDisplacedByForeignMessage({
        latestMessageId: "external-echo-1",
        streamTipId: "working-tip",
        ownedMessageIds: ["working-tip"],
        latestAuthorIsSelfBot: true,
      }),
    ).toBe(false);
  });

  it("still freezes when a human reply is newer than the tip", () => {
    expect(
      isStreamTipDisplacedByForeignMessage({
        latestMessageId: "human-1",
        streamTipId: "working-tip",
        ownedMessageIds: ["working-tip"],
        latestAuthorIsSelfBot: false,
      }),
    ).toBe(true);
  });

  it("pickLatestContentMessage returns author for self-bot checks", () => {
    const latest = pickLatestContentMessage([
      { id: "rename", type: 4, author: { id: "bot" } },
      { id: "echo", type: 0, author: { id: "bot" } },
    ]);
    expect(latest?.id).toBe("echo");
    expect(latest?.author?.id).toBe("bot");
  });
});

describe("summarizeExternalUserInput", () => {
  it("drops leading HTML comment sections and preserves the visible linked header", () => {
    expect(
      summarizeExternalUserInput(`<!--
## GitHub pull request context
Repository: acme/widgets
-->

From GH [octocat](https://github.com/octocat) on [PR #42](https://github.com/acme/widgets/pull/42): investigate the failing check`),
    ).toBe(
      "From GH [octocat](https://github.com/octocat) on [PR #42](https://github.com/acme/widgets/pull/42): investigate the failing check",
    );
  });

  it("drops HTML comment sections and preserves the visible linked header", () => {
    expect(
      summarizeExternalUserInput(`From GH [octocat](https://github.com/octocat) on [PR #42](https://github.com/acme/widgets/pull/42): investigate the failing check

<!--
## GitHub pull request context
Repository: acme/widgets
-->`),
    ).toBe(
      "From GH [octocat](https://github.com/octocat) on [PR #42](https://github.com/acme/widgets/pull/42): investigate the failing check",
    );
  });

  it("falls back to the raw text when no summary marker is present", () => {
    expect(summarizeExternalUserInput("plain external input")).toBe("plain external input");
  });

  it("strips system-reminder envelopes from echoed text", () => {
    expect(
      summarizeExternalUserInput(`prefix
<system-reminder>
Background task "x" completed (exit code: 0).
</system-reminder>
suffix`),
    ).toBe("prefix\n\nsuffix");
  });
});

describe("threadTitleChangeRequestState", () => {
  it("returns null when the thread has no branch-backed worktree context", () => {
    expect(
      threadTitleChangeRequestState(
        {
          branch: null,
          worktreePath: "/tmp/worktree",
          messages: [assistantMessage()],
        },
        { state: "open" },
      ),
    ).toBeNull();
    expect(
      threadTitleChangeRequestState(
        {
          branch: "feature/thread-title",
          worktreePath: null,
          messages: [assistantMessage()],
        },
        { state: "open" },
      ),
    ).toBeNull();
  });

  it("returns null until the thread has a real assistant response", () => {
    expect(
      threadTitleChangeRequestState(
        { branch: "feature/thread-title", worktreePath: "/tmp/worktree", messages: [] },
        { state: "open" },
      ),
    ).toBeNull();
  });

  it("passes through open and merged pull request states for linked worktrees", () => {
    expect(
      threadTitleChangeRequestState(
        {
          branch: "feature/thread-title",
          worktreePath: "/tmp/worktree",
          messages: [assistantMessage()],
        },
        { state: "open" },
      ),
    ).toBe("open");
    expect(
      threadTitleChangeRequestState(
        {
          branch: "feature/thread-title",
          worktreePath: "/tmp/worktree",
          messages: [assistantMessage()],
        },
        { state: "merged" },
      ),
    ).toBe("merged");
  });

  it("uses the initialized state for assistant-backed threads with no PR", () => {
    expect(
      threadTitleChangeRequestState(
        {
          branch: "feature/thread-title",
          worktreePath: "/tmp/worktree",
          messages: [assistantMessage()],
        },
        null,
      ),
    ).toBe("initialized");
  });
});

describe("resolveSettledDiscordThreadTitleUpgrade", () => {
  it("upgrades a plain settled title once the worktree thread has an assistant message", () => {
    expect(
      resolveSettledDiscordThreadTitleUpgrade({
        thread: {
          title: "Link Discord to T3 thread",
          branch: "t3-discord/23df93db",
          worktreePath: "/var/lib/t3/worktrees/t3code/t3-discord-23df93db",
          messages: [assistantMessage()],
        },
        mirroredThreadTitle: "Link Discord to T3 thread",
        attemptedThreadTitle: "Link Discord to T3 thread",
        cachedPr: null,
      }),
    ).toBe("▫️ Link Discord to T3 thread");
  });

  it("returns null when still waiting for an assistant response", () => {
    expect(
      resolveSettledDiscordThreadTitleUpgrade({
        thread: {
          title: "Link Discord to T3 thread",
          branch: "t3-discord/23df93db",
          worktreePath: "/var/lib/t3/worktrees/t3code/t3-discord-23df93db",
          messages: [],
        },
        mirroredThreadTitle: "Link Discord to T3 thread",
        attemptedThreadTitle: "Link Discord to T3 thread",
        cachedPr: null,
      }),
    ).toBeNull();
  });

  it("returns null when the initialized badge is already mirrored", () => {
    expect(
      resolveSettledDiscordThreadTitleUpgrade({
        thread: {
          title: "Link Discord to T3 thread",
          branch: "t3-discord/23df93db",
          worktreePath: "/var/lib/t3/worktrees/t3code/t3-discord-23df93db",
          messages: [assistantMessage()],
        },
        mirroredThreadTitle: "▫️ Link Discord to T3 thread",
        attemptedThreadTitle: "▫️ Link Discord to T3 thread",
        cachedPr: null,
      }),
    ).toBeNull();
  });

  it("upgrades when cached VCS status later reports an open PR", () => {
    expect(
      resolveSettledDiscordThreadTitleUpgrade({
        thread: {
          title: "Verify PROJ-378 PR readiness",
          branch: "t3-discord/91dbe634",
          worktreePath: "/var/lib/t3/worktrees/scanner/t3-discord-91dbe634",
          messages: [assistantMessage()],
        },
        mirroredThreadTitle: "▫️ Verify PROJ-378 PR readiness",
        attemptedThreadTitle: "▫️ Verify PROJ-378 PR readiness",
        cachedPr: { state: "open", hasFailingChecks: false },
      }),
    ).toBe("🔀 Verify PROJ-378 PR readiness");
  });

  it("does not demote an open PR badge to initialized when PR cache is briefly null", () => {
    expect(
      resolveSettledDiscordThreadTitleUpgrade({
        thread: {
          title: "Empasa pickup carrier rollout",
          branch: "t3-discord/empasa-pickup-carrier",
          worktreePath: "/var/lib/t3/worktrees/scanner/t3-discord-c434b753",
          messages: [assistantMessage()],
        },
        mirroredThreadTitle: "🔀 Empasa pickup carrier rollout",
        attemptedThreadTitle: "🔀 Empasa pickup carrier rollout",
        cachedPr: null,
      }),
    ).toBeNull();
  });

  it("keeps open PR and adds wake-required activity when interrupted mid-turn", () => {
    expect(
      resolveSettledDiscordThreadTitleUpgrade({
        thread: {
          title: "Empasa pickup carrier rollout",
          branch: "t3-discord/empasa-pickup-carrier",
          worktreePath: "/var/lib/t3/worktrees/scanner/t3-discord-c434b753",
          messages: [assistantMessage()],
          session: { status: "interrupted", activeTurnId: null } as never,
          latestTurn: {
            turnId: "turn-1" as never,
            state: "running",
            completedAt: null,
          } as never,
        },
        mirroredThreadTitle: "🔀 Empasa pickup carrier rollout",
        attemptedThreadTitle: "🔀 Empasa pickup carrier rollout",
        cachedPr: { state: "open", hasFailingChecks: false },
      }),
    ).toBe("🔀 ❗ Empasa pickup carrier rollout");
  });

  it("keeps open PR and adds busy activity while a turn is Working", () => {
    expect(
      resolveSettledDiscordThreadTitleUpgrade({
        thread: {
          title: "Empasa pickup carrier rollout",
          branch: "t3-discord/empasa-pickup-carrier",
          worktreePath: "/var/lib/t3/worktrees/scanner/t3-discord-c434b753",
          messages: [assistantMessage()],
          session: { status: "running", activeTurnId: "turn-1" } as never,
          latestTurn: {
            turnId: "turn-1" as never,
            state: "running",
            completedAt: null,
          } as never,
        },
        mirroredThreadTitle: "🔀 Empasa pickup carrier rollout",
        attemptedThreadTitle: "🔀 Empasa pickup carrier rollout",
        cachedPr: { state: "open", hasFailingChecks: false },
      }),
    ).toBe("🔀 ⏳ Empasa pickup carrier rollout");
  });

  it("clears busy activity and keeps the PR badge when a turn settles", () => {
    expect(
      resolveSettledDiscordThreadTitleUpgrade({
        thread: {
          title: "Empasa pickup carrier rollout",
          branch: "t3-discord/empasa-pickup-carrier",
          worktreePath: "/var/lib/t3/worktrees/scanner/t3-discord-c434b753",
          messages: [assistantMessage()],
          session: { status: "ready", activeTurnId: null } as never,
          latestTurn: {
            turnId: "turn-1" as never,
            state: "completed",
            completedAt: "2026-07-01T00:00:00.000Z",
          } as never,
        },
        mirroredThreadTitle: "🔀 ⏳ Empasa pickup carrier rollout",
        attemptedThreadTitle: "🔀 ⏳ Empasa pickup carrier rollout",
        cachedPr: { state: "open", hasFailingChecks: false },
      }),
    ).toBe("🔀 Empasa pickup carrier rollout");
  });

  it("restores initialized when busy settles with confirmed no-PR evidence", () => {
    expect(
      resolveSettledDiscordThreadTitleUpgrade({
        thread: {
          title: "Empasa pickup carrier rollout",
          branch: "t3-discord/empasa-pickup-carrier",
          worktreePath: "/var/lib/t3/worktrees/scanner/t3-discord-c434b753",
          messages: [assistantMessage()],
          session: { status: "ready", activeTurnId: null } as never,
          latestTurn: {
            turnId: "turn-1" as never,
            state: "completed",
            completedAt: "2026-07-01T00:00:00.000Z",
          } as never,
        },
        mirroredThreadTitle: "⏳ Empasa pickup carrier rollout",
        attemptedThreadTitle: "⏳ Empasa pickup carrier rollout",
        cachedPr: null,
        canApplyNoPrBadge: true,
      }),
    ).toBe("▫️ Empasa pickup carrier rollout");
  });

  it("does not paint ▫️ when busy settles but no-PR is still unconfirmed", () => {
    // Activity clears → plain title is ok; without canApplyNoPrBadge we keep no PR column.
    // Mirrored was activity-only, so desired becomes plain title (no badges).
    expect(
      resolveSettledDiscordThreadTitleUpgrade({
        thread: {
          title: "Empasa pickup carrier rollout",
          branch: "t3-discord/empasa-pickup-carrier",
          worktreePath: "/var/lib/t3/worktrees/scanner/t3-discord-c434b753",
          messages: [assistantMessage()],
          session: { status: "ready", activeTurnId: null } as never,
          latestTurn: {
            turnId: "turn-1" as never,
            state: "completed",
            completedAt: "2026-07-01T00:00:00.000Z",
          } as never,
        },
        mirroredThreadTitle: "⏳ Empasa pickup carrier rollout",
        attemptedThreadTitle: "⏳ Empasa pickup carrier rollout",
        cachedPr: null,
        canApplyNoPrBadge: false,
      }),
    ).toBe("Empasa pickup carrier rollout");
  });

  it("retries dual busy title when attempted was poisoned by a failed rename", () => {
    expect(
      resolveSettledDiscordThreadTitleUpgrade({
        thread: {
          title: "Empasa pickup carrier rollout",
          branch: "t3-discord/empasa-pickup-carrier",
          worktreePath: "/var/lib/t3/worktrees/scanner/t3-discord-c434b753",
          messages: [assistantMessage()],
          session: { status: "running", activeTurnId: "turn-1" } as never,
          latestTurn: {
            turnId: "turn-1" as never,
            state: "running",
            completedAt: null,
          } as never,
        },
        mirroredThreadTitle: "🔀 Empasa pickup carrier rollout",
        attemptedThreadTitle: "🔀 ⏳ Empasa pickup carrier rollout",
        cachedPr: { state: "open", hasFailingChecks: false },
      }),
    ).toBe("🔀 ⏳ Empasa pickup carrier rollout");
  });
});

describe("planDiscordThreadTitleApply", () => {
  it("applies a freshly computed title that Discord does not have yet", () => {
    expect(
      planDiscordThreadTitleApply({
        mirroredThreadTitle: "🔀 Empasa pickup carrier rollout",
        pendingDesiredThreadTitle: null,
        computedDesiredTitle: "🔀 ⏳ Empasa pickup carrier rollout",
      }),
    ).toEqual({
      pendingDesiredThreadTitle: "🔀 ⏳ Empasa pickup carrier rollout",
      applyTitle: "🔀 ⏳ Empasa pickup carrier rollout",
    });
  });

  it("clears pending when compute says Discord already matches", () => {
    expect(
      planDiscordThreadTitleApply({
        mirroredThreadTitle: "🔀 Empasa pickup carrier rollout",
        pendingDesiredThreadTitle: "🔀 ⏳ Empasa pickup carrier rollout",
        computedDesiredTitle: "🔀 Empasa pickup carrier rollout",
      }),
    ).toEqual({
      pendingDesiredThreadTitle: null,
      applyTitle: null,
    });
  });

  it("retries a prior failed rename when compute has nothing new", () => {
    // Turn settled, secondary timed out mid-rename — heartbeat must re-apply settle.
    expect(
      planDiscordThreadTitleApply({
        mirroredThreadTitle: "🔀 ⏳ Empasa pickup carrier rollout",
        pendingDesiredThreadTitle: "🔀 Empasa pickup carrier rollout",
        computedDesiredTitle: null,
      }),
    ).toEqual({
      pendingDesiredThreadTitle: "🔀 Empasa pickup carrier rollout",
      applyTitle: "🔀 Empasa pickup carrier rollout",
    });
  });

  it("does not re-apply when mirrored already matches pending", () => {
    expect(
      planDiscordThreadTitleApply({
        mirroredThreadTitle: "🔀 Empasa pickup carrier rollout",
        pendingDesiredThreadTitle: "🔀 Empasa pickup carrier rollout",
        computedDesiredTitle: null,
      }),
    ).toEqual({
      pendingDesiredThreadTitle: null,
      applyTitle: null,
    });
  });

  it("prefers a newer computed settle over a stale pending busy title", () => {
    // VCS raced with settle: pending still wants ⏳, compute now wants settled.
    expect(
      planDiscordThreadTitleApply({
        mirroredThreadTitle: "🔀 ⏳ Empasa pickup carrier rollout",
        pendingDesiredThreadTitle: "🔀 ⏳ Empasa pickup carrier rollout",
        computedDesiredTitle: "🔀 Empasa pickup carrier rollout",
      }),
    ).toEqual({
      pendingDesiredThreadTitle: "🔀 Empasa pickup carrier rollout",
      applyTitle: "🔀 Empasa pickup carrier rollout",
    });
  });
});

describe("nextMirroredThreadTitleAfterApply", () => {
  it("keeps pending and leaves mirrored unchanged on REST failure", () => {
    expect(
      nextMirroredThreadTitleAfterApply({
        mirroredThreadTitle: "🔀 Empasa pickup carrier rollout",
        pendingDesiredThreadTitle: "🔀 ⏳ Empasa pickup carrier rollout",
        appliedTitle: "🔀 ⏳ Empasa pickup carrier rollout",
        success: false,
      }),
    ).toEqual({
      mirroredThreadTitle: "🔀 Empasa pickup carrier rollout",
      pendingDesiredThreadTitle: "🔀 ⏳ Empasa pickup carrier rollout",
      attemptedThreadTitle: null,
    });
  });

  it("updates mirrored and clears matching pending on success", () => {
    expect(
      nextMirroredThreadTitleAfterApply({
        mirroredThreadTitle: "🔀 ⏳ Empasa pickup carrier rollout",
        pendingDesiredThreadTitle: "🔀 Empasa pickup carrier rollout",
        appliedTitle: "🔀 Empasa pickup carrier rollout",
        success: true,
      }),
    ).toEqual({
      mirroredThreadTitle: "🔀 Empasa pickup carrier rollout",
      pendingDesiredThreadTitle: null,
      attemptedThreadTitle: "🔀 Empasa pickup carrier rollout",
    });
  });
});

describe("resolveTemporaryDiscordThreadTitleBadge", () => {
  it("returns busy while a turn is Working", () => {
    expect(
      resolveTemporaryDiscordThreadTitleBadge({
        sessionStatus: "running",
        latestTurnState: "running",
      }),
    ).toBe("busy");
  });

  it("returns wake-required for a real mid-turn interrupt", () => {
    expect(
      resolveTemporaryDiscordThreadTitleBadge({
        sessionStatus: "interrupted",
        latestTurnState: "running",
      }),
    ).toBe("wake-required");
  });

  it("returns null when idle so the PR path can paint sticky badges", () => {
    expect(
      resolveTemporaryDiscordThreadTitleBadge({
        sessionStatus: "ready",
        latestTurnState: "completed",
        latestTurnCompletedAt: "2026-07-01T00:00:00.000Z",
      }),
    ).toBeNull();
  });
});

describe("shouldApplyDiscordThreadTitleBadge", () => {
  it("allows plain → initialized → open → merged", () => {
    expect(shouldApplyDiscordThreadTitleBadge(null, "initialized")).toBe(true);
    expect(shouldApplyDiscordThreadTitleBadge("initialized", "open")).toBe(true);
    expect(shouldApplyDiscordThreadTitleBadge("open", "merged")).toBe(true);
  });

  it("refuses open → initialized / plain demotion (flip-flop)", () => {
    expect(shouldApplyDiscordThreadTitleBadge("open", "initialized")).toBe(false);
    expect(shouldApplyDiscordThreadTitleBadge("open", null)).toBe(false);
    expect(shouldApplyDiscordThreadTitleBadge("merged", "initialized")).toBe(false);
  });

  it("always allows applying and clearing wake-required (sticky over git/PR while active)", () => {
    expect(shouldApplyDiscordThreadTitleBadge("open", "wake-required")).toBe(true);
    expect(shouldApplyDiscordThreadTitleBadge("merged", "wake-required")).toBe(true);
    expect(shouldApplyDiscordThreadTitleBadge("wake-required", "open")).toBe(true);
    expect(shouldApplyDiscordThreadTitleBadge("wake-required", "initialized")).toBe(true);
    expect(shouldApplyDiscordThreadTitleBadge("wake-required", null)).toBe(true);
  });

  it("always allows applying and clearing busy (Working..) over git/PR badges", () => {
    expect(shouldApplyDiscordThreadTitleBadge("open", "busy")).toBe(true);
    expect(shouldApplyDiscordThreadTitleBadge("initialized", "busy")).toBe(true);
    expect(shouldApplyDiscordThreadTitleBadge("merged", "busy")).toBe(true);
    expect(shouldApplyDiscordThreadTitleBadge("busy", "open")).toBe(true);
    expect(shouldApplyDiscordThreadTitleBadge("busy", "initialized")).toBe(true);
    expect(shouldApplyDiscordThreadTitleBadge("busy", null)).toBe(true);
  });

  it("parses dual-slot and legacy badge prefixes from mirrored Discord titles", () => {
    expect(parseDiscordThreadTitleBadges("🔀 ⏳ Empasa pickup carrier rollout")).toEqual({
      pr: "open",
      activity: "busy",
    });
    expect(parseDiscordThreadTitleBadges("❌ ❗ Empasa pickup carrier rollout")).toEqual({
      pr: "open",
      activity: "wake-required",
    });
    // Legacy dual ❌ 🔀 still parses as open.
    expect(parseDiscordThreadTitleBadges("❌ 🔀 Empasa pickup carrier rollout")).toEqual({
      pr: "open",
      activity: null,
    });
    expect(parseDiscordThreadTitleBadgeState("🔀 Empasa pickup carrier rollout")).toBe("open");
    expect(parseDiscordThreadTitleBadgeState("❌ Empasa pickup carrier rollout")).toBe("open");
    expect(parseDiscordThreadTitleBadgeState("❌ 🔀 Empasa pickup carrier rollout")).toBe("open");
    expect(parseDiscordThreadTitleBadgeState("❗ Empasa pickup carrier rollout")).toBe(
      "wake-required",
    );
    expect(parseDiscordThreadTitleBadgeState("⏳ Empasa pickup carrier rollout")).toBe("busy");
    expect(parseDiscordThreadTitleBadgeState("▫️ Empasa pickup carrier rollout")).toBe(
      "initialized",
    );
    expect(parseDiscordThreadTitleBadgeState("Empasa pickup carrier rollout")).toBeNull();
  });

  it("shouldApplyDiscordThreadPrBadge refuses open → initialized demotion", () => {
    expect(shouldApplyDiscordThreadPrBadge("open", "initialized")).toBe(false);
    expect(shouldApplyDiscordThreadPrBadge("open", "merged")).toBe(true);
  });
});

describe("resolveDiscordThreadTitleBadges", () => {
  it("keeps PR and activity independent (client-style dual indicators)", () => {
    expect(
      resolveDiscordThreadTitleBadges({
        sessionStatus: "running",
        latestTurnState: "running",
        prState: "open",
      }),
    ).toEqual({ pr: "open", activity: "busy" });
    expect(
      resolveDiscordThreadTitleBadges({
        sessionStatus: "interrupted",
        latestTurnState: "running",
        prState: "open",
      }),
    ).toEqual({ pr: "open", activity: "wake-required" });
    expect(
      resolveDiscordThreadTitleBadges({
        sessionStatus: "ready",
        prState: "open",
      }),
    ).toEqual({ pr: "open", activity: null });
  });
});

describe("resolveDiscordThreadTitleBadgeState", () => {
  it("legacy exclusive API prefers activity over PR", () => {
    expect(
      resolveDiscordThreadTitleBadgeState({
        sessionStatus: "interrupted",
        latestTurnState: "running",
        prState: "open",
      }),
    ).toBe("wake-required");
    expect(
      resolveDiscordThreadTitleBadgeState({
        sessionStatus: "running",
        latestTurnState: "running",
        prState: "open",
      }),
    ).toBe("busy");
  });

  it("returns activity busy when session is starting with no turn yet", () => {
    expect(
      resolveDiscordThreadActivityBadgeState({
        sessionStatus: "starting",
        latestTurnState: null,
      }),
    ).toBe("busy");
  });

  it("keeps PR state for zombie interrupted sessions with a completed turn", () => {
    expect(
      resolveDiscordThreadTitleBadgeState({
        sessionStatus: "interrupted",
        latestTurnState: "completed",
        latestTurnCompletedAt: "2026-07-01T00:00:00.000Z",
        prState: "open",
      }),
    ).toBe("open");
  });

  it("returns PR state once the session is no longer interrupted", () => {
    expect(
      resolveDiscordThreadTitleBadgeState({
        sessionStatus: "ready",
        prState: "open",
      }),
    ).toBe("open");
  });
});

describe("shouldConvertWorkingTipsToWakeUp", () => {
  it("converts open Working tips when a mid-turn session is interrupted", () => {
    expect(
      shouldConvertWorkingTipsToWakeUp({
        sessionStatus: "interrupted",
        latestTurnState: "running",
        turnInProgress: false,
        openStreamTipCount: 1,
        wakeUpNoticePosted: false,
      }),
    ).toBe(true);
  });

  it("does not convert zombie interrupted sessions or empty tips", () => {
    expect(
      shouldConvertWorkingTipsToWakeUp({
        sessionStatus: "interrupted",
        latestTurnState: "completed",
        latestTurnCompletedAt: "2026-07-01T00:00:00.000Z",
        turnInProgress: false,
        openStreamTipCount: 1,
        wakeUpNoticePosted: false,
      }),
    ).toBe(false);
    expect(
      shouldConvertWorkingTipsToWakeUp({
        sessionStatus: "interrupted",
        latestTurnState: "running",
        turnInProgress: false,
        openStreamTipCount: 1,
        wakeUpNoticePosted: true,
      }),
    ).toBe(false);
    expect(
      shouldConvertWorkingTipsToWakeUp({
        sessionStatus: "interrupted",
        latestTurnState: "running",
        turnInProgress: true,
        openStreamTipCount: 1,
        wakeUpNoticePosted: false,
      }),
    ).toBe(false);
    expect(
      shouldConvertWorkingTipsToWakeUp({
        sessionStatus: "interrupted",
        latestTurnState: "running",
        turnInProgress: false,
        openStreamTipCount: 0,
        wakeUpNoticePosted: false,
      }),
    ).toBe(false);
    expect(
      shouldConvertWorkingTipsToWakeUp({
        sessionStatus: "ready",
        latestTurnState: "running",
        turnInProgress: false,
        openStreamTipCount: 1,
        wakeUpNoticePosted: false,
      }),
    ).toBe(false);
  });
});

describe("resolveThreadTitleChangeRequestFromStatus", () => {
  it("reuses the shared VCS status PR when it belongs to the thread branch", () => {
    expect(
      resolveThreadTitleChangeRequestFromStatus({ branch: "feature/thread-title" }, statusWithPr()),
    ).toMatchObject({ number: 42, state: "merged" });
  });

  it("ignores PRs from unrelated branches", () => {
    expect(
      resolveThreadTitleChangeRequestFromStatus(
        { branch: "feature/thread-title" },
        statusWithPr({
          refName: "feature/other-branch",
          pr: { ...statusWithPr().pr!, headRef: "feature/other-branch" },
        }),
      ),
    ).toBeNull();
  });
});

describe("mergeStickyTitlePr / resolveDiscordTitlePrEvidence", () => {
  it("keeps sticky PR when the next observation is null (unknown)", () => {
    const sticky = { state: "open" as const, number: 9, hasFailingChecks: true };
    expect(mergeStickyTitlePr(sticky, null)).toEqual(sticky);
    expect(mergeStickyTitlePr(sticky, undefined)).toEqual(sticky);
  });

  it("keeps hasFailingChecks=true for the same open PR until explicit false", () => {
    const sticky = { state: "open" as const, number: 9, hasFailingChecks: true };
    expect(mergeStickyTitlePr(sticky, { state: "open", number: 9 })).toEqual({
      state: "open",
      number: 9,
      hasFailingChecks: true,
    });
    expect(
      mergeStickyTitlePr(sticky, { state: "open", number: 9, hasFailingChecks: false }),
    ).toEqual({
      state: "open",
      number: 9,
      hasFailingChecks: false,
    });
  });

  it("does not allow no-PR (▫️) badge until remote status is observed", () => {
    expect(
      resolveDiscordTitlePrEvidence({
        stickyPr: null,
        statusPr: null,
        remoteStatusObserved: false,
      }),
    ).toEqual({
      stickyPr: null,
      effectivePr: null,
      canApplyNoPrBadge: false,
    });
  });

  it("allows no-PR badge only after remote is observed with no sticky PR", () => {
    expect(
      resolveDiscordTitlePrEvidence({
        stickyPr: null,
        statusPr: null,
        remoteStatusObserved: true,
      }),
    ).toEqual({
      stickyPr: null,
      effectivePr: null,
      canApplyNoPrBadge: true,
    });
  });

  it("sticks open failing PR from VCS and refuses demotion via null status", () => {
    const openFailing = toStickyTitlePrEvidence({
      state: "open",
      number: 12,
      hasFailingChecks: true,
    });
    const afterNull = resolveDiscordTitlePrEvidence({
      stickyPr: openFailing,
      statusPr: null,
      remoteStatusObserved: true,
    });
    expect(afterNull.effectivePr).toEqual(openFailing);
    expect(afterNull.canApplyNoPrBadge).toBe(false);
  });

  it("settled upgrade does not paint ▫️ when canApplyNoPrBadge is false", () => {
    expect(
      resolveSettledDiscordThreadTitleUpgrade({
        thread: {
          title: "Sync recent scanner learnings",
          branch: "t3-discord/scanner",
          worktreePath: "/tmp/wt",
          messages: [assistantMessage()],
        },
        mirroredThreadTitle: "❌ Sync recent scanner learnings",
        attemptedThreadTitle: "❌ Sync recent scanner learnings",
        cachedPr: null,
        canApplyNoPrBadge: false,
      }),
    ).toBeNull();
  });

  it("settled upgrade may paint ▫️ only with confirmed no-PR evidence", () => {
    expect(
      resolveSettledDiscordThreadTitleUpgrade({
        thread: {
          title: "Sync recent scanner learnings",
          branch: "t3-discord/scanner",
          worktreePath: "/tmp/wt",
          messages: [assistantMessage()],
        },
        mirroredThreadTitle: "Sync recent scanner learnings",
        attemptedThreadTitle: "Sync recent scanner learnings",
        cachedPr: null,
        canApplyNoPrBadge: true,
      }),
    ).toBe("▫️ Sync recent scanner learnings");
  });
});

describe("resolveThreadChangeRequestLookupCwds", () => {
  it("tries the thread worktree before the project root", () => {
    expect(
      resolveThreadChangeRequestLookupCwds(
        { worktreePath: "/tmp/worktree" },
        { workspaceRoot: "/tmp/project" },
      ),
    ).toEqual(["/tmp/worktree", "/tmp/project"]);
  });

  it("deduplicates identical worktree and project paths", () => {
    expect(
      resolveThreadChangeRequestLookupCwds(
        { worktreePath: "/tmp/project" },
        { workspaceRoot: "/tmp/project" },
      ),
    ).toEqual(["/tmp/project"]);
  });
});
