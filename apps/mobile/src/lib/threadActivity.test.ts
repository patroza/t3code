import { describe, expect, it } from "vite-plus/test";
import { codexFeedbackMessage } from "@t3tools/client-runtime/state/threads";

import {
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";

import {
  buildPendingUserInputAnswers,
  buildThreadFeed,
  derivePendingApprovals,
  deriveQueuedMessageControls,
  deriveThreadFeedPresentation,
  promoteSteeredQueuedMessages,
  isPendingUserInputOptionSelected,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
  type ThreadFeedActivity,
  type ThreadFeedEntry,
} from "./threadActivity";

describe("deriveQueuedMessageControls", () => {
  it("allows steering or removing server-queued messages", () => {
    expect(deriveQueuedMessageControls("queued", "server")).toEqual({
      canSteer: true,
      canEdit: true,
    });
  });

  it("allows discarding an offline local-outbox message", () => {
    expect(deriveQueuedMessageControls("waiting", "local")).toEqual({
      canSteer: false,
      canEdit: true,
    });
  });

  it("does not claim an in-flight local send can still be cancelled", () => {
    expect(deriveQueuedMessageControls("sending", "local")).toEqual({
      canSteer: false,
      canEdit: false,
    });
  });
});

describe("Codex feedback pseudo-messages", () => {
  it("keeps pending and completed feedback messages in the mobile thread body", () => {
    const pending = {
      id: MessageId.make("feedback-command"),
      command: "/feedback The agent stopped early.",
      createdAt: "2026-08-23T00:00:00.000Z",
      status: "uploading" as const,
    };
    const entries = [codexFeedbackMessage(pending), codexFeedbackMessage(pending, "assistant")].map(
      (message) => ({
        type: "message" as const,
        id: message.id,
        createdAt: message.createdAt,
        message,
      }),
    );

    expect(deriveThreadFeedPresentation(entries, null, new Set())).toEqual(entries);
    expect(entries[1]?.message.text).toBe("Sending feedback to OpenAI...");

    const completed = codexFeedbackMessage(
      { ...pending, status: "sent", feedbackId: "codex-thread-1" },
      "assistant",
    );
    expect(completed.text).toContain("codex-thread-1");
  });
});

const singleSelectQuestion = {
  id: "runtime",
  header: "Runtime",
  question: "Which runtime should be used?",
  options: [
    { label: "Go", description: "One binary" },
    { label: "Node.js", description: "Reuse TypeScript" },
  ],
  multiSelect: false,
} as const;

const multiSelectQuestion = {
  id: "scope",
  header: "Scope",
  question: "Which data should be collected?",
  options: [
    { label: "Orders", description: "Receipts" },
    { label: "Listings", description: "Inventory" },
  ],
  multiSelect: true,
} as const;

describe("pending user input answers", () => {
  it("replaces single-select options and toggles multi-select options", () => {
    expect(
      togglePendingUserInputOptionSelection(
        singleSelectQuestion,
        { selectedOptionLabels: ["Go"] },
        "Node.js",
      ),
    ).toEqual({ customAnswer: "", selectedOptionLabels: ["Node.js"] });

    const orders = togglePendingUserInputOptionSelection(multiSelectQuestion, undefined, "Orders");
    const ordersAndListings = togglePendingUserInputOptionSelection(
      multiSelectQuestion,
      orders,
      "Listings",
    );
    expect(ordersAndListings).toEqual({
      customAnswer: "",
      selectedOptionLabels: ["Orders", "Listings"],
    });
    expect(
      togglePendingUserInputOptionSelection(multiSelectQuestion, ordersAndListings, "Orders"),
    ).toEqual({ customAnswer: "", selectedOptionLabels: ["Listings"] });

    const paddedOrders = togglePendingUserInputOptionSelection(
      multiSelectQuestion,
      undefined,
      "  Orders  ",
    );
    expect(paddedOrders).toEqual({ customAnswer: "", selectedOptionLabels: ["Orders"] });
    expect(
      togglePendingUserInputOptionSelection(multiSelectQuestion, paddedOrders, "  Orders  "),
    ).toEqual({ customAnswer: "" });
  });

  it("builds array answers for multi-select questions", () => {
    expect(
      buildPendingUserInputAnswers([singleSelectQuestion, multiSelectQuestion], {
        runtime: { selectedOptionLabels: ["Go"] },
        scope: { selectedOptionLabels: ["Orders", "Listings"] },
      }),
    ).toEqual({
      runtime: "Go",
      scope: ["Orders", "Listings"],
    });
  });

  it("clears selected options while a custom answer is active", () => {
    expect(
      setPendingUserInputCustomAnswer(
        { selectedOptionLabels: ["Orders", "Listings"] },
        "Orders first",
      ),
    ).toEqual({ customAnswer: "Orders first" });
  });

  it("matches selected chips against normalized option labels", () => {
    expect(
      isPendingUserInputOptionSelected({ selectedOptionLabels: ["Orders"] }, "  Orders  "),
    ).toBe(true);
    expect(
      isPendingUserInputOptionSelected(
        { selectedOptionLabels: ["Orders"], customAnswer: "Orders first" },
        "  Orders  ",
      ),
    ).toBe(false);
  });
});

describe("pending approvals", () => {
  it("keeps app access approvals and persistence choices from remote environments", () => {
    const options = [
      { decision: "decline", label: "Decline" },
      { decision: "acceptAlways", label: "Always allow Safari" },
      { decision: "accept", label: "Approve" },
    ];
    const activity = makeActivity({
      id: EventId.make("approval-safari"),
      kind: "approval.requested",
      summary: "App access approval requested",
      createdAt: "2026-08-24T00:00:00.000Z",
      payload: {
        requestId: "req-safari",
        requestType: "mcp_elicitation_approval",
        detail: "Allow ChatGPT to use Safari?",
        appName: "Safari",
        options,
      },
    });

    expect(derivePendingApprovals([activity])).toEqual([
      {
        requestId: "req-safari",
        requestKind: "mcp-elicitation",
        createdAt: "2026-08-24T00:00:00.000Z",
        detail: "Allow ChatGPT to use Safari?",
        appName: "Safari",
        options,
      },
    ]);
  });

  it("removes an app access approval after a remote client rejects it", () => {
    const requested = makeActivity({
      id: EventId.make("approval-safari-open"),
      kind: "approval.requested",
      summary: "App access approval requested",
      createdAt: "2026-08-24T00:00:00.000Z",
      payload: { requestId: "req-safari", requestKind: "mcp-elicitation" },
    });
    const resolved = makeActivity({
      id: EventId.make("approval-safari-resolved"),
      kind: "approval.resolved",
      summary: "Approval resolved",
      createdAt: "2026-08-24T00:00:01.000Z",
      payload: { requestId: "req-safari", decision: "decline" },
    });

    expect(derivePendingApprovals([requested, resolved])).toEqual([]);
  });
});

function makeActivity(
  input: Partial<OrchestrationThreadActivity> &
    Pick<OrchestrationThreadActivity, "id" | "kind" | "summary" | "createdAt">,
): OrchestrationThreadActivity {
  return {
    tone: "info",
    payload: {},
    turnId: null,
    ...input,
  };
}

function makeThread(
  input: Partial<OrchestrationThread> & Pick<OrchestrationThread, "id" | "projectId" | "title">,
): OrchestrationThread {
  return {
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
    archivedAt: null,
    deletedAt: null,
    messages: [],
    queuedMessages: [],
    pendingTurnStart: null,
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
    ...input,
    settledOverride: input.settledOverride ?? null,
    settledAt: input.settledAt ?? null,
  };
}

describe("buildThreadFeed", () => {
  it("shows submitted structured answers in the feed", () => {
    const thread = makeThread({
      id: ThreadId.make("thread-input"),
      projectId: ProjectId.make("project-input"),
      title: "Input thread",
      activities: [
        makeActivity({
          id: EventId.make("input-requested"),
          kind: "user-input.requested",
          summary: "User input requested",
          createdAt: "2026-04-01T00:00:01.000Z",
          payload: {
            requestId: "request-1",
            questions: [{ id: "goal", header: "Goal", question: "What is the goal?", options: [] }],
          },
        }),
        makeActivity({
          id: EventId.make("input-resolved"),
          kind: "user-input.resolved",
          summary: "User input submitted",
          createdAt: "2026-04-01T00:00:02.000Z",
          payload: { requestId: "request-1", answers: { goal: "Make it sleep" } },
        }),
      ],
    });

    const resolved = buildThreadFeed(thread)
      .filter((entry) => entry.type === "activity-group")
      .flatMap((entry) => entry.activities)
      .find((entry) => entry.id === "input-resolved");
    expect(resolved?.detail).toBe("Make it sleep");
    expect(resolved?.getFullDetail()).toContain("What is the goal?\nMake it sleep");
  });

  it("keeps older local feedback before newer messages returned by the server", () => {
    const submission = {
      id: MessageId.make("feedback-command-ordering"),
      command: "/feedback The agent stopped early.",
      createdAt: "2026-08-23T00:00:01.000Z",
      status: "sent" as const,
      feedbackId: "codex-thread-1",
    };
    const laterMessage = {
      id: MessageId.make("later-server-message"),
      role: "assistant" as const,
      text: "Newer server response",
      turnId: null,
      createdAt: "2026-08-23T00:00:02.000Z",
      updatedAt: "2026-08-23T00:00:02.000Z",
      streaming: false,
    };
    const thread = makeThread({
      id: ThreadId.make("thread-feedback-ordering"),
      projectId: ProjectId.make("project-1"),
      title: "Feedback ordering",
      messages: [laterMessage],
    });

    const feed = buildThreadFeed(thread, {
      localMessages: [
        codexFeedbackMessage(submission),
        codexFeedbackMessage(submission, "assistant"),
      ],
    });

    expect(feed.map((entry) => entry.id)).toEqual([
      "feedback-command-ordering",
      "feedback-command-ordering:feedback",
      "later-server-message",
    ]);
  });

  it("keeps historic work entries attributed to their turns", () => {
    const thread = makeThread({
      id: ThreadId.make("thread-1"),
      projectId: ProjectId.make("project-1"),
      title: "Runtime warning thread",
      latestTurn: {
        turnId: TurnId.make("turn-latest"),
        state: "running",
        requestedAt: "2026-04-01T00:00:00.000Z",
        startedAt: "2026-04-01T00:00:01.000Z",
        completedAt: null,
        assistantMessageId: null,
      },
      activities: [
        makeActivity({
          id: EventId.make("activity-old"),
          kind: "runtime.warning",
          summary: "Runtime warning",
          createdAt: "2026-04-01T00:00:02.000Z",
          turnId: TurnId.make("turn-old"),
          payload: {
            message: "Old warning",
          },
        }),
        makeActivity({
          id: EventId.make("activity-latest"),
          kind: "runtime.warning",
          summary: "Runtime warning",
          createdAt: "2026-04-01T00:00:03.000Z",
          turnId: TurnId.make("turn-latest"),
          payload: {
            message: "Latest warning",
          },
        }),
      ],
    });

    const feed = buildThreadFeed(thread);
    expect(feed).toMatchObject([
      {
        type: "activity-group",
        turnId: "turn-old",
        activities: [{ id: "activity-old", turnId: "turn-old" }],
      },
      {
        type: "activity-group",
        turnId: "turn-latest",
        activities: [{ id: "activity-latest", turnId: "turn-latest" }],
      },
    ]);
  });

  it("collapses matching tool lifecycle rows like desktop", () => {
    const thread = makeThread({
      id: ThreadId.make("thread-2"),
      projectId: ProjectId.make("project-1"),
      title: "Collapsed tools",
      latestTurn: {
        turnId: TurnId.make("turn-1"),
        state: "completed",
        requestedAt: "2026-04-01T00:00:00.000Z",
        startedAt: "2026-04-01T00:00:01.000Z",
        completedAt: "2026-04-01T00:00:03.000Z",
        assistantMessageId: null,
      },
      activities: [
        makeActivity({
          id: EventId.make("tool-updated"),
          kind: "tool.updated",
          tone: "tool",
          summary: "Run tests",
          createdAt: "2026-04-01T00:00:01.000Z",
          turnId: TurnId.make("turn-1"),
          payload: {
            title: "Run tests",
            itemType: "command_execution",
            detail: "/bin/zsh -lc 'bun run test'",
          },
        }),
        makeActivity({
          id: EventId.make("tool-completed"),
          kind: "tool.completed",
          tone: "tool",
          summary: "Run tests completed",
          createdAt: "2026-04-01T00:00:02.000Z",
          turnId: TurnId.make("turn-1"),
          payload: {
            title: "Run tests",
            itemType: "command_execution",
            detail: "/bin/zsh -lc 'bun run test'",
          },
        }),
      ],
    });

    const feed = buildThreadFeed(thread);
    const group = feed[0];

    expect(group).toMatchObject({
      type: "activity-group",
    });
    if (!group || group.type !== "activity-group") {
      return;
    }

    expect(group.activities).toHaveLength(1);
    expect(group.activities[0]).toMatchObject({
      id: "tool-completed",
      createdAt: "2026-04-01T00:00:02.000Z",
      turnId: "turn-1",
      summary: "Run tests",
      detail: "bun run test",
      canExpand: true,
      icon: "command",
      toolLike: true,
      status: "success",
    });
    expect(group.activities[0]?.getFullDetail()).toBe("/bin/zsh -lc 'bun run test'");
    expect(group.activities[0]?.getCopyText()).toBe(
      "Run tests\nbun run test\n/bin/zsh -lc 'bun run test'",
    );
  });

  it("keeps MCP inputs available to expanded mobile work rows", () => {
    const turnId = TurnId.make("turn-mcp");
    const thread = makeThread({
      id: ThreadId.make("thread-mcp"),
      projectId: ProjectId.make("project-1"),
      title: "Expandable MCP call",
      latestTurn: {
        turnId,
        state: "completed",
        requestedAt: "2026-04-01T00:00:00.000Z",
        startedAt: "2026-04-01T00:00:01.000Z",
        completedAt: "2026-04-01T00:00:03.000Z",
        assistantMessageId: null,
      },
      activities: [
        makeActivity({
          id: EventId.make("mcp-completed"),
          kind: "tool.completed",
          tone: "tool",
          summary: "Call repository tool",
          createdAt: "2026-04-01T00:00:02.000Z",
          turnId,
          payload: {
            title: "Call repository tool",
            itemType: "mcp_tool_call",
            detail: "repository.search",
            status: "completed",
            data: {
              item: {
                server: "repository",
                tool: "search",
                arguments: { query: "work log" },
              },
            },
          },
        }),
      ],
    });

    const group = buildThreadFeed(thread)[0];
    expect(group).toMatchObject({ type: "activity-group" });
    if (!group || group.type !== "activity-group") {
      return;
    }

    expect(group.activities[0]?.icon).toBe("wrench");
    expect(group.activities[0]?.getFullDetail()).toContain('"query": "work log"');
    expect(group.activities[0]?.getFullDetail()).toContain("repository.search");
  });

  it("defers large tool output expansion until a work row is opened or copied", () => {
    let serializedToolOutputs = 0;
    const activities = Array.from({ length: 5_000 }, (_, index) =>
      makeActivity({
        id: EventId.make(`large-tool-${index}`),
        kind: "tool.completed",
        tone: "tool",
        summary: `Tool ${index}`,
        createdAt: new Date(Date.UTC(2026, 3, 1, 0, 0, index)).toISOString(),
        payload: {
          title: `Tool ${index}`,
          itemType: "mcp_tool_call",
          status: "completed",
          data: {
            item: {
              toJSON: () => {
                serializedToolOutputs += 1;
                return { output: "x".repeat(32_768) };
              },
            },
          },
        },
      }),
    );
    const thread = makeThread({
      id: ThreadId.make("thread-large-tools"),
      projectId: ProjectId.make("project-1"),
      title: "Large tools",
      activities,
    });

    const feed = buildThreadFeed(thread);
    expect(serializedToolOutputs).toBe(0);

    const group = feed[0];
    expect(group).toMatchObject({ type: "activity-group" });
    if (!group || group.type !== "activity-group") {
      return;
    }

    expect(group.activities).toHaveLength(5_000);
    expect(group.activities[0]?.getFullDetail()).toContain('"output"');
    expect(serializedToolOutputs).toBe(1);
    expect(group.activities[0]?.getCopyText()).toContain('"output"');
    expect(serializedToolOutputs).toBe(1);
  });

  it("keeps the first and terminal assistant messages visible around settled work", () => {
    const turnId = TurnId.make("turn-1");
    const thread = makeThread({
      id: ThreadId.make("thread-3"),
      projectId: ProjectId.make("project-1"),
      title: "Folded work",
      latestTurn: {
        turnId,
        state: "completed",
        requestedAt: "2026-04-01T00:00:00.000Z",
        startedAt: "2026-04-01T00:00:01.000Z",
        completedAt: "2026-04-01T00:00:18.000Z",
        assistantMessageId: MessageId.make("assistant-final"),
      },
      messages: [
        {
          id: MessageId.make("assistant-first"),
          role: "assistant",
          text: "Synthetic deployment checklist\n1. Confirm the deployment is ready.",
          turnId,
          streaming: false,
          createdAt: "2026-04-01T00:00:02.000Z",
          updatedAt: "2026-04-01T00:00:03.000Z",
        },
        {
          id: MessageId.make("assistant-final"),
          role: "assistant",
          text: "Done.",
          turnId,
          streaming: false,
          createdAt: "2026-04-01T00:00:17.000Z",
          updatedAt: "2026-04-01T00:00:18.000Z",
        },
      ],
      activities: [
        makeActivity({
          id: EventId.make("tool-completed"),
          kind: "tool.completed",
          tone: "tool",
          summary: "Read files",
          createdAt: "2026-04-01T00:00:05.000Z",
          turnId,
          payload: {
            title: "Read files",
            itemType: "file_read",
            status: "completed",
          },
        }),
      ],
    });

    const feed = buildThreadFeed(thread);
    const collapsed = deriveThreadFeedPresentation(feed, thread.latestTurn, new Set());
    expect(collapsed.map((entry) => entry.id)).toEqual([
      "assistant-first",
      "turn-fold:turn-1",
      "assistant-final",
    ]);
    expect(collapsed[1]).toMatchObject({
      type: "turn-fold",
      label: "Worked for 17s",
      expanded: false,
    });

    const expanded = deriveThreadFeedPresentation(feed, thread.latestTurn, new Set([turnId]));
    expect(expanded.map((entry) => entry.id)).toEqual([
      "assistant-first",
      "turn-fold:turn-1",
      "tool-completed",
      "assistant-final",
    ]);
  });

  it("keeps a queue-drain final assistant answer below the fold when turnId is mis-stamped", () => {
    // Mirrors production: previous turn's final lands with the *next* turn's id
    // at the same timestamp as the queued user message (see Fix Mobile Thread
    // Selection Hangs / turn 15c01839 vs segment:10).
    const firstTurnId = TurnId.make("turn-1");
    const secondTurnId = TurnId.make("turn-2");
    const thread = makeThread({
      id: ThreadId.make("thread-queue-drain-fold"),
      projectId: ProjectId.make("project-1"),
      title: "Queue drain fold",
      latestTurn: {
        turnId: secondTurnId,
        state: "completed",
        requestedAt: "2026-04-01T00:00:20.000Z",
        startedAt: "2026-04-01T00:00:20.000Z",
        completedAt: "2026-04-01T00:00:30.000Z",
        assistantMessageId: MessageId.make("assistant-next-final"),
      },
      messages: [
        {
          id: MessageId.make("user-1"),
          role: "user",
          text: "Change the icons.",
          turnId: null,
          streaming: false,
          createdAt: "2026-04-01T00:00:00.000Z",
          updatedAt: "2026-04-01T00:00:00.000Z",
        },
        {
          id: MessageId.make("assistant-status"),
          role: "assistant",
          text: "Replacing the segment bar…",
          turnId: firstTurnId,
          streaming: false,
          createdAt: "2026-04-01T00:00:05.000Z",
          updatedAt: "2026-04-01T00:00:05.000Z",
        },
        {
          id: MessageId.make("assistant-final-misstamped"),
          role: "assistant",
          text: "Done. No more segment bar.",
          // Wrong: stamped with the next turn at drain time.
          turnId: secondTurnId,
          streaming: false,
          createdAt: "2026-04-01T00:00:20.000Z",
          updatedAt: "2026-04-01T00:00:20.000Z",
        },
        {
          id: MessageId.make("user-2"),
          role: "user",
          text: "Why is the queue in the timeline?",
          turnId: null,
          streaming: false,
          createdAt: "2026-04-01T00:00:20.000Z",
          updatedAt: "2026-04-01T00:00:20.000Z",
        },
        {
          id: MessageId.make("assistant-next-final"),
          role: "assistant",
          text: "Because we used bubbles.",
          turnId: secondTurnId,
          streaming: false,
          createdAt: "2026-04-01T00:00:28.000Z",
          updatedAt: "2026-04-01T00:00:30.000Z",
        },
      ],
      activities: [
        makeActivity({
          id: EventId.make("tool-1"),
          kind: "tool.completed",
          tone: "tool",
          summary: "Changed files",
          createdAt: "2026-04-01T00:00:10.000Z",
          turnId: firstTurnId,
          payload: {
            title: "Changed files",
            itemType: "file_change",
            status: "completed",
          },
        }),
      ],
    });

    const feed = buildThreadFeed(thread);
    const collapsed = deriveThreadFeedPresentation(feed, thread.latestTurn, new Set());
    const ids = collapsed.map((entry) => entry.id);
    // Rehome keeps the mis-stamped final on turn-1; first+terminal fold keeps
    // the first assistant visible and hides tools in between.
    expect(ids).toContain("assistant-status");
    expect(ids).toContain("assistant-final-misstamped");
    expect(ids).toContain("turn-fold:turn-1");
    expect(ids.indexOf("assistant-final-misstamped")).toBeGreaterThan(
      ids.indexOf("turn-fold:turn-1"),
    );
    expect(ids).not.toContain("tool-1");

    const expanded = deriveThreadFeedPresentation(feed, thread.latestTurn, new Set([firstTurnId]));
    const expandedIds = expanded.map((entry) => entry.id);
    expect(expandedIds).toContain("turn-fold:turn-1");
    expect(expandedIds.some((id) => id.startsWith("assistant-status"))).toBe(true);
    expect(expandedIds).toContain("tool-1");
    expect(expandedIds).toContain("assistant-final-misstamped");
    expect(expandedIds).toContain("user-2");
    expect(expandedIds).toContain("assistant-next-final");
  });

  it("folds assistant messages between the first and terminal messages", () => {
    const turnId = TurnId.make("turn-1");
    const thread = makeThread({
      id: ThreadId.make("thread-middle-message"),
      projectId: ProjectId.make("project-1"),
      title: "Bounded narration",
      latestTurn: {
        turnId,
        state: "completed",
        requestedAt: "2026-04-01T00:00:00.000Z",
        startedAt: "2026-04-01T00:00:01.000Z",
        completedAt: "2026-04-01T00:00:06.000Z",
        assistantMessageId: MessageId.make("assistant-final"),
      },
      messages: [
        {
          id: MessageId.make("assistant-first"),
          role: "assistant",
          text: "The main result is ready.",
          turnId,
          streaming: false,
          createdAt: "2026-04-01T00:00:01.000Z",
          updatedAt: "2026-04-01T00:00:02.000Z",
        },
        {
          id: MessageId.make("assistant-middle"),
          role: "assistant",
          text: "I am checking one more detail.",
          turnId,
          streaming: false,
          createdAt: "2026-04-01T00:00:03.000Z",
          updatedAt: "2026-04-01T00:00:04.000Z",
        },
        {
          id: MessageId.make("assistant-final"),
          role: "assistant",
          text: "Verification finished.",
          turnId,
          streaming: false,
          createdAt: "2026-04-01T00:00:05.000Z",
          updatedAt: "2026-04-01T00:00:06.000Z",
        },
      ],
    });

    const feed = buildThreadFeed(thread);
    const rows = deriveThreadFeedPresentation(feed, thread.latestTurn, new Set());

    expect(rows.map((entry) => entry.id)).toEqual([
      "assistant-first",
      "turn-fold:turn-1",
      "assistant-final",
    ]);
  });

  it("measures a steer-superseded turn from its user boundary through trailing work", () => {
    const firstTurnId = TurnId.make("turn-1");
    const secondTurnId = TurnId.make("turn-2");
    const thread = makeThread({
      id: ThreadId.make("thread-steered"),
      projectId: ProjectId.make("project-1"),
      title: "Steered work",
      latestTurn: {
        turnId: secondTurnId,
        state: "running",
        requestedAt: "2026-04-01T00:00:14.000Z",
        startedAt: "2026-04-01T00:00:14.000Z",
        completedAt: null,
        assistantMessageId: MessageId.make("assistant-next"),
      },
      messages: [
        {
          id: MessageId.make("user-1"),
          role: "user",
          text: "Do it once more.",
          turnId: null,
          streaming: false,
          createdAt: "2026-04-01T00:00:00.000Z",
          updatedAt: "2026-04-01T00:00:00.000Z",
        },
        {
          id: MessageId.make("assistant-commentary"),
          role: "assistant",
          text: "Kicking off call 1.",
          turnId: firstTurnId,
          streaming: false,
          createdAt: "2026-04-01T00:00:09.000Z",
          updatedAt: "2026-04-01T00:00:09.000Z",
        },
        {
          id: MessageId.make("user-2"),
          role: "user",
          text: "Actually do 15.",
          turnId: null,
          streaming: false,
          createdAt: "2026-04-01T00:00:14.000Z",
          updatedAt: "2026-04-01T00:00:14.000Z",
        },
        {
          id: MessageId.make("assistant-next"),
          role: "assistant",
          text: "One down - adjusting.",
          turnId: secondTurnId,
          streaming: true,
          createdAt: "2026-04-01T00:00:17.000Z",
          updatedAt: "2026-04-01T00:00:17.000Z",
        },
      ],
      activities: [
        makeActivity({
          id: EventId.make("work-1"),
          kind: "tool.completed",
          tone: "tool",
          summary: "Ran command",
          createdAt: "2026-04-01T00:00:12.000Z",
          turnId: firstTurnId,
          payload: {
            title: "Ran command",
            itemType: "command_execution",
            status: "completed",
          },
        }),
      ],
    });

    const feed = buildThreadFeed(thread);
    const collapsed = deriveThreadFeedPresentation(feed, thread.latestTurn, new Set());
    expect(collapsed.find((entry) => entry.type === "turn-fold")).toMatchObject({
      turnId: firstTurnId,
      label: "Worked for 12s",
    });
  });

  it("keeps an active turn expanded and classifies error-shaped tool output", () => {
    const turnId = TurnId.make("turn-running");
    const thread = makeThread({
      id: ThreadId.make("thread-4"),
      projectId: ProjectId.make("project-1"),
      title: "Running work",
      latestTurn: {
        turnId,
        state: "running",
        requestedAt: "2026-04-01T00:00:00.000Z",
        startedAt: "2026-04-01T00:00:01.000Z",
        completedAt: null,
        assistantMessageId: null,
      },
      activities: [
        makeActivity({
          id: EventId.make("tool-failed"),
          kind: "tool.completed",
          tone: "tool",
          summary: "Run command",
          createdAt: "2026-04-01T00:00:05.000Z",
          turnId,
          payload: {
            title: "Run command",
            itemType: "command_execution",
            detail: "zsh: command not found: nope",
            status: "completed",
          },
        }),
      ],
    });

    const feed = buildThreadFeed(thread);
    expect(deriveThreadFeedPresentation(feed, thread.latestTurn, new Set())).toEqual(feed);
    expect(feed[0]).toMatchObject({
      type: "activity-group",
      activities: [{ status: "failure" }],
    });
  });

  it("appends active work as a normal timeline row", () => {
    const startedAt = "2026-04-01T00:00:01.000Z";
    const presented = deriveThreadFeedPresentation([], null, new Set(), new Set(), startedAt);

    expect(presented).toEqual([
      {
        type: "working",
        id: "working-indicator-row",
        createdAt: startedAt,
      },
    ]);
    expect(deriveThreadFeedPresentation(presented, null, new Set())).toEqual([]);
  });

  it("models work-log overflow as list rows", () => {
    const activity = (
      id: string,
      createdAt: string,
      status: ThreadFeedActivity["status"] = "success",
    ): ThreadFeedActivity => ({
      id,
      createdAt,
      turnId: null,
      summary: `Tool ${id}`,
      detail: null,
      canExpand: false,
      getFullDetail: () => null,
      getCopyText: () => id,
      icon: "command",
      toolLike: true,
      status,
    });
    const feed: ThreadFeedEntry[] = [
      {
        type: "activity-group",
        id: "work-group-1",
        createdAt: "2026-04-01T00:00:01.000Z",
        turnId: null,
        activities: [
          activity("activity-1", "2026-04-01T00:00:01.000Z"),
          activity("activity-neutral", "2026-04-01T00:00:02.000Z", "neutral"),
          activity("activity-2", "2026-04-01T00:00:03.000Z"),
          activity("activity-3", "2026-04-01T00:00:04.000Z"),
        ],
      },
    ];

    const collapsed = deriveThreadFeedPresentation(feed, null, new Set());
    expect(collapsed.map((entry) => entry.id)).toEqual(["activity-3", "work-toggle:work-group-1"]);
    expect(collapsed[1]).toMatchObject({
      type: "work-toggle",
      groupId: "work-group-1",
      hiddenCount: 2,
      expanded: false,
    });

    const expanded = deriveThreadFeedPresentation(feed, null, new Set(), new Set(["work-group-1"]));
    expect(expanded.map((entry) => entry.id)).toEqual([
      "activity-1",
      "activity-2",
      "activity-3",
      "work-toggle:work-group-1",
    ]);
    expect(expanded.at(-1)).toMatchObject({
      type: "work-toggle",
      expanded: true,
    });
  });
});

describe("promoteSteeredQueuedMessages", () => {
  const steeredId = MessageId.make("msg-steered");
  const waitingId = MessageId.make("msg-waiting");

  function makeQueuedThread() {
    return makeThread({
      id: ThreadId.make("thread-steer"),
      projectId: ProjectId.make("project-steer"),
      title: "Steer thread",
      queuedMessages: [
        {
          messageId: steeredId,
          text: "send this one now",
          attachments: [],
          queuedAt: "2026-04-01T00:00:05.000Z",
        },
        {
          messageId: waitingId,
          text: "this one waits",
          attachments: [],
          queuedAt: "2026-04-01T00:00:06.000Z",
        },
      ],
    });
  }

  it("moves only the steered message into the conversation", () => {
    const promoted = promoteSteeredQueuedMessages(makeQueuedThread(), new Set([steeredId]));

    expect(promoted.messages.map((message) => message.id)).toEqual([steeredId]);
    expect(promoted.messages[0]).toMatchObject({ role: "user", text: "send this one now" });
    // Still server-queued until the dispatch lands — chip lists drop it because
    // it is now in the timeline, not because the queue changed.
    expect(promoted.queuedMessages.map((entry) => entry.messageId)).toEqual([steeredId, waitingId]);
  });

  it("reverts by dropping the id, restoring the queue-only view", () => {
    const thread = makeQueuedThread();

    expect(promoteSteeredQueuedMessages(thread, new Set())).toBe(thread);
    expect(promoteSteeredQueuedMessages(thread, new Set([steeredId])).messages).toHaveLength(1);
    expect(promoteSteeredQueuedMessages(thread, new Set()).messages).toHaveLength(0);
  });

  it("does not duplicate a message the server has already persisted", () => {
    const thread = makeQueuedThread();
    const persisted = {
      ...thread,
      messages: [
        {
          id: steeredId,
          role: "user" as const,
          text: "send this one now",
          turnId: TurnId.make("turn-1"),
          streaming: false,
          createdAt: "2026-04-01T00:00:07.000Z",
          updatedAt: "2026-04-01T00:00:07.000Z",
        },
      ],
    };

    expect(promoteSteeredQueuedMessages(persisted, new Set([steeredId])).messages).toHaveLength(1);
  });
});

describe("quiet timeline: nested agents", () => {
  it("keeps a nested agent's terminal row but hides its background work", () => {
    const thread = makeThread({
      id: ThreadId.make("thread-nested"),
      projectId: ProjectId.make("project-1"),
      title: "Nested agents",
      activities: [
        // A subagent's own shell: internal, covered by the owner's liveness.
        makeActivity({
          id: EventId.make("shell-done"),
          kind: "task.completed",
          summary: "Task completed",
          createdAt: "2026-04-01T00:00:02.000Z",
          payload: { taskId: "sh-1", agentId: "owner", agentKind: "background" },
        }),
        // A nested AGENT's completion: mobile has no Agents sheet, so this
        // terminal row is the only signal it ever finished.
        makeActivity({
          id: EventId.make("nested-done"),
          kind: "task.completed",
          summary: "Task completed",
          createdAt: "2026-04-01T00:00:03.000Z",
          payload: { taskId: "n-1", agentId: "owner", agentKind: "agent" },
        }),
      ],
    });

    const feed = buildThreadFeed(thread);
    const ids = feed.flatMap((entry) =>
      entry.type === "activity-group" ? entry.activities.map((row) => row.id) : [],
    );
    expect(ids).toContain("nested-done");
    expect(ids).not.toContain("shell-done");
  });
});
