import { beforeEach, describe, expect, it } from "vite-plus/test";

import { acquireBrowserSurface, useBrowserSurfaceStore } from "./browserSurfaceStore";

describe("browserSurfaceStore release", () => {
  beforeEach(() => {
    useBrowserSurfaceStore.setState({ activityByTabId: {}, byTabId: {} });
  });

  it("removes a surface entry when its current lease is released", () => {
    const tabId = "released-browser-surface";
    const lease = acquireBrowserSurface(tabId, true);
    lease.present({ x: 10, y: 20, width: 900, height: 640 }, true);

    lease.release();
    // A stale present() from the released lease must not resurrect the entry.
    lease.present({ x: 0, y: 0, width: 1, height: 1 }, true);

    expect(useBrowserSurfaceStore.getState().byTabId[tabId]).toBeUndefined();
  });

  it("keeps the entry when a lease that no longer owns it is released", () => {
    const tabId = "handed-off-browser-surface";
    const previous = acquireBrowserSurface(tabId);
    const next = acquireBrowserSurface(tabId);
    next.present({ x: 10, y: 20, width: 900, height: 640 }, true);

    previous.release();

    expect(useBrowserSurfaceStore.getState().byTabId[tabId]).toMatchObject({ visible: true });
  });
});
