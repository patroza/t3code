// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDateInEffect:off
import { DevStackEntry, DEV_STACK_REGISTRY_DIR } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as T3ProjectFileLoader from "../project/T3ProjectFileLoader.ts";
import {
  decide,
  resolvePolicy,
  type ActivityObservation,
  type DevStackPolicy,
} from "./DevStackPolicy.ts";

/**
 * Stops dev stacks a repository registered under `$TMPDIR/dev-stacks` once
 * nothing has used them for the window that repository declared in `t3.json`.
 *
 * This is the level-triggered half of stack teardown. The `runOnWorktreeRemove`
 * and `runOnPrMerged` project scripts remain the early reap and are strictly
 * faster when they fire; they simply cannot be relied on, because both are
 * edge-triggered. `runOnPrMerged` in particular only fires when
 * VcsStatusBroadcaster observes a not-merged -> merged transition for a worktree
 * it happens to be polling, so an agent that finishes its work and a human who
 * merges an hour later produce no observer, no edge, and no teardown. Stacks have
 * survived for thirteen hours that way.
 *
 * Looking at state instead of events means a missed hook costs one idle window
 * rather than an unbounded number of hours, and it needs no cooperation from the
 * repository beyond registering the stack in the first place.
 */

const SWEEP_INTERVAL = Duration.minutes(5);

const decodeEntry = Schema.decodeUnknownOption(DevStackEntry);

export interface SweepSummary {
  readonly scanned: number;
  readonly reaped: number;
  readonly pruned: number;
  readonly active: number;
  readonly skipped: number;
  readonly durationMs: number;
}

export class DevStackReaper extends Context.Service<
  DevStackReaper,
  {
    /** Run one sweep now. Exposed so a caller can force one; the fiber drives the rest. */
    readonly sweep: () => Effect.Effect<SweepSummary>;
  }
>()("t3/devStacks/DevStackReaper") {}

const registryRoot = () => NodePath.join(NodeOS.tmpdir(), DEV_STACK_REGISTRY_DIR);

const seenPathFor = (stackFile: string) => stackFile.replace(/\.json$/u, ".seen");

const listFiles = async (dir: string, suffix: string): Promise<ReadonlyArray<string>> => {
  const out: string[] = [];
  const projects = await NodeFSP.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const projectDir = NodePath.join(dir, project.name);
    const worktrees = await NodeFSP.readdir(projectDir, { withFileTypes: true }).catch(() => []);
    for (const worktree of worktrees) {
      if (!worktree.isDirectory()) continue;
      const worktreeDir = NodePath.join(projectDir, worktree.name);
      const entries = await NodeFSP.readdir(worktreeDir).catch(() => []);
      for (const name of entries)
        if (name.endsWith(suffix)) out.push(NodePath.join(worktreeDir, name));
    }
  }
  return out;
};

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Confirms a PID is still the stack's own process before it is signalled. */
const ownedBy = async (pid: number, expectedCwd: string) => {
  if (!alive(pid)) return false;
  try {
    const [actual, expected] = await Promise.all([
      NodeFSP.realpath(`/proc/${pid}/cwd`),
      NodeFSP.realpath(expectedCwd),
    ]);
    return actual === expected;
  } catch {
    return false;
  }
};

/**
 * Local ports with an ESTABLISHED connection, read from /proc so the sweep does
 * not shell out. Field 1 is `HEXIP:HEXPORT`, field 3 is the state (01 = ESTABLISHED).
 */
const establishedLocalPorts = async (): Promise<ReadonlySet<number>> => {
  const ports = new Set<number>();
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    const text = await NodeFSP.readFile(file, "utf8").catch(() => "");
    for (const line of text.split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/u);
      if (fields.length < 4 || fields[3] !== "01") continue;
      const hexPort = fields[1]?.split(":")[1];
      if (hexPort === undefined) continue;
      const port = Number.parseInt(hexPort, 16);
      if (Number.isFinite(port)) ports.add(port);
    }
  }
  return ports;
};

