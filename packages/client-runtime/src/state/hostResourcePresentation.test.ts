import { describe, expect, it } from "@effect/vitest";

import type { ServerHostResourceSnapshot } from "@t3tools/contracts";
import {
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
