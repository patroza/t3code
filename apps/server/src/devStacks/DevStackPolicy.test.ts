import { DEV_STACK_SCHEMA_VERSION, type DevStackEntry } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_CONSUMERS,
  DEFAULT_IDLE_MINUTES,
  decide,
  entryPortsFor,
  isActive,
  resolvePolicy,
} from "./DevStackPolicy.ts";

const ROOT = "/var/lib/t3/worktrees/scanner/feature";

const entry = (processes: DevStackEntry["processes"]): DevStackEntry => ({
  schema: DEV_STACK_SCHEMA_VERSION,
  project: "scanner",
  worktree: "bdb56cccb27eb374",
  root: ROOT,
  instance: "empasa",
  processes,
});

const browserStack = entry([
  { role: "api", pid: 1, port: 21000, cwd: "api" },
  { role: "frontend", pid: 2, port: 22000, cwd: "frontend" },
]);
const apiOnlyStack = entry([{ role: "api", pid: 1, port: 21000, cwd: "api" }]);

const idle = { establishedPorts: new Set<number>(), consumerCwds: [] };
const policy = resolvePolicy({ entryRoles: ["frontend", "api"] });

describe("resolvePolicy", () => {
  it("applies the documented defaults when a repository declares nothing", () => {
    expect(resolvePolicy(undefined)).toEqual({
      idleMs: DEFAULT_IDLE_MINUTES * 60_000,
      consumers: DEFAULT_CONSUMERS,
      entryRoles: [],
    });
  });

  it("takes the repository's declaration over the defaults", () => {
    expect(resolvePolicy({ idleMinutes: 45, consumers: ["cypress"], entryRoles: ["web"] })).toEqual(
      {
        idleMs: 45 * 60_000,
        consumers: ["cypress"],
        entryRoles: ["web"],
      },
    );
  });
});

describe("entryPortsFor", () => {
  it("watches the frontend of a browser stack, not the API behind it", () => {
    expect(entryPortsFor(browserStack, ["frontend", "api"])).toEqual([22000]);
  });

  it("falls through to the API when no frontend is running", () => {
    expect(entryPortsFor(apiOnlyStack, ["frontend", "api"])).toEqual([21000]);
  });

  it("watches every port when the repository declared no entry roles", () => {
    expect(entryPortsFor(browserStack, [])).toEqual([21000, 22000]);
  });

  it("watches nothing when declared roles match no running process", () => {
    expect(entryPortsFor(browserStack, ["worker"])).toEqual([]);
  });
});

describe("isActive", () => {
  it("ignores a connection to the API of a browser stack", () => {
    expect(isActive(browserStack, policy, { ...idle, establishedPorts: new Set([21000]) })).toBe(
      false,
    );
  });

  it("counts a connection to the entry port", () => {
    expect(isActive(browserStack, policy, { ...idle, establishedPorts: new Set([22000]) })).toBe(
      true,
    );
  });

  it("counts a consumer working anywhere inside the worktree", () => {
    expect(isActive(browserStack, policy, { ...idle, consumerCwds: [`${ROOT}/e2e`] })).toBe(true);
    expect(isActive(browserStack, policy, { ...idle, consumerCwds: [ROOT] })).toBe(true);
  });

  it("does not mistake a sibling worktree sharing a path prefix for a consumer", () => {
    expect(isActive(browserStack, policy, { ...idle, consumerCwds: [`${ROOT}-other/e2e`] })).toBe(
      false,
    );
  });
});

describe("decide", () => {
  const base = {
    entry: browserStack,
    policy,
    observation: idle,
    anyProcessAlive: true,
    rootExists: true,
    lastSeenMs: null as number | null,
    now: 1_000_000_000,
  };

  it("prunes bookkeeping when every process is already gone", () => {
    expect(decide({ ...base, anyProcessAlive: false })).toEqual({
      _tag: "Prune",
      reason: "no-live-processes",
    });
  });

  it("prefers pruning over reaping when the worktree is gone but so are the processes", () => {
    expect(decide({ ...base, anyProcessAlive: false, rootExists: false })._tag).toBe("Prune");
  });

  it("reaps a live stack whose worktree was removed, whatever the clock says", () => {
    expect(decide({ ...base, rootExists: false, lastSeenMs: base.now })).toEqual({
      _tag: "Reap",
      reason: "worktree-removed",
    });
  });

  it("starts the clock the first time it sees a stack rather than reaping it", () => {
    expect(decide(base)).toEqual({ _tag: "StartClock" });
  });

  it("keeps a stack that is still inside its idle window", () => {
    const lastSeenMs = base.now - (policy.idleMs - 60_000);
    expect(decide({ ...base, lastSeenMs })).toEqual({
      _tag: "Keep",
      idleMs: policy.idleMs - 60_000,
    });
  });

  it("reaps once the idle window is exceeded", () => {
    const lastSeenMs = base.now - (policy.idleMs + 60_000);
    expect(decide({ ...base, lastSeenMs })).toEqual({
      _tag: "Reap",
      reason: "idle",
      idleMs: policy.idleMs + 60_000,
    });
  });

  it("refreshes an active stack instead of ageing it out", () => {
    const observation = { ...idle, establishedPorts: new Set([22000]) };
    const lastSeenMs = base.now - (policy.idleMs + 60_000);
    expect(decide({ ...base, observation, lastSeenMs })).toEqual({ _tag: "Active" });
  });
});
