import { describe, expect, it } from "vite-plus/test";
import {
  clearSteerTimelineBoundaryStore,
  compareSteerTimelineSortable,
  findMidTurnSteerUserIds,
  observeSteerTextBoundary,
  splitAssistantTextAtSteers,
  steerTimelineBoundaryKey,
} from "./steerTimeline.ts";

describe("observeSteerTextBoundary", () => {
  it("freezes the first observed length and ignores later growth", () => {
    const store = new Map<string, number>();
    expect(observeSteerTextBoundary("a1", "s1", 10, store)).toBe(10);
    expect(observeSteerTextBoundary("a1", "s1", 40, store)).toBe(10);
    expect(store.get(steerTimelineBoundaryKey("a1", "s1"))).toBe(10);
  });

  it("clamps when text shrinks below the observed boundary", () => {
    const store = new Map<string, number>();
    observeSteerTextBoundary("a1", "s1", 10, store);
    expect(observeSteerTextBoundary("a1", "s1", 4, store)).toBe(4);
  });
});

describe("splitAssistantTextAtSteers", () => {
  it("returns the original message when no steers follow its start", () => {
    const store = new Map<string, number>();
    const segments = splitAssistantTextAtSteers({
      assistantMessageId: "a1",
      assistantCreatedAt: "2026-01-01T00:01:05Z",
      text: "hello",
      streaming: true,
      steers: [{ id: "s0", createdAt: "2026-01-01T00:01:00Z" }],
      boundaryStore: store,
    });
    expect(segments).toEqual([
      {
        segmentId: "a1",
        text: "hello",
        sortAt: "2026-01-01T00:01:05Z",
        sortRank: 0,
        streaming: true,
      },
    ]);
  });

  it("splits pre/post at the first observed boundary and keeps later tokens post-steer", () => {
    const store = new Map<string, number>();
    const first = splitAssistantTextAtSteers({
      assistantMessageId: "a1",
      assistantCreatedAt: "2026-01-01T00:01:05Z",
      text: "pre text",
      streaming: true,
      steers: [{ id: "s1", createdAt: "2026-01-01T00:08:30Z" }],
      boundaryStore: store,
    });
    expect(first).toEqual([
      {
        segmentId: "a1::pre",
        text: "pre text",
        sortAt: "2026-01-01T00:01:05Z",
        sortRank: 0,
        streaming: false,
      },
      {
        segmentId: "a1::after::s1",
        text: "",
        sortAt: "2026-01-01T00:08:30Z",
        sortRank: 2,
        streaming: true,
      },
    ]);

    const second = splitAssistantTextAtSteers({
      assistantMessageId: "a1",
      assistantCreatedAt: "2026-01-01T00:01:05Z",
      text: "pre text and more after steer",
      streaming: true,
      steers: [{ id: "s1", createdAt: "2026-01-01T00:08:30Z" }],
      boundaryStore: store,
    });
    expect(second).toEqual([
      {
        segmentId: "a1::pre",
        text: "pre text",
        sortAt: "2026-01-01T00:01:05Z",
        sortRank: 0,
        streaming: false,
      },
      {
        segmentId: "a1::after::s1",
        text: " and more after steer",
        sortAt: "2026-01-01T00:08:30Z",
        sortRank: 2,
        streaming: true,
      },
    ]);
  });

  it("keeps an empty streaming post segment so the cursor can sit after the steer", () => {
    const store = new Map<string, number>();
    observeSteerTextBoundary("a1", "s1", 5, store);
    const segments = splitAssistantTextAtSteers({
      assistantMessageId: "a1",
      assistantCreatedAt: "2026-01-01T00:01:05Z",
      text: "hello",
      streaming: true,
      steers: [{ id: "s1", createdAt: "2026-01-01T00:08:30Z" }],
      boundaryStore: store,
    });
    expect(segments).toEqual([
      {
        segmentId: "a1::pre",
        text: "hello",
        sortAt: "2026-01-01T00:01:05Z",
        sortRank: 0,
        streaming: false,
      },
      {
        segmentId: "a1::after::s1",
        text: "",
        sortAt: "2026-01-01T00:08:30Z",
        sortRank: 2,
        streaming: true,
      },
    ]);
  });
});

describe("findMidTurnSteerUserIds", () => {
  it("returns user messages after the turn-start boundary", () => {
    const steers = findMidTurnSteerUserIds({
      items: [
        {
          id: "u0",
          createdAt: "2026-01-01T00:00:00Z",
          isUser: true,
          belongsToActiveTurn: false,
        },
        {
          id: "u1",
          createdAt: "2026-01-01T00:01:00Z",
          isUser: true,
          belongsToActiveTurn: false,
        },
        {
          id: "a1",
          createdAt: "2026-01-01T00:01:05Z",
          isUser: false,
          belongsToActiveTurn: true,
        },
        {
          id: "s1",
          createdAt: "2026-01-01T00:08:30Z",
          isUser: true,
          belongsToActiveTurn: false,
        },
      ],
    });
    expect(steers).toEqual([{ id: "s1", createdAt: "2026-01-01T00:08:30Z" }]);
  });
});

describe("compareSteerTimelineSortable", () => {
  it("orders post-steer assistant after the steer at the same timestamp", () => {
    const ordered = [
      { id: "post", sortAt: "2026-01-01T00:08:30Z", sortRank: 2 },
      { id: "steer", sortAt: "2026-01-01T00:08:30Z", sortRank: 1 },
      { id: "pre", sortAt: "2026-01-01T00:01:05Z", sortRank: 0 },
    ].toSorted(compareSteerTimelineSortable);
    expect(ordered.map((item) => item.id)).toEqual(["pre", "steer", "post"]);
  });
});

describe("clearSteerTimelineBoundaryStore", () => {
  it("empties the default store", () => {
    observeSteerTextBoundary("a1", "s1", 3);
    clearSteerTimelineBoundaryStore();
    expect(observeSteerTextBoundary("a1", "s1", 9)).toBe(9);
    clearSteerTimelineBoundaryStore();
  });
});
