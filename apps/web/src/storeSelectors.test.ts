import {
  EnvironmentId,
  EventId,
  type OrchestrationThreadActivity,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { type AppState, type EnvironmentState } from "./store";
import { createContextWindowSnapshotSelectorByRef } from "./storeSelectors";

const environmentId = EnvironmentId.make("environment-local");
const threadId = ThreadId.make("thread-1");
const threadRef = { environmentId, threadId };

function makeActivity(id: string, kind: string, payload: unknown): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    tone: "info",
    kind,
    summary: kind,
    payload,
    turnId: TurnId.make("turn-1"),
    createdAt: `2026-06-17T16:00:${id.padStart(2, "0")}.000Z`,
  };
}

function makeState(activities: ReadonlyArray<OrchestrationThreadActivity>): AppState {
  const environmentState: EnvironmentState = {
    projectIds: [],
    projectById: {},
    threadIds: [threadId],
    threadIdsByProjectId: {},
    threadShellById: {},
    threadSessionById: {},
    threadTurnStateById: {},
    messageIdsByThreadId: {},
    messageByThreadId: {},
    activityIdsByThreadId: {
      [threadId]: activities.map((activity) => activity.id),
    },
    activityByThreadId: {
      [threadId]: Object.fromEntries(
        activities.map((activity) => [activity.id, activity] as const),
      ) as Record<string, OrchestrationThreadActivity>,
    },
    proposedPlanIdsByThreadId: {},
    proposedPlanByThreadId: {},
    turnDiffIdsByThreadId: {},
    turnDiffSummaryByThreadId: {},
    sidebarThreadSummaryById: {},
    bootstrapComplete: true,
  };
  return {
    activeEnvironmentId: environmentId,
    environmentStateById: {
      [environmentId]: environmentState,
    },
  };
}

describe("storeSelectors", () => {
  it("reuses the context window snapshot when unrelated activities append", () => {
    const contextActivity = makeActivity("1", "context-window.updated", {
      usedTokens: 42_000,
      maxTokens: 258_000,
      totalProcessedTokens: 90_000,
    });
    const selector = createContextWindowSnapshotSelectorByRef(threadRef);

    const first = selector(makeState([contextActivity]));
    const second = selector(
      makeState([contextActivity, makeActivity("2", "tool.completed", { toolName: "profile" })]),
    );

    expect(first).not.toBeNull();
    expect(second).toBe(first);
  });

  it("returns a new context window snapshot when context usage changes", () => {
    const selector = createContextWindowSnapshotSelectorByRef(threadRef);
    const first = selector(
      makeState([
        makeActivity("1", "context-window.updated", {
          usedTokens: 42_000,
          maxTokens: 258_000,
        }),
      ]),
    );
    const second = selector(
      makeState([
        makeActivity("1", "context-window.updated", {
          usedTokens: 42_000,
          maxTokens: 258_000,
        }),
        makeActivity("2", "context-window.updated", {
          usedTokens: 43_000,
          maxTokens: 258_000,
        }),
      ]),
    );

    expect(first).not.toBeNull();
    expect(second).not.toBe(first);
    expect(second?.usedTokens).toBe(43_000);
  });
});
