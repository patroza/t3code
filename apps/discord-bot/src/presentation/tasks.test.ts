import { TurnId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { formatTasksForDiscord, presentTasks } from "./tasks.ts";

function plan(
  id: string,
  turnId: string | null,
  createdAt: string,
  steps: ReadonlyArray<Record<string, unknown>>,
  explanation?: string,
): OrchestrationThreadActivity {
  return {
    id,
    kind: "turn.plan.updated",
    tone: "info",
    summary: "Plan updated",
    payload: {
      plan: steps,
      ...(explanation === undefined ? {} : { explanation }),
    },
    turnId,
    createdAt,
  } as OrchestrationThreadActivity;
}

describe("presentTasks", () => {
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

describe("formatTasksForDiscord", () => {
  it("renders a compact progress summary", () => {
    const rendered = formatTasksForDiscord({
      contextKey: "turn-2",
      createdAt: "2026-07-16T00:00:01.000Z",
      explanation: "Keep one task message updated",
      tasks: [
        { step: "Ship task", status: "inProgress" },
        { step: "Verify", status: "completed" },
      ],
    });

    expect(rendered).toContain("**Tasks 1/2**");
    expect(rendered).toContain("_Keep one task message updated_");
    expect(rendered).toContain("◐ Ship task");
    expect(rendered).toContain("✅ Verify");
  });
});
