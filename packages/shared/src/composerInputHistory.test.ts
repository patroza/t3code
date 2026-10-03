import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_COMPOSER_INPUT_HISTORY,
  isComposerCursorOnFirstLine,
  isComposerCursorOnLastLine,
  navigateComposerInputHistory,
  normalizeComposerInputHistoryEntries,
  pushComposerInputHistory,
  recallComposerInputHistory,
  resolveComposerInputHistoryKeyAction,
  seedComposerInputHistoryFromConversation,
  shouldNavigateComposerInputHistory,
  type ComposerInputHistoryState,
} from "./composerInputHistory.ts";

describe("pushComposerInputHistory", () => {
  it("ignores empty and whitespace-only values but exits browsing", () => {
    const browsing: ComposerInputHistoryState = {
      entries: ["abc"],
      browsingIndex: 0,
      stashedDraft: "tmp",
    };
    expect(pushComposerInputHistory(browsing, "   ")).toEqual({
      entries: ["abc"],
      browsingIndex: null,
      stashedDraft: "",
    });
  });

  it("appends non-empty values and skips consecutive duplicates", () => {
    let state = pushComposerInputHistory(EMPTY_COMPOSER_INPUT_HISTORY, "abc");
    state = pushComposerInputHistory(state, "cba");
    state = pushComposerInputHistory(state, "cba");
    expect(state.entries).toEqual(["abc", "cba"]);
    expect(state.browsingIndex).toBeNull();
  });

  it("caps entries at maxEntries", () => {
    let state = EMPTY_COMPOSER_INPUT_HISTORY;
    state = pushComposerInputHistory(state, "one", { maxEntries: 2 });
    state = pushComposerInputHistory(state, "two", { maxEntries: 2 });
    state = pushComposerInputHistory(state, "three", { maxEntries: 2 });
    expect(state.entries).toEqual(["two", "three"]);
  });
});

describe("recallComposerInputHistory", () => {
  it("edits the recalled value and restores the existing draft on ArrowDown", () => {
    const recalled = recallComposerInputHistory(
      {
        entries: ["older"],
        browsingIndex: null,
        stashedDraft: "",
      },
      "queued follow-up",
      "unfinished draft",
    );
    expect(recalled.entries).toEqual(["older", "queued follow-up"]);
    expect(recalled.browsingIndex).toBe(1);
    expect(navigateComposerInputHistory(recalled, "down", "edited follow-up")).toMatchObject({
      handled: true,
      value: "unfinished draft",
      state: { browsingIndex: null },
    });
  });
});

describe("seedComposerInputHistoryFromConversation", () => {
  it("seeds from conversation when session history is empty", () => {
    const seeded = seedComposerInputHistoryFromConversation(EMPTY_COMPOSER_INPUT_HISTORY, [
      "first",
      " ",
      "second",
      "second",
      "third",
    ]);
    expect(seeded.entries).toEqual(["first", "second", "third"]);

    const step = navigateComposerInputHistory(seeded, "up", "draft");
    expect(step).toMatchObject({ handled: true, value: "third" });
  });

  it("does not overwrite existing session history", () => {
    const session = pushComposerInputHistory(EMPTY_COMPOSER_INPUT_HISTORY, "typed-this-session");
    const seeded = seedComposerInputHistoryFromConversation(session, ["older-thread-message"]);
    expect(seeded).toEqual(session);
  });

  it("leaves state empty when conversation has no user prompts", () => {
    expect(
      seedComposerInputHistoryFromConversation(EMPTY_COMPOSER_INPUT_HISTORY, ["  ", ""]),
    ).toEqual(EMPTY_COMPOSER_INPUT_HISTORY);
  });
});

describe("normalizeComposerInputHistoryEntries", () => {
  it("caps from the newest side", () => {
    expect(normalizeComposerInputHistoryEntries(["a", "b", "c"], { maxEntries: 2 })).toEqual([
      "b",
      "c",
    ]);
  });
});

