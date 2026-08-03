import type { DevStackEntry, T3ProjectFileDevStacks } from "@t3tools/contracts";
import * as path from "node:path";

/**
 * The decision half of the dev stack sweep, kept free of the filesystem, /proc,
 * and signals so it can be tested directly rather than through a live stack.
 */

export const DEFAULT_IDLE_MINUTES = 20;
export const DEFAULT_CONSUMERS: ReadonlyArray<string> = Object.freeze(["playwright", "vitest"]);

export interface DevStackPolicy {
  readonly idleMs: number;
  readonly consumers: ReadonlyArray<string>;
  readonly entryRoles: ReadonlyArray<string>;
}

/**
 * `entryRoles` has no safe generic default, so an absent one means "watch every
 * port in the stack". That over-detects activity, which is the right way to be
 * wrong: a repository that has not declared its entry role keeps a stack alive
 * too long rather than losing one mid-run.
 */
export const resolvePolicy = (declared: T3ProjectFileDevStacks | undefined): DevStackPolicy => ({
  idleMs: (declared?.idleMinutes ?? DEFAULT_IDLE_MINUTES) * 60_000,
  consumers: declared?.consumers ?? DEFAULT_CONSUMERS,
  entryRoles: declared?.entryRoles ?? [],
});

/**
 * Ports a consumer would connect to. With `entryRoles` declared we watch the
 * first role actually present, most specific first — a frontend usually holds
 * keep-alive connections to its own API, so watching the API port too would read
 * the stack as busy for as long as the frontend is up.
 */
export const entryPortsFor = (
  entry: DevStackEntry,
  entryRoles: ReadonlyArray<string>,
): ReadonlyArray<number> => {
  const portsOf = (role: string) =>
    entry.processes
      .filter((process) => process.role === role && process.port !== undefined)
      .map((process) => process.port as number);
  for (const role of entryRoles) {
    const ports = portsOf(role);
    if (ports.length > 0) return ports;
  }
  if (entryRoles.length > 0) return [];
  return entry.processes.flatMap((process) => (process.port === undefined ? [] : [process.port]));
};

const within = (child: string, parent: string) =>
  child === parent || child.startsWith(`${parent}${path.sep}`);

export interface ActivityObservation {
  readonly establishedPorts: ReadonlySet<number>;
  /** Working directories of live processes whose command line matched a consumer pattern. */
  readonly consumerCwds: ReadonlyArray<string>;
}

export const isActive = (
  entry: DevStackEntry,
  policy: DevStackPolicy,
  observation: ActivityObservation,
): boolean => {
  for (const port of entryPortsFor(entry, policy.entryRoles)) {
    if (observation.establishedPorts.has(port)) return true;
  }
  return observation.consumerCwds.some((cwd) => within(cwd, entry.root));
};

export type SweepDecision =
  | { readonly _tag: "Active" }
  /** First sighting starts the clock — a cold boot plus a build can outlast the window. */
  | { readonly _tag: "StartClock" }
  | { readonly _tag: "Keep"; readonly idleMs: number }
  | { readonly _tag: "Reap"; readonly reason: "idle"; readonly idleMs: number }
  | { readonly _tag: "Reap"; readonly reason: "worktree-removed" }
  | { readonly _tag: "Prune"; readonly reason: "no-live-processes" };

export interface SweepInput {
  readonly entry: DevStackEntry;
  readonly policy: DevStackPolicy;
  readonly observation: ActivityObservation;
  readonly anyProcessAlive: boolean;
  readonly rootExists: boolean;
  /** mtime of the sibling `.seen` marker, or null when the sweep has never seen this stack. */
  readonly lastSeenMs: number | null;
  readonly now: number;
}

export const decide = (input: SweepInput): SweepDecision => {
  // Nothing left to signal: a reboot, an OOM, or a manual kill already took the
  // processes and only the bookkeeping survived.
  if (!input.anyProcessAlive) return { _tag: "Prune", reason: "no-live-processes" };
  if (!input.rootExists) return { _tag: "Reap", reason: "worktree-removed" };
  if (isActive(input.entry, input.policy, input.observation)) return { _tag: "Active" };
  if (input.lastSeenMs === null) return { _tag: "StartClock" };
  const idleMs = input.now - input.lastSeenMs;
  return idleMs > input.policy.idleMs
    ? { _tag: "Reap", reason: "idle", idleMs }
    : { _tag: "Keep", idleMs };
};
