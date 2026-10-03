import { describe, expect, it } from "vite-plus/test";
import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import { deriveResolvedUserInputTranscripts } from "./userInputTranscript.ts";

function activity(kind: string, payload: unknown, sequence: number): OrchestrationThreadActivity {
  return {
    id: `event-${sequence}`,
    kind,
    payload,
    sequence,
    summary: kind,
    tone: "info",
    turnId: null,
    createdAt: `2026-07-11T00:00:0${sequence}.000Z`,
  } as OrchestrationThreadActivity;
}

describe("deriveResolvedUserInputTranscripts", () => {
  it("pairs questions with free-form, selectable, multi-select, and Other answers", () => {
    const result = deriveResolvedUserInputTranscripts([
      activity(
        "user-input.requested",
        {
          requestId: "request-1",
          questions: [
            { id: "goal", header: "Goal", question: "What is the goal?", options: [] },
            { id: "mode", header: "Mode", question: "Which mode?", options: [] },
            { id: "targets", header: "Targets", question: "Which targets?", options: [] },
            { id: "other", header: "Other", question: "Anything else?", options: [] },
          ],
        },
        1,
      ),
      activity(
        "user-input.resolved",
        {
          requestId: "request-1",
          answers: {
            goal: "Make it genuinely sleep",
            mode: "Keep it",
            targets: ["Web", "Mobile"],
            other: "Use the existing dGPU only on demand",
          },
        },
        2,
      ),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]?.preview).toBe(
      "Make it genuinely sleep · Keep it · Web, Mobile · Use the existing dGPU only on demand",
    );
    expect(result[0]?.detail).toContain("What is the goal?\nMake it genuinely sleep");
    expect(result[0]?.detail).toContain("Which targets?\nWeb, Mobile");
  });
});