/** Working directories of live processes whose command line matches any consumer pattern. */
const consumerCwds = async (patterns: ReadonlySet<string>): Promise<ReadonlyArray<string>> => {
  if (patterns.size === 0) return [];
  const cwds: string[] = [];
  const entries = await NodeFSP.readdir("/proc").catch(() => []);
  for (const entry of entries) {
    if (!/^\d+$/u.test(entry)) continue;
    try {
      const cmdline = (await NodeFSP.readFile(`/proc/${entry}/cmdline`, "utf8")).replaceAll(
        "\0",
        " ",
      );
      let matched = false;
      for (const pattern of patterns) {
        if (cmdline.includes(pattern)) {
          matched = true;
          break;
        }
      }
      if (!matched) continue;
      cwds.push(await NodeFSP.realpath(`/proc/${entry}/cwd`));
    } catch {
      // Exited mid-scan, or owned by another user. Either way it is not ours.
    }
  }
  return cwds;
};

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** SIGTERM the process group, then SIGKILL what is left. */
const stopGroup = async (pid: number) => {
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    return;
  }
  for (let attempt = 0; attempt < 20 && alive(pid); attempt++) await wait(100);
  if (!alive(pid)) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // Exited between the check and the signal.
  }
};

const releaseLease = async (base: string, pid: number, port: number | undefined) => {
  if (port === undefined) return;
  const file = NodePath.join(base, "leases", `${port}.json`);
  try {
    const lease: unknown = JSON.parse(await NodeFSP.readFile(file, "utf8"));
    if ((lease as { pid?: number }).pid !== pid) return;
  } catch {
    return;
  }
  await NodeFSP.rm(file, { force: true });
};

/**
 * The producer takes this lock around start and stop. Honouring it keeps the
 * sweep from killing a stack that is halfway through coming up, and costs one
 * stat per stack.
 */
const isLocked = async (base: string, entry: DevStackEntry) => {
  const lock = NodePath.join(base, "locks", `${entry.project}-${entry.worktree}-${entry.instance}`);
  try {
    const owner: unknown = JSON.parse(
      await NodeFSP.readFile(NodePath.join(lock, "owner.json"), "utf8"),
    );
    const pid = (owner as { pid?: number }).pid;
    return typeof pid === "number" && alive(pid);
  } catch {
    return false;
  }
};

/** Reverse start order, so a frontend stops before the API it points at. */
const teardown = async (base: string, entry: DevStackEntry, stackFile: string) => {
  for (const process_ of [...entry.processes].reverse()) {
    if (await ownedBy(process_.pid, NodePath.join(entry.root, process_.cwd)))
      await stopGroup(process_.pid);
    await releaseLease(base, process_.pid, process_.port);
  }
  await NodeFSP.rm(stackFile, { force: true });
  await NodeFSP.rm(seenPathFor(stackFile), { force: true });
};

