import { describe, expect, it } from "vite-plus/test";

import {
  buildPlanImplementationPrompt,
  findLatestProposedPlan,
  hasActionableProposedPlan,
  proposedPlanTitle,
  resolvePlanFollowUpSubmission,
  shouldShowPlanFollowUpComposer,
  stripDisplayedPlanMarkdown,
} from "./proposedPlan.ts";

describe("proposedPlan shared helpers", () => {
  it("extracts titles and strips display chrome", () => {
    expect(proposedPlanTitle("# Ship it\n\nBody")).toBe("Ship it");
    expect(stripDisplayedPlanMarkdown("# Ship it\n\n## Summary\n\nDo the thing")).toBe(
      "Do the thing",
    );
  });

  it("maps plan follow-up submissions", () => {
    expect(
      resolvePlanFollowUpSubmission({ draftText: "", planMarkdown: "# Plan\n\n- step" }),
    ).toEqual({
      text: buildPlanImplementationPrompt("# Plan\n\n- step"),
      interactionMode: "default",
    });
    expect(
      resolvePlanFollowUpSubmission({
        draftText: "prefer REST",
        planMarkdown: "# Plan",
      }),
    ).toEqual({ text: "prefer REST", interactionMode: "plan" });
  });

  it("finds the latest plan and actionability", () => {
    const plans = [
      {
        id: "p1",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        turnId: "t1",
        planMarkdown: "# Old",
        implementedAt: null,
        implementationThreadId: null,
      },
      {
        id: "p2",
        createdAt: "2026-01-01T00:00:01.000Z",
        updatedAt: "2026-01-01T00:00:02.000Z",
        turnId: "t2",
        planMarkdown: "# New",
        implementedAt: null,
        implementationThreadId: null,
      },
    ];
    expect(findLatestProposedPlan(plans, "t2")?.id).toBe("p2");
    expect(hasActionableProposedPlan(plans[1]!)).toBe(true);
    expect(
      shouldShowPlanFollowUpComposer({
        interactionMode: "plan",
        hasPendingUserInput: false,
        proposedPlan: plans[1]!,
      }),
    ).toBe(true);
  });
});
