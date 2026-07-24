import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { ServerHostResourceSnapshot } from "./hostResources.ts";

const decodeSnapshot = Schema.decodeUnknownSync(ServerHostResourceSnapshot);

describe("ServerHostResourceSnapshot", () => {
  it("decodes a supported host snapshot", () => {
    expect(
      decodeSnapshot({
        status: "supported",
        checkedAt: "2026-07-13T10:00:00.000Z",
        source: "procfs",
        hostname: "smart",
        platform: "linux",
        cpuPercent: 25.5,
        memoryUsedPercent: 62.5,
        memoryUsedBytes: 5_000,
        memoryAvailableBytes: 3_000,
        memoryTotalBytes: 8_000,
        loadAverage: { m1: 1.2, m5: 1, m15: 0.8 },
        logicalCores: 8,
        message: null,
      }).hostname,
    ).toBe("smart");
  });

  it("decodes an unavailable snapshot without fake values", () => {
    const snapshot = decodeSnapshot({
      status: "unavailable",
      checkedAt: "2026-07-13T10:00:00.000Z",
      source: "unavailable",
      hostname: null,
      platform: null,
      cpuPercent: null,
      memoryUsedPercent: null,
      memoryUsedBytes: null,
      memoryAvailableBytes: null,
      memoryTotalBytes: null,
      loadAverage: null,
      logicalCores: null,
      message: "Unavailable",
    });
    expect(snapshot.cpuPercent).toBeNull();
  });
});
