import type { ServerHostResourceSnapshot } from "@t3tools/contracts";

export type HostResourcePressure = "normal" | "warning" | "critical";

export function getHostResourceRatioPressure(ratio: number): HostResourcePressure {
  if (ratio >= 0.9) return "critical";
  if (ratio >= 0.75) return "warning";
  return "normal";
}

export function getHostResourceLoadRatio(snapshot: ServerHostResourceSnapshot): number | null {
  const loadOne = snapshot.loadAverage?.m1 ?? null;
  if (loadOne === null || !snapshot.logicalCores) return null;
  return loadOne / snapshot.logicalCores;
}

export function getHostResourcePressure(
  snapshot: ServerHostResourceSnapshot,
): HostResourcePressure {
  const cpu = (snapshot.cpuPercent ?? 0) / 100;
  const memory = (snapshot.memoryUsedPercent ?? 0) / 100;
  const load = getHostResourceLoadRatio(snapshot) ?? 0;
  const pressure = Math.max(cpu, memory, load);
  return getHostResourceRatioPressure(pressure);
}

export function formatHostResourcePercent(value: number | null): string {
  return value === null ? "—" : `${Math.round(value)}%`;
}

export function formatHostResourceBytes(value: number | null): string {
  if (value === null) return "—";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"] as const;
  let scaled = value;
  let index = 0;
  while (scaled >= 1024 && index < units.length - 1) {
    scaled /= 1024;
    index += 1;
  }
  return `${scaled.toFixed(index >= 3 ? 1 : 0)} ${units[index]}`;
}

export interface HostResourceMetric {
  readonly key: "cpu" | "memory" | "load";
  /** Single-character gauge label rendered next to the meter. */
  readonly label: string;
  readonly value: string;
  /** `0`–`1` fill for the meter, or `null` when the host did not report it. */
  readonly ratio: number | null;
  readonly description: string;
}

/**
 * The compact CPU / memory / load gauges shared by every client's host status
 * strip. Load is expressed as a ratio of the 1-minute average to logical cores
 * so its meter is comparable with the two percentages.
 */
export function getHostResourceMetrics(
  snapshot: ServerHostResourceSnapshot,
): ReadonlyArray<HostResourceMetric> {
  const loadOne = snapshot.loadAverage?.m1 ?? null;
  const loadValue = loadOne === null ? "—" : loadOne.toFixed(1);
  return [
    {
      key: "cpu",
      label: "C",
      value: formatHostResourcePercent(snapshot.cpuPercent),
      ratio: snapshot.cpuPercent === null ? null : snapshot.cpuPercent / 100,
      description: `CPU ${formatHostResourcePercent(snapshot.cpuPercent)}`,
    },
    {
      key: "memory",
      label: "M",
      value: formatHostResourcePercent(snapshot.memoryUsedPercent),
      ratio: snapshot.memoryUsedPercent === null ? null : snapshot.memoryUsedPercent / 100,
      description: `Memory ${formatHostResourcePercent(snapshot.memoryUsedPercent)}`,
    },
    {
      key: "load",
      label: "L",
      value: loadValue,
      ratio: getHostResourceLoadRatio(snapshot),
      description: `Load ${loadOne === null ? "unavailable" : loadValue}`,
    },
  ];
}
