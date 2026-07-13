import type { ServerHostResourceSnapshot } from "@t3tools/contracts";
import { HostProcessHostname, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as NodeOS from "node:os";

export interface CpuTimes {
  readonly idle: number;
  readonly total: number;
}

const CPU_SAMPLE_INTERVAL = "75 millis";
const SNAPSHOT_TTL = "15 seconds";

export class HostResourceProbe extends Context.Service<
  HostResourceProbe,
  { readonly read: Effect.Effect<ServerHostResourceSnapshot> }
>()("t3/diagnostics/HostResourceProbe") {}

function captureCpuTimes(): CpuTimes | null {
  const cpus = NodeOS.cpus();
  if (cpus.length === 0) return null;
  return cpus.reduce<CpuTimes>(
    (totals, cpu) => {
      const total = Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
      return { idle: totals.idle + cpu.times.idle, total: totals.total + total };
    },
    { idle: 0, total: 0 },
  );
}

export function calculateCpuPercent(before: CpuTimes, after: CpuTimes): number | null {
  const totalDelta = after.total - before.total;
  const idleDelta = after.idle - before.idle;
  if (totalDelta <= 0 || idleDelta < 0) return null;
  return Math.min(100, Math.max(0, ((totalDelta - idleDelta) / totalDelta) * 100));
}

export function parseProcMemAvailableBytes(contents: string): number | null {
  const match = /^MemAvailable:\s+(\d+)\s+kB$/mu.exec(contents);
  if (!match?.[1]) return null;
  const kibibytes = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(kibibytes) && kibibytes >= 0 ? kibibytes * 1024 : null;
}

const readAvailableMemory = Effect.fn("HostResourceProbe.readAvailableMemory")(function* (
  fileSystem: FileSystem.FileSystem,
  hostPlatform: NodeJS.Platform,
) {
  if (hostPlatform !== "linux") return { bytes: NodeOS.freemem(), source: "os" as const };
  const procMemInfo = yield* fileSystem.readFileString("/proc/meminfo").pipe(Effect.option);
  if (procMemInfo._tag === "Some") {
    const bytes = parseProcMemAvailableBytes(procMemInfo.value);
    if (bytes !== null) return { bytes, source: "procfs" as const };
  }
  return { bytes: NodeOS.freemem(), source: "os" as const };
});

const unavailableSnapshot = (message: string, checkedAt: string): ServerHostResourceSnapshot => ({
  status: "unavailable",
  checkedAt,
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
  message,
});

export const make = Effect.gen(function* HostResourceProbeMake() {
  const fileSystem = yield* FileSystem.FileSystem;
  const hostPlatform = yield* HostProcessPlatform;
  const hostHostname = yield* HostProcessHostname;
  const probe = Effect.gen(function* HostResourceProbeRead() {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const before = yield* Effect.sync(captureCpuTimes);
    if (before === null) {
      return unavailableSnapshot("The host did not report logical CPU data.", checkedAt);
    }

    const memory = yield* readAvailableMemory(fileSystem, hostPlatform);
    yield* Effect.sleep(CPU_SAMPLE_INTERVAL);
    const after = yield* Effect.sync(captureCpuTimes);
    if (after === null) {
      return unavailableSnapshot("The host stopped reporting logical CPU data.", checkedAt);
    }

    const totalMemory = NodeOS.totalmem();
    const availableMemory = Math.min(totalMemory, Math.max(0, memory.bytes));
    const usedMemory = Math.max(0, totalMemory - availableMemory);
    const load = NodeOS.loadavg();
    return {
      status: "supported" as const,
      checkedAt,
      source: memory.source,
      hostname: hostHostname.trim() || null,
      platform: hostPlatform,
      cpuPercent: calculateCpuPercent(before, after),
      memoryUsedPercent: totalMemory > 0 ? (usedMemory / totalMemory) * 100 : null,
      memoryUsedBytes: usedMemory,
      memoryAvailableBytes: availableMemory,
      memoryTotalBytes: totalMemory > 0 ? totalMemory : null,
      loadAverage: { m1: load[0] ?? 0, m5: load[1] ?? 0, m15: load[2] ?? 0 },
      logicalCores: NodeOS.cpus().length,
      message: null,
    } satisfies ServerHostResourceSnapshot;
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.gen(function* HostResourceProbeUnavailable() {
        yield* Effect.logDebug("Host resource probe unavailable", cause);
        return unavailableSnapshot(
          "Host resource metrics are temporarily unavailable.",
          DateTime.formatIso(yield* DateTime.now),
        );
      }),
    ),
  );
  const read = yield* Effect.cachedWithTTL(probe, SNAPSHOT_TTL);
  return HostResourceProbe.of({ read });
});

export const layer = Layer.effect(HostResourceProbe, make);
