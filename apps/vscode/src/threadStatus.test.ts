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

  it("shows a settled turn as completed", () => {
    expect(
      resolveThreadDisplayStatus({
        latestTurn: { state: "completed" },
        session: { status: "ready" },
      }),
    ).toEqual({ kind: "completed", label: "Completed" });
  });
});
