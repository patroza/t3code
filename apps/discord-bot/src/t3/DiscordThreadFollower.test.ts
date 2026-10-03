import { describe, expect, it } from "vite-plus/test";
import type { OrchestrationThread, OrchestrationThreadStreamItem } from "@t3tools/contracts";

import {
  applyDiscordThreadStreamItem,
  initialDiscordThreadFollowerState,
  planThreadFollowerReconnectSeed,
} from "./DiscordThreadFollower.ts";

const baseThread = (overrides?: Partial<OrchestrationThread>): OrchestrationThread =>
  ({
    id: "thread-1",
    projectId: "project-1",
    title: "t",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    messages: [],
    activities: [],
    proposedPlans: [],
    checkpoints: [],
    latestTurn: null,
    session: null,
    worktreePath: null,
    modelSelection: null,
    ...overrides,
  }) as OrchestrationThread;

describe("planThreadFollowerReconnectSeed", () => {
  it("replays warm tip only on the first seed this process", () => {
    expect(planThreadFollowerReconnectSeed({ lastAppliedSequence: -1, hasWarmSeed: true })).toBe(
      "replay-warm",
    );
    expect(planThreadFollowerReconnectSeed({ lastAppliedSequence: -1, hasWarmSeed: false })).toBe(
      "http-or-cold",
    );
  });

  it("resumes after disconnect without replaying warm tip (no old finals at tip)", () => {
    // Production: SocketClose re-ran deliver(warmSeed) with a stale in-memory tip and
    // re-finalized Done.PR #156 after newer Discord turns.
    expect(
      planThreadFollowerReconnectSeed({ lastAppliedSequence: 104286, hasWarmSeed: true }),
    ).toBe("resume-after");
    expect(planThreadFollowerReconnectSeed({ lastAppliedSequence: 0, hasWarmSeed: false })).toBe(
      "resume-after",
    );
  });
});

describe("applyDiscordThreadStreamItem (client-runtime parity)", () => {
  it("applies embedded snapshots and advances sequence", () => {
    const thread = baseThread({ title: "from-snapshot" });
    const item: OrchestrationThreadStreamItem = {
      kind: "snapshot",
      snapshot: { snapshotSequence: 10, thread },
    };
    const result = applyDiscordThreadStreamItem(initialDiscordThreadFollowerState(), item);
    expect(result._tag).toBe("deliver");
    if (result._tag === "deliver") {
      expect(result.sequence).toBe(10);
      expect(result.thread.title).toBe("from-snapshot");
      expect(result.state.lastSequence).toBe(10);
    }
  });

  it("drops duplicate / older sequences", () => {
    const thread = baseThread();
    const state = initialDiscordThreadFollowerState({
      current: thread,
      lastSequence: 5,
    });
    const item: OrchestrationThreadStreamItem = {
      kind: "event",
      event: {
        type: "thread.title-updated",
        sequence: 5,
        threadId: "thread-1",
        title: "nope",
      } as OrchestrationThreadStreamItem extends { kind: "event"; event: infer E } ? E : never,
    };
    const result = applyDiscordThreadStreamItem(state, item);
    expect(result._tag).toBe("none");
    expect(result.state.lastSequence).toBe(5);
  });

  it("requests reload when an event arrives without a transcript", () => {
    const item: OrchestrationThreadStreamItem = {
      kind: "event",
      event: {
        type: "thread.title-updated",
        sequence: 1,
        threadId: "thread-1",
        title: "x",
      } as never,
    };
    const result = applyDiscordThreadStreamItem(initialDiscordThreadFollowerState(), item);
    expect(result._tag).toBe("reload-required");
  });

  it("applies thread.deleted via client-runtime reducer", () => {
    const state = initialDiscordThreadFollowerState({
      current: baseThread(),
      lastSequence: 1,
    });
    const item: OrchestrationThreadStreamItem = {
      kind: "event",
      event: {
        type: "thread.deleted",
        sequence: 2,
        occurredAt: "2026-04-01T02:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        payload: {
          threadId: "thread-1",
          deletedAt: "2026-04-01T02:00:00.000Z",
        },
      } as never,
    };
    const result = applyDiscordThreadStreamItem(state, item);
    expect(result._tag).toBe("deleted");
    if (result._tag === "deleted") {
      expect(result.state.current).toBeNull();
      expect(result.state.lastSequence).toBe(2);
    }
  });
});
