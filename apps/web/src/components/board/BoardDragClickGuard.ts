export interface BoardDragClickGuard {
  startDrag: () => void;
  finishDrag: () => void;
  consumeSuppressedClick: () => boolean;
  dispose: () => void;
}

/**
 * Prevents the click synthesized by the pointer release that finishes a drag
 * from opening a thread. If that release produces no click, the suppression
 * expires on the next task instead of swallowing a later, intentional click.
 */
export function createBoardDragClickGuard(): BoardDragClickGuard {
  let suppressClick = false;
  let resetTimer: ReturnType<typeof setTimeout> | null = null;

  const clearResetTimer = () => {
    if (resetTimer !== null) {
      clearTimeout(resetTimer);
      resetTimer = null;
    }
  };

  return {
    startDrag() {
      clearResetTimer();
      suppressClick = true;
    },
    finishDrag() {
      clearResetTimer();
      resetTimer = setTimeout(() => {
        suppressClick = false;
        resetTimer = null;
      }, 0);
    },
    consumeSuppressedClick() {
      if (!suppressClick) {
        return false;
      }
      suppressClick = false;
      return true;
    },
    dispose() {
      clearResetTimer();
    },
  };
}
