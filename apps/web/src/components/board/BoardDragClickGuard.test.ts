import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { createBoardDragClickGuard } from "./BoardDragClickGuard";

afterEach(() => {
  vi.useRealTimers();
});

describe("createBoardDragClickGuard", () => {
  it("does not suppress ordinary clicks", () => {
    const guard = createBoardDragClickGuard();

    expect(guard.consumeSuppressedClick()).toBe(false);
  });

  it("suppresses the click generated when a drag finishes", () => {
    const guard = createBoardDragClickGuard();

    guard.startDrag();
    guard.finishDrag();

    expect(guard.consumeSuppressedClick()).toBe(true);
    expect(guard.consumeSuppressedClick()).toBe(false);
  });

  it("releases suppression when a finished drag produces no click", () => {
    vi.useFakeTimers();
    const guard = createBoardDragClickGuard();

    guard.startDrag();
    guard.finishDrag();
    vi.runOnlyPendingTimers();

    expect(guard.consumeSuppressedClick()).toBe(false);
  });

  it("does not let an earlier reset clear suppression for a newer drag", () => {
    vi.useFakeTimers();
    const guard = createBoardDragClickGuard();

    guard.startDrag();
    guard.finishDrag();
    guard.startDrag();
    vi.runOnlyPendingTimers();

    expect(guard.consumeSuppressedClick()).toBe(true);
  });
});
