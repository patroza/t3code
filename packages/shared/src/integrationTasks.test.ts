import type { IntegrationActivity as OrchestrationThreadActivity } from "./integrationThreadView.ts";
import { TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { presentTasks } from "./integrationTasks.ts";

function plan(
  id: string,
  turnId: string | null,
  createdAt: string,
  steps: ReadonlyArray<Record<string, unknown>>,
): OrchestrationThreadActivity {
  return {
    id,
    kind: "turn.plan.updated",
    tone: "info",
    summary: "Plan updated",
    payload: { plan: steps },
    turnId,
    createdAt,
  } as OrchestrationThreadActivity;
}

describe("presentTasks", () => {
  it("prefers the latest plan for the active turn", () => {
    expect(
      presentTasks(
        [
          plan("old", "turn-1", "2026-07-11T00:00:00.000Z", [
            { step: "Old task", status: "pending" },
          ]),
          plan("current", "turn-2", "2026-07-11T00:00:01.000Z", [
            { step: "Ship tasks", status: "inProgress" },
            { step: "Verify", status: "completed" },
          ]),
        ],
        TurnId.make("turn-2"),
      ),
    ).toMatchObject({
      tasks: [
        { step: "Ship tasks", status: "inProgress" },
        { step: "Verify", status: "completed" },
      ],
    });
  });

  it("falls back to the most recent plan across previous turns", () => {
    expect(
      presentTasks(
        [plan("old", "turn-1", "2026-07-11T00:00:00.000Z", [{ step: "Persist" }])],
        TurnId.make("turn-2"),
      )?.tasks,
    ).toEqual([{ step: "Persist", status: "pending" }]);
  });
});

describe("presentTasks context key", () => {
  it("uses the active turn id as the task context key", () => {
    expect(
      presentTasks(
        [
          plan("old", "turn-1", "2026-07-16T00:00:00.000Z", [{ step: "Old task" }]),
          plan("current", "turn-2", "2026-07-16T00:00:01.000Z", [{ step: "Ship task" }]),
        ],
        TurnId.make("turn-2"),
      ),
    ).toMatchObject({
      contextKey: "turn-2",
      tasks: [{ step: "Ship task", status: "pending" }],
    });
  });

  it("falls back to the activity id when the plan is not attached to a turn", () => {
    expect(
      presentTasks(
        [plan("evt-plan", null, "2026-07-16T00:00:00.000Z", [{ step: "Detached task" }])],
        null,
      ),
    ).toMatchObject({
      contextKey: "evt-plan",
      tasks: [{ step: "Detached task", status: "pending" }],
    });
  });
});
