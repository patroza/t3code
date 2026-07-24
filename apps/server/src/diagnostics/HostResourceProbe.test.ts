import { describe, expect, it } from "vite-plus/test";

import { calculateCpuPercent, parseProcMemAvailableBytes } from "./HostResourceProbe.ts";

describe("HostResourceProbe", () => {
  it("calculates aggregate busy CPU from sample deltas", () => {
    expect(calculateCpuPercent({ idle: 500, total: 1_000 }, { idle: 525, total: 1_100 })).toBe(75);
  });

  it("rejects invalid CPU deltas", () => {
    expect(calculateCpuPercent({ idle: 100, total: 100 }, { idle: 100, total: 100 })).toBeNull();
  });

  it("reads Linux available memory in bytes", () => {
    expect(
      parseProcMemAvailableBytes("MemTotal:       8000000 kB\nMemAvailable:   2000000 kB\n"),
    ).toBe(2_048_000_000);
  });
});
