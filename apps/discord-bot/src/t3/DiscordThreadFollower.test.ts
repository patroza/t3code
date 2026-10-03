import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { EventId, type OrchestrationV2ThreadStreamItem } from "@t3tools/contracts";
import { v2Projection, v2Now, v2ThreadId } from "./nativeThreadTestFixtures.ts";
import {
  applyDiscordThreadStreamItem,
  initialDiscordThreadFollowerState,
  planThreadFollowerReconnectSeed,
  followOrchestrationThread,
} from "./DiscordThreadFollower.ts";

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

describe("native Discord thread stream", () => {
  it("seeds the native projection without an HTTP reload", () => {
    const result = applyDiscordThreadStreamItem(initialDiscordThreadFollowerState(), {
      kind: "snapshot",
      snapshotSequence: 10,
      projection: v2Projection,
    });
    expect(result._tag).toBe("deliver");
    expect(result.state.current).toBe(v2Projection);
    expect(result.state.lastSequence).toBe(10);
  });
  it("applies native metadata events and ignores replayed events", () => {
    const state = { current: v2Projection, lastSequence: 10 };
    const item: OrchestrationV2ThreadStreamItem = {
      kind: "event",
      sequence: 11,
      event: {
        id: EventId.make("event-1"),
        threadId: v2ThreadId,
        occurredAt: v2Now,
        type: "thread.metadata-updated",
        payload: { ...v2Projection.thread, title: "Updated" },
      },
    };
    const result = applyDiscordThreadStreamItem(state, item);
    expect(result._tag).toBe("deliver");
    expect(result.state.current?.thread.title).toBe("Updated");
    expect(applyDiscordThreadStreamItem(result.state, item)._tag).toBe("none");
  });
  it("requests a base snapshot when a native event arrives before a base", () => {
    const result = applyDiscordThreadStreamItem(initialDiscordThreadFollowerState(), {
      kind: "event",
      sequence: 1,
      event: {
        id: EventId.make("event-1"),
        threadId: v2ThreadId,
        occurredAt: v2Now,
        type: "thread.metadata-updated",
        payload: v2Projection.thread,
      },
    });
    expect(result._tag).toBe("reload-required");
  });
  it("drops the retained projection when the thread is deleted", () => {
    const result = applyDiscordThreadStreamItem(
      { current: v2Projection, lastSequence: 10 },
      {
        kind: "event",
        sequence: 11,
        event: {
          id: EventId.make("delete-1"),
          threadId: v2ThreadId,
          occurredAt: v2Now,
          type: "thread.metadata-updated",
          payload: { ...v2Projection.thread, deletedAt: v2Now },
        },
      },
    );
    expect(result._tag).toBe("deleted");
    expect(result.state.current).toBeNull();
  });
});

it.effect("resumes native warm state and applies streamed metadata without snapshot fetches", () =>
  Effect.gen(function* () {
    const delivered: string[] = [];
    const retained: string[] = [];
    let snapshotFetches = 0;
    yield* followOrchestrationThread({
      threadId: v2ThreadId,
      warmSeed: { snapshotSequence: 10, projection: v2Projection },
      openStream: ({ afterSequence }) => {
        expect(afterSequence).toBe(10);
        return Stream.make({
          kind: "event",
          sequence: 11,
          event: {
            id: EventId.make("stream-metadata"),
            threadId: v2ThreadId,
            occurredAt: v2Now,
            type: "thread.metadata-updated",
            payload: { ...v2Projection.thread, title: "Live title" },
          },
        } as const);
      },
      fetchSnapshot: () =>
        Effect.sync(() => {
          snapshotFetches += 1;
          return null;
        }),
      onThread: (view) =>
        Effect.sync(() => {
          delivered.push(view.title);
        }),
      onProjection: (projection) =>
        Effect.sync(() => {
          retained.push(projection.thread.title);
        }),
      retryForever: false,
    });
    expect(snapshotFetches).toBe(0);
    expect(delivered).toEqual([v2Projection.thread.title, "Live title"]);
    expect(retained).toEqual(delivered);
  }),
);
