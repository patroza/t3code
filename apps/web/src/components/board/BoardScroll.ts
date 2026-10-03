const PIXELS_PER_WHEEL_LINE = 16;

interface BoardScrollContainer {
  readonly clientWidth: number;
  scrollLeft: number;
  readonly scrollWidth: number;
}

interface BoardWheelInput {
  readonly ctrlKey: boolean;
  readonly deltaMode: number;
  readonly deltaX: number;
  readonly deltaY: number;
}

interface ColumnScrollContainer {
  readonly clientHeight: number;
  readonly scrollHeight: number;
  readonly scrollTop: number;
}

interface WheelAxes {
  readonly deltaX: number;
  readonly deltaY: number;
}

/** Returns true when a vertical gesture can still move an overflowing column. */
export function shouldScrollColumnFromWheel(
  container: ColumnScrollContainer,
  event: WheelAxes,
): boolean {
  if (
    !Number.isFinite(event.deltaY) ||
    event.deltaY === 0 ||
    Math.abs(event.deltaX) >= Math.abs(event.deltaY)
  ) {
    return false;
  }

  const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
  if (maxScrollTop === 0) {
    return false;
  }

  return event.deltaY < 0 ? container.scrollTop > 0 : container.scrollTop < maxScrollTop;
}

/**
 * Redirects the wheel's dominant axis into the board's native horizontal
 * scroll position. Handling horizontal input here as well keeps nested column
 * scroll areas from swallowing trackpad gestures before they reach the board.
 */
export function scrollBoardFromWheel(
  container: BoardScrollContainer,
  event: BoardWheelInput,
): boolean {
  if (event.ctrlKey) {
    // Ctrl+wheel is commonly a trackpad pinch gesture. Leave browser zoom alone.
    return false;
  }

  const maxScrollLeft = Math.max(0, container.scrollWidth - container.clientWidth);
  if (maxScrollLeft === 0) {
    return false;
  }

  const dominantDelta =
    Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
  if (!Number.isFinite(dominantDelta) || dominantDelta === 0) {
    return false;
  }

  const multiplier =
    event.deltaMode === 1
      ? PIXELS_PER_WHEEL_LINE
      : event.deltaMode === 2
        ? container.clientWidth
        : 1;
  container.scrollLeft = Math.min(
    maxScrollLeft,
    Math.max(0, container.scrollLeft + dominantDelta * multiplier),
  );
  return true;
}
