import type { HostResourcesSnapshot } from "@t3tools/contracts";

export type HostResourcePressure = "normal" | "warning" | "critical";

export interface HostResourceMetric {
  readonly key: "cpu" | "memory";
  /** Single-character gauge label rendered next to the meter. */
  readonly label: string;
  readonly value: string;
  /** `0`–`1` fill for the meter, or `null` when the host did not report it. */
  readonly ratio: number | null;
  readonly description: string;
}

export function hostResourcePressure(ratio: number): HostResourcePressure {
  if (ratio >= 0.9) return "critical";
  if (ratio >= 0.75) return "warning";
  return "normal";
}

export function formatHostResourceRatio(ratio: number | null): string {
  return ratio === null ? "N/A" : `${Math.round(ratio * 100)}%`;
}

export function formatHostResourceBytes(value: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"] as const;
  let scaled = value;
  let index = 0;
  while (scaled >= 1024 && index < units.length - 1) {
    scaled /= 1024;
    index += 1;
  }
  return `${scaled.toFixed(index >= 3 ? 1 : 0)} ${units[index]}`;
}

export function hostMemoryUsedBytes(snapshot: HostResourcesSnapshot): number {
  return Math.max(0, snapshot.totalMemoryBytes - snapshot.availableMemoryBytes);
}

function hostMemoryRatio(snapshot: HostResourcesSnapshot): number | null {
  if (snapshot.totalMemoryBytes <= 0) return null;
  return hostMemoryUsedBytes(snapshot) / snapshot.totalMemoryBytes;
}

/** Compact CPU / memory gauges for the status strip, from upstream `server.getHostResources`. */
export function hostResourceMetrics(
  snapshot: HostResourcesSnapshot,
): ReadonlyArray<HostResourceMetric> {
  const memoryRatio = hostMemoryRatio(snapshot);
  return [
    {
      key: "cpu",
      label: "C",
      value: formatHostResourceRatio(snapshot.cpuUtilization),
      ratio: snapshot.cpuUtilization,
      description: `CPU ${formatHostResourceRatio(snapshot.cpuUtilization)}`,
    },
    {
      key: "memory",
      label: "M",
      value: formatHostResourceRatio(memoryRatio),
      ratio: memoryRatio,
      description: `Memory ${formatHostResourceRatio(memoryRatio)}`,
    },
  ];
}
