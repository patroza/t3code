import type { ServerHostResourceSnapshot } from "@t3tools/contracts";

export type HostResourcePressure = "normal" | "warning" | "critical";

export function getHostResourcePressure(
  snapshot: ServerHostResourceSnapshot,
): HostResourcePressure {
  const cpu = (snapshot.cpuPercent ?? 0) / 100;
  const memory = (snapshot.memoryUsedPercent ?? 0) / 100;
  const load =
    snapshot.logicalCores && snapshot.loadAverage
      ? snapshot.loadAverage.m1 / snapshot.logicalCores
      : 0;
  const pressure = Math.max(cpu, memory, load);
  if (pressure >= 0.9) return "critical";
  if (pressure >= 0.7) return "warning";
  return "normal";
}