describe("navigateComposerInputHistory", () => {
  it("matches shell-style up/down with draft restore", () => {
    let state = pushComposerInputHistory(EMPTY_COMPOSER_INPUT_HISTORY, "abc");
    state = pushComposerInputHistory(state, "cba");

    let step = navigateComposerInputHistory(state, "up", "ab");
    expect(step).toEqual({
      handled: true,
      state: {
        entries: ["abc", "cba"],
        browsingIndex: 1,
        stashedDraft: "ab",
      },
      value: "cba",
    });
    state = step.handled ? step.state : state;

    step = navigateComposerInputHistory(state, "up", "cba");
    expect(step).toMatchObject({ handled: true, value: "abc" });
    state = step.handled ? step.state : state;

    step = navigateComposerInputHistory(state, "down", "abc");
    expect(step).toMatchObject({ handled: true, value: "cba" });
    state = step.handled ? step.state : state;

    step = navigateComposerInputHistory(state, "down", "cba");
    expect(step).toEqual({
      handled: true,
      state: {
        entries: ["abc", "cba"],
        browsingIndex: null,
        stashedDraft: "",
      },
      value: "ab",
    });
  });

  it("stays on oldest entry when pressing up again", () => {
    let state = pushComposerInputHistory(EMPTY_COMPOSER_INPUT_HISTORY, "only");
    const first = navigateComposerInputHistory(state, "up", "draft");
    expect(first.handled).toBe(true);
    if (!first.handled) return;
    state = first.state;

    const again = navigateComposerInputHistory(state, "up", "only");
    expect(again).toEqual({ handled: true, state, value: "only" });
  });

  it("does not handle down when not browsing", () => {
    const state = pushComposerInputHistory(EMPTY_COMPOSER_INPUT_HISTORY, "abc");
    expect(navigateComposerInputHistory(state, "down", "live")).toEqual({ handled: false });
  });

  it("does not handle navigation with empty history", () => {
    expect(navigateComposerInputHistory(EMPTY_COMPOSER_INPUT_HISTORY, "up", "x")).toEqual({
      handled: false,
    });
  });

  it("preserves draft after editing a history entry and returning", () => {
    let state = pushComposerInputHistory(EMPTY_COMPOSER_INPUT_HISTORY, "abc");
    state = pushComposerInputHistory(state, "cba");

    let step = navigateComposerInputHistory(state, "up", "temporary");
    expect(step.handled).toBe(true);
    if (!step.handled) return;
    state = step.state;

    // User edits the history value in the input; navigation still uses entries.
    step = navigateComposerInputHistory(state, "down", "cba-edited");
    expect(step).toMatchObject({ handled: true, value: "temporary" });
  });
});

describe("resolveComposerInputHistoryKeyAction", () => {
  it("moves toward top/beginning before history on up", () => {
    // Mid multi-line → native caret movement first.
    expect(
      resolveComposerInputHistoryKeyAction({
        direction: "up",
        browsing: false,
        text: "line1\nline2",
        cursor: 8,
      }),
    ).toEqual({ action: "none" });

    // First line, not at start → jump to beginning.
    expect(
      resolveComposerInputHistoryKeyAction({
        direction: "up",
        browsing: false,
        text: "line1\nline2",
        cursor: 2,
      }),
    ).toEqual({ action: "move-caret", cursor: 0 });

    // Already at document start → history.
    expect(
      resolveComposerInputHistoryKeyAction({
        direction: "up",
        browsing: false,
        text: "line1\nline2",
        cursor: 0,
      }),
    ).toEqual({ action: "history" });
  });

  it("moves to end before history on down while browsing", () => {
    expect(
      resolveComposerInputHistoryKeyAction({
        direction: "down",
        browsing: true,
        text: "line1\nline2",
        cursor: 2,
      }),
    ).toEqual({ action: "none" });

    expect(
      resolveComposerInputHistoryKeyAction({
        direction: "down",
        browsing: true,
        text: "line1\nline2",
        cursor: 8,
      }),
    ).toEqual({ action: "move-caret", cursor: "line1\nline2".length });

    expect(
      resolveComposerInputHistoryKeyAction({
        direction: "down",
        browsing: true,
        text: "line1\nline2",
        cursor: "line1\nline2".length,
      }),
    ).toEqual({ action: "history" });
  });

  it("does not enter history on down when not browsing", () => {
    expect(
      resolveComposerInputHistoryKeyAction({
        direction: "down",
        browsing: false,
        text: "hello",
        cursor: 5,
      }),
    ).toEqual({ action: "none" });
  });

  it("while browsing multi-line history, requires start edge for up", () => {
    expect(
      resolveComposerInputHistoryKeyAction({
        direction: "up",
        browsing: true,
        text: "line1\nline2",
        cursor: 8,
      }),
    ).toEqual({ action: "none" });
    expect(
      resolveComposerInputHistoryKeyAction({
        direction: "up",
        browsing: true,
        text: "line1\nline2",
        cursor: 2,
      }),
    ).toEqual({ action: "move-caret", cursor: 0 });
    expect(
      resolveComposerInputHistoryKeyAction({
        direction: "up",
        browsing: true,
        text: "line1\nline2",
        cursor: 0,
      }),
    ).toEqual({ action: "history" });
  });

  it("ignores non-collapsed selections", () => {
    expect(
      resolveComposerInputHistoryKeyAction({
        direction: "up",
        browsing: false,
        text: "hello",
        cursor: 0,
        selectionEnd: 3,
      }),
    ).toEqual({ action: "none" });
  });
});

describe("shouldNavigateComposerInputHistory", () => {
  it("is true only at the history edge", () => {
    expect(
      shouldNavigateComposerInputHistory({
        direction: "up",
        browsing: false,
        text: "hello",
        cursor: 0,
      }),
    ).toBe(true);
    expect(
      shouldNavigateComposerInputHistory({
        direction: "up",
        browsing: false,
        text: "hello",
        cursor: 2,
      }),
    ).toBe(false);
  });
});

describe("line helpers", () => {
  it("detects first and last line", () => {
    expect(isComposerCursorOnFirstLine("a\nb", 1)).toBe(true);
    expect(isComposerCursorOnFirstLine("a\nb", 2)).toBe(false);
    expect(isComposerCursorOnLastLine("a\nb", 1)).toBe(false);
    expect(isComposerCursorOnLastLine("a\nb", 2)).toBe(true);
  });
});
