import { describe, expect, it } from "vite-plus/test";

import {
  browserOperationDeadlineMs,
  BrowserOperationTimeoutError,
  withBrowserOperationDeadline,
} from "./BrowserAutomationHost.ts";

describe("browser automation host deadline", () => {
  it("reserves time for delivering the response to the broker", () => {
    expect(browserOperationDeadlineMs(15_000)).toBe(14_000);
    expect(browserOperationDeadlineMs(500)).toBe(450);
  });

  it("rejects a stalled operation before the broker timeout", async () => {
    const stalled = new Promise<never>(() => {});
    let interrupted = false;

    await expect(
      withBrowserOperationDeadline(stalled, 10, () => {
        interrupted = true;
      }),
    ).rejects.toBeInstanceOf(BrowserOperationTimeoutError);
    expect(interrupted).toBe(true);
  });

  it("does not interrupt an operation that completes before its deadline", async () => {
    let interrupted = false;

    await expect(
      withBrowserOperationDeadline(Promise.resolve("complete"), 100, () => {
        interrupted = true;
      }),
    ).resolves.toBe("complete");
    expect(interrupted).toBe(false);
  });
});
