/**
 * Shell-style composer prompt history.
 *
 * - Up/Down browse previously submitted inputs (oldest → newest in `entries`).
 * - Leaving the live draft stashes temporary input and restores it when returning.
 * - Edits while browsing are transient; navigating away discards them unless submitted.
 */

export type ComposerInputHistoryState = {
  /** Submitted prompts, oldest first. */
  readonly entries: ReadonlyArray<string>;
  /**
   * Index into `entries` while browsing history.
   * `null` means the live draft (not browsing).
   */
  readonly browsingIndex: number | null;
  /** Draft text captured when first leaving live mode via ArrowUp. */
  readonly stashedDraft: string;
};

export const EMPTY_COMPOSER_INPUT_HISTORY: ComposerInputHistoryState = {
  entries: [],
  browsingIndex: null,
  stashedDraft: "",
};

export const DEFAULT_COMPOSER_INPUT_HISTORY_MAX_ENTRIES = 100;

export type ComposerInputHistoryNavigation =
  | { readonly handled: false }
  | {
      readonly handled: true;
      readonly state: ComposerInputHistoryState;
      readonly value: string;
    };

function clampCursor(text: string, cursor: number): number {
  if (!Number.isFinite(cursor)) return text.length;
  return Math.max(0, Math.min(text.length, Math.floor(cursor)));
}

/** True when the caret is on the first line (or selection is collapsed there). */
export function isComposerCursorOnFirstLine(text: string, cursor: number): boolean {
  const bounded = clampCursor(text, cursor);
  return !text.slice(0, bounded).includes("\n");
}

/** True when the caret is on the last line (or selection is collapsed there). */
export function isComposerCursorOnLastLine(text: string, cursor: number): boolean {
  const bounded = clampCursor(text, cursor);
  return !text.slice(bounded).includes("\n");
}

/**
 * What ArrowUp/ArrowDown should do in the composer.
 *
 * Matches common chat UIs (Copilot / Claude / Codex-style):
 * 1. Move the caret inside the multi-line input first (top / bottom lines).
 * 2. On the first line, move to the document start before history.
 * 3. On the last line, move to the document end before history (when browsing).
 * 4. Only once the caret is already at that edge does history run.
 *
 * Non-collapsed selections never intercept (leave native behavior).
 */
export type ComposerInputHistoryKeyAction =
  | { readonly action: "none" }
  | { readonly action: "move-caret"; readonly cursor: number }
  | { readonly action: "history" };

export function resolveComposerInputHistoryKeyAction(input: {
  readonly direction: "up" | "down";
  readonly browsing: boolean;
  readonly text: string;
  readonly cursor: number;
  readonly selectionEnd?: number;
}): ComposerInputHistoryKeyAction {
  const cursor = clampCursor(input.text, input.cursor);
  const selectionEnd = clampCursor(input.text, input.selectionEnd ?? input.cursor);
  if (cursor !== selectionEnd) {
    return { action: "none" };
  }

  if (input.direction === "up") {
    if (!isComposerCursorOnFirstLine(input.text, cursor)) {
      // Let the editor move toward the top line first.
      return { action: "none" };
    }
    if (cursor > 0) {
      // On the first line: go to the beginning of the composer before history.
      return { action: "move-caret", cursor: 0 };
    }
    return { action: "history" };
  }

  // down
  if (!isComposerCursorOnLastLine(input.text, cursor)) {
    return { action: "none" };
  }
  if (cursor < input.text.length) {
    // On the last line: go to the end before stepping history forward.
    return { action: "move-caret", cursor: input.text.length };
  }
  // At document end: only history while browsing (restore draft / newer entry).
  // When not browsing, leave native no-op / caret behavior.
  return input.browsing ? { action: "history" } : { action: "none" };
}

/**
 * @deprecated Prefer {@link resolveComposerInputHistoryKeyAction}.
 * True when ArrowUp/Down should drive history (caret already at the history edge).
 */
export function shouldNavigateComposerInputHistory(input: {
  readonly direction: "up" | "down";
  readonly browsing: boolean;
  readonly text: string;
  readonly cursor: number;
  readonly selectionEnd?: number;
}): boolean {
  return resolveComposerInputHistoryKeyAction(input).action === "history";
}

/**
 * Normalize conversation/session prompts into history entries (oldest first).
 * Drops empty values and consecutive duplicates; caps length from the newest side.
 */
