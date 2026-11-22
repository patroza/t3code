import { describe, expect, it } from "vite-plus/test";

import { hostResourceMetrics, hostResourcePressure } from "./hostResources.ts";

describe("hostResourceMetrics", () => {
  it("derives CPU and memory gauges from the upstream host snapshot", () => {
    const metrics = hostResourceMetrics({
      sampledAt: 1,
      cpuUtilization: 0.42,
      cpuCount: 8,
      availableMemoryBytes: 2 * 1024 ** 3,
      totalMemoryBytes: 8 * 1024 ** 3,
    });
    expect(metrics.map((metric) => [metric.key, metric.value, metric.ratio])).toEqual([
      ["cpu", "42%", 0.42],
      ["memory", "75%", 0.75],
    ]);
    expect(hostResourcePressure(metrics[1]!.ratio!)).toBe("warning");
  });

  it("reports unknown CPU and memory as N/A", () => {
    const metrics = hostResourceMetrics({
      sampledAt: 1,
      cpuUtilization: null,
      cpuCount: 0,
      availableMemoryBytes: 0,
      totalMemoryBytes: 0,
    });
    expect(metrics.map((metric) => metric.value)).toEqual(["N/A", "N/A"]);
  });
});
