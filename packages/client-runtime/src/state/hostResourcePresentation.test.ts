import { describe, expect, it } from "@effect/vitest";

import type { ServerHostResourceSnapshot } from "@t3tools/contracts";
import {
  formatHostResourceBytes,
  getHostResourceMetrics,
  getHostResourcePressure,
  getHostResourceRatioPressure,
} from "./hostResourcePresentation.js";

const snapshot = (overrides: Partial<ServerHostResourceSnapshot>) =>
  ({
    status: "supported",
    checkedAt: "2026-07-13T12:00:00.000Z",
    source: "os",
    hostname: "smart",
    platform: "linux",
    cpuPercent: 20,
    memoryUsedPercent: 30,
    memoryUsedBytes: 30,
    memoryAvailableBytes: 70,
    memoryTotalBytes: 100,
    loadAverage: { m1: 1, m5: 1, m15: 1 },
    logicalCores: 8,
    message: null,
    ...overrides,
  }) satisfies ServerHostResourceSnapshot;

describe("getHostResourcePressure", () => {
  it("uses CPU, memory, or normalized load pressure", () => {
    expect(getHostResourcePressure(snapshot({}))).toBe("normal");
    expect(getHostResourcePressure(snapshot({ memoryUsedPercent: 75 }))).toBe("warning");
    expect(getHostResourcePressure(snapshot({ cpuPercent: 90 }))).toBe("critical");
    expect(
      getHostResourcePressure(
        snapshot({ loadAverage: { m1: 7.2, m5: 2, m15: 1 }, logicalCores: 8 }),
      ),
    ).toBe("critical");
  });

  it("uses orange at 75% and red at 90%", () => {
    expect(getHostResourceRatioPressure(0.74)).toBe("normal");
    expect(getHostResourceRatioPressure(0.75)).toBe("warning");
    expect(getHostResourceRatioPressure(0.9)).toBe("critical");
  });
});

describe("getHostResourceMetrics", () => {
  it("normalizes load against logical cores so its meter is comparable to the percentages", () => {
    const [cpu, memory, load] = getHostResourceMetrics(
      snapshot({ cpuPercent: 42.4, memoryUsedPercent: 30, loadAverage: { m1: 4, m5: 2, m15: 1 } }),
    );

    expect(cpu).toMatchObject({ label: "C", value: "42%", ratio: 0.424 });
    expect(memory).toMatchObject({ label: "M", value: "30%", ratio: 0.3 });
    expect(load).toMatchObject({ label: "L", value: "4.0", ratio: 0.5 });
  });

  it("reports unmeasured metrics as an em dash with no meter fill", () => {
    const [cpu, , load] = getHostResourceMetrics(snapshot({ cpuPercent: null, loadAverage: null }));

    expect(cpu).toMatchObject({ value: "—", ratio: null, description: "CPU —" });
    expect(load).toMatchObject({ value: "—", ratio: null, description: "Load unavailable" });
  });

  it("leaves load unmeasured when the host reports no core count", () => {
    expect(getHostResourceMetrics(snapshot({ logicalCores: null }))[2]).toMatchObject({
      value: "1.0",
      ratio: null,
    });
  });
});

describe("formatHostResourceBytes", () => {
  it("scales to the largest unit that keeps the value above 1", () => {
    expect(formatHostResourceBytes(512)).toBe("512 B");
    expect(formatHostResourceBytes(2048)).toBe("2 KiB");
    expect(formatHostResourceBytes(5 * 1024 ** 3)).toBe("5.0 GiB");
    expect(formatHostResourceBytes(null)).toBe("—");
  });
});
