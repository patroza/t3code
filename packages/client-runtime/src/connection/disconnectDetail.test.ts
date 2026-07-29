import { describe, expect, it } from "@effect/vitest";

import {
  describeWebSocketCloseCode,
  formatDisconnectDetail,
  formatDisconnectStatusFragment,
} from "./disconnectDetail.ts";

describe("disconnectDetail", () => {
  it("maps common close codes", () => {
    expect(describeWebSocketCloseCode(1000)).toBe("clean");
    expect(describeWebSocketCloseCode(1006)).toBe("abnormal");
    expect(describeWebSocketCloseCode(1012)).toBe("service restart");
    expect(describeWebSocketCloseCode(42)).toBeNull();
  });

  it("formats a connected disconnect with close code", () => {
    expect(
      formatDisconnectDetail({
        label: "t3vm",
        wasConnected: true,
        close: { code: 1006 },
      }),
    ).toBe("t3vm closed (1006 abnormal).");
  });

  it("includes a short close reason when it adds information", () => {
    expect(
      formatDisconnectDetail({
        label: "t3vm",
        wasConnected: true,
        close: { code: 1012, reason: "service restart" },
      }),
    ).toBe("t3vm closed (1012 service restart).");
    expect(
      formatDisconnectDetail({
        label: "t3vm",
        wasConnected: true,
        close: { code: 1000, reason: "deploy rolling" },
      }),
    ).toBe("t3vm closed (1000 clean: deploy rolling).");
  });

  it("prefers ping timeout over a bare disconnect", () => {
    expect(
      formatDisconnectDetail({
        label: "t3vm",
        wasConnected: true,
        causeMessage: "ping timeout",
      }),
    ).toBe("t3vm ping timeout.");
  });

  it("formats open failures without claiming a prior session", () => {
    expect(
      formatDisconnectDetail({
        label: "t3vm",
        wasConnected: false,
      }),
    ).toBe("t3vm could not open WebSocket.");
  });

  it("strips trailing periods for status fragments", () => {
    expect(formatDisconnectStatusFragment("t3vm closed (1006 abnormal).")).toBe(
      "t3vm closed (1006 abnormal)",
    );
  });
});