export const make = Effect.gen(function* DevStackReaperMake() {
  const projectFiles = yield* T3ProjectFileLoader.T3ProjectFileLoader;

  const policyFor = Effect.fn("DevStackReaper.policyFor")(function* (root: string) {
    const file = yield* projectFiles.load(root);
    return Option.match(file, {
      onNone: () => null,
      onSome: (loaded) => (loaded.devStacks === undefined ? null : resolvePolicy(loaded.devStacks)),
    });
  });

  const sweep = Effect.fn("DevStackReaper.sweep")(function* () {
    const startedAt = Date.now();
    const base = registryRoot();
    const stackFiles = yield* Effect.promise(() =>
      listFiles(NodePath.join(base, "stacks"), ".json"),
    );
    const summary = { scanned: 0, reaped: 0, pruned: 0, active: 0, skipped: 0 };
    if (stackFiles.length === 0) return { ...summary, durationMs: Date.now() - startedAt };

    const establishedPorts = yield* Effect.promise(establishedLocalPorts);
    // Policies are resolved first so one /proc scan can serve every stack.
    const resolved: Array<{ file: string; entry: DevStackEntry; policy: DevStackPolicy }> = [];
    for (const file of stackFiles) {
      summary.scanned++;
      const raw = yield* Effect.promise(() =>
        NodeFSP.readFile(file, "utf8")
          .then(JSON.parse)
          .catch(() => null),
      );
      const decoded = raw === null ? Option.none<DevStackEntry>() : decodeEntry(raw);
      if (Option.isNone(decoded)) {
        // Not a shape we understand. Only bookkeeping is removed; no signals sent.
        yield* Effect.promise(() => NodeFSP.rm(file, { force: true }));
        yield* Effect.promise(() => NodeFSP.rm(seenPathFor(file), { force: true }));
        summary.pruned++;
        continue;
      }
      const entry = decoded.value;
      // A repository opts in by declaring devStacks. Without it, T3 leaves the
      // stack alone entirely rather than guessing a policy for someone else's repo.
      const policy = yield* policyFor(entry.root);
      if (policy === null) {
        summary.skipped++;
        continue;
      }
      resolved.push({ file, entry, policy });
    }
    if (resolved.length === 0) return { ...summary, durationMs: Date.now() - startedAt };

    const patterns = new Set(resolved.flatMap(({ policy }) => [...policy.consumers]));
    const cwds = yield* Effect.promise(() => consumerCwds(patterns));
    const observation: ActivityObservation = { establishedPorts, consumerCwds: cwds };

    for (const { file, entry, policy } of resolved) {
      if (yield* Effect.promise(() => isLocked(base, entry))) {
        summary.skipped++;
        continue;
      }
      const anyProcessAlive = entry.processes.some((process_) => alive(process_.pid));
      const rootExists = yield* Effect.promise(() =>
        NodeFSP.stat(entry.root)
          .then(() => true)
          .catch(() => false),
      );
      const lastSeenMs = yield* Effect.promise(() =>
        NodeFSP.stat(seenPathFor(file))
          .then((stat) => stat.mtimeMs)
          .catch(() => null),
      );
      const decision = decide({
        entry,
        policy,
        observation,
        anyProcessAlive,
        rootExists,
        lastSeenMs,
        now: Date.now(),
      });

      switch (decision._tag) {
        case "Active":
        case "StartClock": {
          const when = new Date();
          yield* Effect.promise(async () => {
            await NodeFSP.writeFile(seenPathFor(file), "").catch(() => {});
            await NodeFSP.utimes(seenPathFor(file), when, when).catch(() => {});
          });
          summary.active++;
          break;
        }
        case "Keep":
          summary.active++;
          break;
        case "Prune":
          yield* Effect.promise(() => teardown(base, entry, file));
          summary.pruned++;
          break;
        case "Reap":
          yield* Effect.promise(() => teardown(base, entry, file));
          summary.reaped++;
          yield* Effect.logInfo("dev stack reaped").pipe(
            Effect.annotateLogs({
              project: entry.project,
              instance: entry.instance,
              root: entry.root,
              reason: decision.reason,
            }),
          );
          break;
      }
    }

    return { ...summary, durationMs: Date.now() - startedAt };
  });

  // One layer-scoped fiber. Failures are logged and swallowed: a sweep that
  // cannot read /proc must not take the server down with it.
  const tick = () =>
    sweep().pipe(
      Effect.flatMap((summary) =>
        summary.reaped + summary.pruned > 0 || summary.durationMs > 250
          ? // Routine quiet sweeps stay at debug; anything that acted or ran long is
            // worth seeing, so "is this bogging the main loop down" stays a query.
            Effect.logInfo("dev stack sweep").pipe(Effect.annotateLogs({ ...summary }))
          : Effect.logDebug("dev stack sweep").pipe(Effect.annotateLogs({ ...summary })),
      ),
      Effect.catchCause((cause) => Effect.logWarning("dev stack sweep failed", cause)),
    );

  yield* Effect.forkScoped(tick().pipe(Effect.repeat(Schedule.spaced(SWEEP_INTERVAL))));

  return { sweep } as const;
});

export const layer = Layer.effect(DevStackReaper, make);
