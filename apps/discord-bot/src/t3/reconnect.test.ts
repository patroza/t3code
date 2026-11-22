import { describe, expect, it, vi } from "vite-plus/test";

import { reconnectUntilReady } from "./reconnect.ts";

describe("reconnectUntilReady", () => {
  it("recovers a second disconnect while bridge restoration is in flight", async () => {
    let ready = false;
    const restoring = Promise.withResolvers<void>();
    const restored = Promise.withResolvers<void>();
    const connect = vi.fn(async () => {
      ready = true;
    });
    const restore = vi.fn(async () => {
      if (restore.mock.calls.length === 1) {
        restoring.resolve();
        await restored.promise;
      }
    });
    const wait = vi.fn(async (_attempt: number) => {});
    const onFailure = vi.fn(async () => {});

    const recovery = reconnectUntilReady({
      connect,
      isReady: () => ready,
      restore,
      wait,
      onFailure,
    });
    await restoring.promise;
    ready = false;
    restored.resolve();
    await recovery;

    expect(ready).toBe(true);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(restore).toHaveBeenCalledTimes(2);
    expect(wait.mock.calls.map(([attempt]) => attempt)).toEqual([0, 1]);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("keeps retrying after a failed replacement connection", async () => {
    const unavailable = new Error("Connection refused");
    let ready = false;
    const connect = vi.fn(async () => {
      if (connect.mock.calls.length === 1) throw unavailable;
      ready = true;
    });
    const restore = vi.fn(async () => {});
    const onFailure = vi.fn(async (_cause: unknown, _attempt: number) => {});

    await reconnectUntilReady({
      connect,
      isReady: () => ready,
      restore,
      wait: async () => {},
      onFailure,
    });

    expect(ready).toBe(true);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(restore).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledWith(unavailable, 0);
  });
});
