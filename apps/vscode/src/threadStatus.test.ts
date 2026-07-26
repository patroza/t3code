import { describe, expect, it } from "vite-plus/test";

import { resolveThreadDisplayStatus } from "./threadStatus.ts";

describe("resolveThreadDisplayStatus", () => {
  it("shows a live running thread as working", () => {
    expect(
      resolveThreadDisplayStatus({
        latestTurn: { state: "running" },
        session: { status: "running" },
      }),
    ).toEqual({ kind: "working", label: "Working" });
  });

  it("prioritizes an interrupted session over its stale running turn", () => {
    expect(
      resolveThreadDisplayStatus({
        latestTurn: { state: "running" },
        session: { status: "interrupted" },
      }),
    ).toEqual({ kind: "needs-wake-up", label: "Needs wake up" });
  });

  it("does not wake-require a zombie interrupted session with a completed turn", () => {
    expect(
      resolveThreadDisplayStatus({
        latestTurn: { state: "completed", completedAt: "2026-07-01T00:00:00.000Z" },
        session: { status: "interrupted", activeTurnId: null },
      }),
    ).toEqual({ kind: "completed", label: "Completed" });
  });

  it("shows a settled turn as completed", () => {
    expect(
      resolveThreadDisplayStatus({
        latestTurn: { state: "completed" },
        session: { status: "ready" },
      }),
    ).toEqual({ kind: "completed", label: "Completed" });
  });

  it("shows plan ready over working when a plan is actionable", () => {
    expect(
      resolveThreadDisplayStatus({
        latestTurn: { state: "running" },
        session: { status: "running" },
        interactionMode: "plan",
        hasActionableProposedPlan: true,
      }),
    ).toEqual({ kind: "plan-ready", label: "Plan Ready" });
  });
});
