import { describe, expect, it } from "vite-plus/test";

import { scrollBoardFromWheel, shouldScrollColumnFromWheel } from "./BoardScroll";

function makeContainer(overrides: Partial<MockScrollContainer> = {}): MockScrollContainer {
  return {
    clientWidth: 500,
    scrollLeft: 200,
    scrollWidth: 1_500,
    ...overrides,
  };
}

interface MockScrollContainer {
  clientWidth: number;
  scrollLeft: number;
  scrollWidth: number;
}

describe("shouldScrollColumnFromWheel", () => {
  const verticalWheel = { deltaX: 0, deltaY: 50 };

  it("keeps vertical wheel movement in a column that can scroll in that direction", () => {
    expect(
      shouldScrollColumnFromWheel(
        { clientHeight: 500, scrollHeight: 1_000, scrollTop: 200 },
        verticalWheel,
      ),
    ).toBe(true);
    expect(
      shouldScrollColumnFromWheel(
        { clientHeight: 500, scrollHeight: 1_000, scrollTop: 200 },
        { deltaX: 0, deltaY: -50 },
      ),
    ).toBe(true);
  });

  it("releases vertical movement to the board at the matching column edge", () => {
    expect(
      shouldScrollColumnFromWheel(
        { clientHeight: 500, scrollHeight: 1_000, scrollTop: 500 },
        verticalWheel,
      ),
    ).toBe(false);
    expect(
      shouldScrollColumnFromWheel(
        { clientHeight: 500, scrollHeight: 1_000, scrollTop: 0 },
        { deltaX: 0, deltaY: -50 },
      ),
    ).toBe(false);
  });

  it("releases horizontal gestures and non-overflowing columns to the board", () => {
    expect(
      shouldScrollColumnFromWheel(
        { clientHeight: 500, scrollHeight: 1_000, scrollTop: 200 },
        { deltaX: 50, deltaY: 10 },
      ),
    ).toBe(false);
    expect(
      shouldScrollColumnFromWheel(
        { clientHeight: 500, scrollHeight: 500, scrollTop: 0 },
        verticalWheel,
      ),
    ).toBe(false);
  });
});

describe("scrollBoardFromWheel", () => {
  it("maps vertical wheel movement to horizontal board movement", () => {
    const container = makeContainer();

    expect(
      scrollBoardFromWheel(container, {
        ctrlKey: false,
        deltaMode: 0,
        deltaX: 0,
        deltaY: 80,
      }),
    ).toBe(true);
    expect(container.scrollLeft).toBe(280);

    scrollBoardFromWheel(container, {
      ctrlKey: false,
      deltaMode: 0,
      deltaX: 0,
      deltaY: -50,
    });
    expect(container.scrollLeft).toBe(230);

    // Horizontal trackpad movement wins when it is the dominant axis.
    scrollBoardFromWheel(container, {
      ctrlKey: false,
      deltaMode: 0,
      deltaX: 60,
      deltaY: 10,
    });
    expect(container.scrollLeft).toBe(290);
  });

  it("normalizes line and page wheel deltas", () => {
    const lineContainer = makeContainer();
    const pageContainer = makeContainer();

    scrollBoardFromWheel(lineContainer, {
      ctrlKey: false,
      deltaMode: 1,
      deltaX: 0,
      deltaY: 2,
    });
    scrollBoardFromWheel(pageContainer, {
      ctrlKey: false,
      deltaMode: 2,
      deltaX: 0,
      deltaY: 1,
    });

    expect(lineContainer.scrollLeft).toBe(232);
    expect(pageContainer.scrollLeft).toBe(700);
  });

  it("clamps movement at both ends while retaining ownership of board scrolling", () => {
    const rightEdge = makeContainer({ scrollLeft: 990 });
    const leftEdge = makeContainer({ scrollLeft: 10 });

    expect(
      scrollBoardFromWheel(rightEdge, {
        ctrlKey: false,
        deltaMode: 0,
        deltaX: 0,
        deltaY: 100,
      }),
    ).toBe(true);
    expect(rightEdge.scrollLeft).toBe(1_000);

    expect(
      scrollBoardFromWheel(leftEdge, {
        ctrlKey: false,
        deltaMode: 0,
        deltaX: 0,
        deltaY: -100,
      }),
    ).toBe(true);
    expect(leftEdge.scrollLeft).toBe(0);
  });

  it("leaves pinch zoom and non-overflowing boards untouched", () => {
    const zoomContainer = makeContainer();
    const fittingContainer = makeContainer({ clientWidth: 1_500 });
    const wheel = { ctrlKey: false, deltaMode: 0, deltaX: 0, deltaY: 100 };

    expect(scrollBoardFromWheel(zoomContainer, { ...wheel, ctrlKey: true })).toBe(false);
    expect(zoomContainer.scrollLeft).toBe(200);
    expect(scrollBoardFromWheel(fittingContainer, wheel)).toBe(false);
    expect(fittingContainer.scrollLeft).toBe(200);
  });
});