export function normalizeComposerInputHistoryEntries(
  values: ReadonlyArray<string>,
  options?: { readonly maxEntries?: number },
): ReadonlyArray<string> {
  const maxEntries = options?.maxEntries ?? DEFAULT_COMPOSER_INPUT_HISTORY_MAX_ENTRIES;
  const normalized: string[] = [];
  for (const value of values) {
    if (value.trim().length === 0) continue;
    if (normalized[normalized.length - 1] === value) continue;
    normalized.push(value);
  }
  if (normalized.length <= maxEntries) {
    return normalized;
  }
  return normalized.slice(normalized.length - maxEntries);
}

/**
 * When session history is empty, seed from conversation user prompts (oldest first).
 * Matches Copilot/Claude/Codex-style recall: ArrowUp recovers the latest user message
 * even before any new submits in this session.
 */
export function seedComposerInputHistoryFromConversation(
  state: ComposerInputHistoryState,
  conversationUserTexts: ReadonlyArray<string>,
  options?: { readonly maxEntries?: number },
): ComposerInputHistoryState {
  if (state.entries.length > 0) {
    return state;
  }
  const entries = normalizeComposerInputHistoryEntries(conversationUserTexts, options);
  if (entries.length === 0) {
    return state;
  }
  return {
    entries,
    browsingIndex: state.browsingIndex,
    stashedDraft: state.stashedDraft,
  };
}

/**
 * Record a submitted prompt and return to the live draft.
 * Empty (trim) values are ignored. Consecutive duplicate entries are skipped.
 */
export function pushComposerInputHistory(
  state: ComposerInputHistoryState,
  value: string,
  options?: { readonly maxEntries?: number },
): ComposerInputHistoryState {
  if (value.trim().length === 0) {
    return {
      entries: state.entries,
      browsingIndex: null,
      stashedDraft: "",
    };
  }

  const maxEntries = options?.maxEntries ?? DEFAULT_COMPOSER_INPUT_HISTORY_MAX_ENTRIES;
  const last = state.entries[state.entries.length - 1];
  const entries =
    last === value
      ? state.entries
      : [...state.entries, value].slice(Math.max(0, state.entries.length + 1 - maxEntries));

  return {
    entries,
    browsingIndex: null,
    stashedDraft: "",
  };
}

/**
 * Place an editable value at the newest history position while preserving the
 * current live draft on the forward side. ArrowDown restores that draft.
 */
export function recallComposerInputHistory(
  state: ComposerInputHistoryState,
  recalledValue: string,
  currentDraft: string,
  options?: { readonly maxEntries?: number },
): ComposerInputHistoryState {
  const maxEntries = options?.maxEntries ?? DEFAULT_COMPOSER_INPUT_HISTORY_MAX_ENTRIES;
  const entries = [...state.entries, recalledValue].slice(
    Math.max(0, state.entries.length + 1 - maxEntries),
  );
  return {
    entries,
    browsingIndex: entries.length - 1,
    stashedDraft: currentDraft,
  };
}

/**
 * Navigate one step through history.
 * Returns `handled: false` when the key should fall through (e.g. Down at live draft).
 */
export function navigateComposerInputHistory(
  state: ComposerInputHistoryState,
  direction: "up" | "down",
  currentValue: string,
): ComposerInputHistoryNavigation {
  if (state.entries.length === 0) {
    return { handled: false };
  }

  if (direction === "up") {
    if (state.browsingIndex === null) {
      const nextIndex = state.entries.length - 1;
      const value = state.entries[nextIndex];
      if (value === undefined) {
        return { handled: false };
      }
      return {
        handled: true,
        state: {
          entries: state.entries,
          browsingIndex: nextIndex,
          stashedDraft: currentValue,
        },
        value,
      };
    }

    if (state.browsingIndex <= 0) {
      const value = state.entries[0];
      if (value === undefined) {
        return { handled: false };
      }
      return { handled: true, state, value };
    }

    const nextIndex = state.browsingIndex - 1;
    const value = state.entries[nextIndex];
    if (value === undefined) {
      return { handled: false };
    }
    return {
      handled: true,
      state: {
        entries: state.entries,
        browsingIndex: nextIndex,
        stashedDraft: state.stashedDraft,
      },
      value,
    };
  }

  // down
  if (state.browsingIndex === null) {
    return { handled: false };
  }

  if (state.browsingIndex >= state.entries.length - 1) {
    return {
      handled: true,
      state: {
        entries: state.entries,
        browsingIndex: null,
        stashedDraft: "",
      },
      value: state.stashedDraft,
    };
  }

  const nextIndex = state.browsingIndex + 1;
  const value = state.entries[nextIndex];
  if (value === undefined) {
    return { handled: false };
  }
  return {
    handled: true,
    state: {
      entries: state.entries,
      browsingIndex: nextIndex,
      stashedDraft: state.stashedDraft,
    },
    value,
  };
}
