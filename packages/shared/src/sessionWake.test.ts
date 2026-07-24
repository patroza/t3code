import { describe, expect, it } from "vite-plus/test";

import {
  resolveOrphanSettleSessionStatus,
  sessionHadInProgressWork,
  sessionNeedsWakeUp,
} from "./sessionWake.ts";

describe("sessionHadInProgressWork", () => {
  it("is true when an active turn id is set", () => {
    expect(sessionHadInProgressWork({ activeTurnId: "turn-1" })).toBe(true);
  });

  it("is true when the latest turn is still running", () => {
    expect(sessionHadInProgressWork({ latestTurnState: "running" })).toBe(true);
  });

  it("is true for pending approval / user input", () => {
    expect(sessionHadInProgressWork({ hasPendingApprovals: true })).toBe(true);
    expect(sessionHadInProgressWork({ hasPendingUserInput: true })).toBe(true);
  });

  it("is false for a zombie running session with a completed turn and no active id", () => {
    expect(
      sessionHadInProgressWork({
        activeTurnId: null,
        latestTurnState: "completed",
      }),
    ).toBe(false);
  });
});

describe("resolveOrphanSettleSessionStatus", () => {
  it("interrupts only when work was in progress", () => {
    expect(resolveOrphanSettleSessionStatus({ hadInProgressWork: true })).toBe("interrupted");
    expect(resolveOrphanSettleSessionStatus({ hadInProgressWork: false })).toBe("ready");
  });

  it("allows stopped as the in-progress preferred status", () => {
    expect(
      resolveOrphanSettleSessionStatus({
        hadInProgressWork: true,
        preferredWhenInProgress: "stopped",
      }),
    ).toBe("stopped");
  });
});

describe("sessionNeedsWakeUp", () => {
  it("requires interrupted session status", () => {
    expect(
      sessionNeedsWakeUp({
        sessionStatus: "ready",
        latestTurnState: "running",
      }),
    ).toBe(false);
  });

  it("wakes when interrupted mid-turn (stale running latest turn)", () => {
    expect(
      sessionNeedsWakeUp({
        sessionStatus: "interrupted",
        activeTurnId: null,
        latestTurnState: "running",
      }),
    ).toBe(true);
  });

  it("does not wake zombie interrupted sessions with a completed turn", () => {
    expect(
      sessionNeedsWakeUp({
        sessionStatus: "interrupted",
        activeTurnId: null,
        latestTurnState: "completed",
        latestTurnCompletedAt: "2026-07-01T00:00:00.000Z",
      }),
    ).toBe(false);
  });

  it("does not wake interrupted sessions with no turn at all", () => {
    expect(
      sessionNeedsWakeUp({
        sessionStatus: "interrupted",
        activeTurnId: null,
        latestTurnState: null,
      }),
    ).toBe(false);
  });

  it("wakes interrupted turns that never completed", () => {
    expect(
      sessionNeedsWakeUp({
        sessionStatus: "interrupted",
        latestTurnState: "interrupted",
        latestTurnCompletedAt: null,
      }),
    ).toBe(true);
  });
});
