import { describe, expect, it } from "vite-plus/test";

import {
  browserAutomationResult,
  browserOperationDeadlineMs,
  browserResponseAfterDeliveryFailure,
  BrowserOperationTimeoutError,
  withBrowserOperationDeadline,
} from "./BrowserAutomationHost.ts";
import { BrowserRuntimeError } from "./BrowserRuntime.ts";

describe("browser automation host", () => {
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

  it("returns JSON for values Playwright may hand back as Dates or NaN", () => {
    const stamped = new Date("2026-09-30T07:40:54.000Z");
    expect(browserAutomationResult({ seen: stamped, width: Number.NaN, keep: "board" })).toEqual({
      seen: "2026-09-30T07:40:54.000Z",
      width: null,
      keep: "board",
    });
    expect(browserAutomationResult(undefined)).toBeUndefined();
  });

  it("fails the call when the result cannot be encoded as JSON", () => {
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    expect(() => browserAutomationResult(cycle)).toThrow(BrowserRuntimeError);
  });

  it("replaces an undeliverable response with an execution error", () => {
    expect(
      browserResponseAfterDeliveryFailure(
        {
          clientId: "discord-browser-operator-default",
          connectionId: "connection-1",
          requestId: "preview-22",
          ok: true,
          result: { board: true },
        },
        new Error('Expected JSON value at ["result"]'),
      ),
    ).toEqual({
      clientId: "discord-browser-operator-default",
      connectionId: "connection-1",
      requestId: "preview-22",
      ok: false,
      error: {
        _tag: "PreviewAutomationExecutionError",
        message: 'Browser result could not be delivered. Expected JSON value at ["result"]',
      },
    });
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
