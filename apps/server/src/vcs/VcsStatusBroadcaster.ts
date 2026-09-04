import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import type {
  GitManagerServiceError,
  VcsStatusInput,
  VcsStatusLocalResult,
  VcsStatusRemoteResult,
  VcsStatusResult,
  VcsStatusStreamEvent,
} from "@t3tools/contracts";
import { mergeGitStatusParts } from "@t3tools/shared/git";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProjectLifecycleScriptRunner from "../project/ProjectLifecycleScriptRunner.ts";

const DEFAULT_VCS_STATUS_REFRESH_INTERVAL = Duration.seconds(30);
/**
 * Shared list-mode remote refresh: one loop for all list-interested worktrees,
 * not one fiber per cwd. Interval starts only after a sweep fully finishes so
 * slow gh/git work never overlaps the next wait (and never stampedes reconnect).
 */
const LIST_REMOTE_REFRESH_INTERVAL = Duration.seconds(45);
/** Cap work per tick so a large sidebar cannot monopolize the process for minutes. */
const LIST_REMOTE_REFRESH_BATCH_SIZE = 4;
const LIST_REMOTE_REFRESH_CONCURRENCY = 1;
const VCS_STATUS_REFRESH_FAILURE_BASE_DELAY = Duration.seconds(30);
const VCS_STATUS_REFRESH_FAILURE_MAX_DELAY = Duration.minutes(15);
const MAX_FAILURE_DIAGNOSTIC_VALUES = 8;
const MAX_FAILURE_DIAGNOSTIC_VALUE_LENGTH = 128;

/** Exported for tests — list subscriptions share this cadence. */
export const LIST_MODE_REMOTE_REFRESH_INTERVAL = LIST_REMOTE_REFRESH_INTERVAL;

function boundedDiagnosticValue(value: string): string {
  return value.slice(0, MAX_FAILURE_DIAGNOSTIC_VALUE_LENGTH);
}

function diagnosticValueTag(value: unknown): string {
  try {
    if (
      typeof value === "object" &&
      value !== null &&
      "_tag" in value &&
      typeof value._tag === "string"
    ) {
      return boundedDiagnosticValue(value._tag);
    }
    if (value instanceof Error) {
      return boundedDiagnosticValue(value.name);
    }
    return typeof value;
  } catch {
    return "Uninspectable";
  }
}

function diagnosticFailureOperation(value: unknown): string | undefined {
  try {
    if (
      typeof value === "object" &&
      value !== null &&
      "operation" in value &&
      typeof value.operation === "string"
    ) {
      return boundedDiagnosticValue(value.operation);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function addUniqueDiagnosticValue(values: Array<string>, value: string | undefined): void {
  if (
    value !== undefined &&
    values.length < MAX_FAILURE_DIAGNOSTIC_VALUES &&
    !values.includes(value)
  ) {
    values.push(value);
  }
}

export function remoteRefreshFailureDiagnostics(cause: Cause.Cause<unknown>) {
  const failureTags: Array<string> = [];
  const failureOperations: Array<string> = [];
  const defectTags: Array<string> = [];
  let failureCount = 0;
  let defectCount = 0;
  let interruptionCount = 0;

  for (const reason of cause.reasons) {
    if (Cause.isFailReason(reason)) {
      failureCount += 1;
      addUniqueDiagnosticValue(failureTags, diagnosticValueTag(reason.error));
      addUniqueDiagnosticValue(failureOperations, diagnosticFailureOperation(reason.error));
      continue;
    }
    if (Cause.isDieReason(reason)) {
      defectCount += 1;
      addUniqueDiagnosticValue(defectTags, diagnosticValueTag(reason.defect));
      continue;
    }
    interruptionCount += 1;
  }

  return {
    reasonCount: cause.reasons.length,
    failureCount,
    failureTags,
    failureOperations,
    defectCount,
    defectTags,
    interruptionCount,
  };
}

interface VcsStatusChange {
  readonly cwd: string;
  readonly event: VcsStatusStreamEvent;
}

interface CachedValue<T> {
  readonly fingerprint: string;
  readonly value: T;
}

interface CachedVcsStatus {
  readonly local: CachedValue<VcsStatusLocalResult> | null;
  readonly remote: CachedValue<VcsStatusRemoteResult | null> | null;
}

interface ActiveRemotePoller {
  readonly fiber: Fiber.Fiber<void, never>;
  readonly subscriberCount: number;
  readonly demandCwds: Ref.Ref<ReadonlyMap<string, number>>;
}

interface StreamStatusOptions {
  readonly automaticRemoteRefreshInterval?: Effect.Effect<Duration.Duration, never>;
}

export class VcsAutoPullPolicy extends Context.Reference<{
  readonly isEnabled: (cwd: string) => Effect.Effect<boolean, never>;
}>("t3/vcs/VcsAutoPullPolicy", {
  defaultValue: () => ({ isEnabled: () => Effect.succeed(false) }),
}) {}

export const autoPullPolicyLayer = Layer.effect(
  VcsAutoPullPolicy,
  Effect.gen(function* () {
    const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
    return {
      isEnabled: (cwd: string) =>
        snapshots.getActiveProjectByWorkspaceRoot(cwd).pipe(
          Effect.map((project) => project._tag === "Some" && project.value.autoPull === true),
          Effect.orElseSucceed(() => false),
        ),
    };
  }),
);

export function remoteRefreshFailureDelay(
  consecutiveFailures: number,
  configuredInterval: Duration.Duration,
) {
  const exponent = Math.max(0, consecutiveFailures - 1);
  const backoffMs =
    Duration.toMillis(VCS_STATUS_REFRESH_FAILURE_BASE_DELAY) * Math.pow(2, exponent);
  const cappedBackoff = Duration.min(
    Duration.millis(backoffMs),
    VCS_STATUS_REFRESH_FAILURE_MAX_DELAY,
  );
  return Duration.max(configuredInterval, cappedBackoff);
}

/**
 * True only when we observed an open PR on this cwd and it later became merged.
 * Skips first-seen already-merged PRs so server restarts / initial polls do not re-fire.
 */
export function didChangeRequestBecomeMerged(
  previous: VcsStatusRemoteResult | null | undefined,
  next: VcsStatusRemoteResult | null,
): boolean {
  if (next?.pr?.state !== "merged") {
    return false;
  }
  if (previous?.pr?.state !== "open") {
    return false;
  }
  return previous.pr.number === next.pr.number;
}

function prMergedLifecycleKey(cwd: string, prNumber: number): string {
  return `${cwd}::${prNumber}`;
}

export class VcsStatusBroadcaster extends Context.Service<
  VcsStatusBroadcaster,
  {
    readonly getStatus: (
      input: VcsStatusInput,
    ) => Effect.Effect<VcsStatusResult, GitManagerServiceError>;
    readonly refreshLocalStatus: (
      cwd: string,
    ) => Effect.Effect<VcsStatusLocalResult, GitManagerServiceError>;
    readonly refreshStatus: (cwd: string) => Effect.Effect<VcsStatusResult, GitManagerServiceError>;
    /**
     * Refresh a loaded cwd after a turn if background policy allows it.
     * GitManager retries missing PRs for the current branch and keeps known
     * PRs and failed lookup backoff cached. This does not fetch Git remotes.
     */
    readonly refreshPullRequestStatus: (
      cwd: string,
    ) => Effect.Effect<VcsStatusRemoteResult | null, GitManagerServiceError>;
    readonly streamStatus: (
      input: VcsStatusInput,
      options?: StreamStatusOptions,
    ) => Stream.Stream<VcsStatusStreamEvent, GitManagerServiceError>;
  }
>()("t3/vcs/VcsStatusBroadcaster") {}

function fingerprintStatusPart(status: unknown): string {
  return JSON.stringify(status);
}

const normalizeCwd = (cwd: string) =>
  Effect.service(FileSystem.FileSystem).pipe(
    Effect.flatMap((fs) => fs.realPath(cwd)),
    Effect.orElseSucceed(() => cwd),
  );

export const make = Effect.gen(function* () {
  const autoPullPolicy = yield* VcsAutoPullPolicy;
  const workflow = yield* GitWorkflowService.GitWorkflowService;
  const lifecycleScriptRunner = yield* ProjectLifecycleScriptRunner.ProjectLifecycleScriptRunner;
  const backgroundPolicy = yield* BackgroundPolicy.BackgroundPolicy;
  const fs = yield* FileSystem.FileSystem;
  const changesPubSub = yield* Effect.acquireRelease(
    PubSub.unbounded<VcsStatusChange>(),
    (pubsub) => PubSub.shutdown(pubsub),
  );
  const broadcasterScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
    Scope.close(scope, Exit.void),
  );
  const cacheRef = yield* Ref.make(new Map<string, CachedVcsStatus>());
  // One permit per cwd for remote reads that write the cache. Without it a
  // periodic poll that started before `gh pr create` can finish after the
  // turn-end refresh and overwrite the fresh PR with its stale `pr: null`.
  const remoteWriteLocks = new Map<string, Semaphore.Semaphore>();
  const withRemoteWriteLock = <A, E, R>(cwd: string, effect: Effect.Effect<A, E, R>) => {
    let lock = remoteWriteLocks.get(cwd);
    if (lock === undefined) {
      lock = Semaphore.makeUnsafe(1);
      remoteWriteLocks.set(cwd, lock);
    }
    return lock.withPermits(1)(effect);
  };
  const pollersRef = yield* SynchronizedRef.make(new Map<string, ActiveRemotePoller>());
  /** cwd → list-mode subscriber count (high-cardinality sidebar/board rows). */
  const listInterestRef = yield* SynchronizedRef.make(new Map<string, number>());
  const listRefreshFiberRef = yield* SynchronizedRef.make<Fiber.Fiber<void, never> | null>(null);
  /** Round-robin cursor across list-interested cwds. */
  const listRefreshCursorRef = yield* Ref.make(0);
  /**
   * Exclusive list sweep lock: subscribe-time kicks and the periodic loop share
   * this so remotes never pile up on top of an in-flight sweep.
   */
  const listSweepMutex = yield* Semaphore.make(1);
  // One fire per cwd+PR number for this server process.
  const prMergedLifecycleFiredRef = yield* Ref.make(new Set<string>());

  const getCachedStatus = Effect.fn("VcsStatusBroadcaster.getCachedStatus")(function* (
    cwd: string,
  ) {
    return yield* Ref.get(cacheRef).pipe(Effect.map((cache) => cache.get(cwd) ?? null));
  });

  const maybeRunPrMergedLifecycle = Effect.fn("VcsStatusBroadcaster.maybeRunPrMergedLifecycle")(
    function* (
      cwd: string,
      previousRemote: VcsStatusRemoteResult | null | undefined,
      nextRemote: VcsStatusRemoteResult | null,
    ) {
      if (!didChangeRequestBecomeMerged(previousRemote, nextRemote) || !nextRemote?.pr) {
        return;
      }
      const pr = nextRemote.pr;
      const fireKey = prMergedLifecycleKey(cwd, pr.number);
      const shouldFire = yield* Ref.modify(prMergedLifecycleFiredRef, (fired) => {
        if (fired.has(fireKey)) {
          return [false, fired] as const;
        }
        const next = new Set(fired);
        next.add(fireKey);
        return [true, next] as const;
      });
      if (!shouldFire) {
        return;
      }

      yield* lifecycleScriptRunner
        .runPrMerged({
          projectCwd: cwd,
          worktreePath: cwd,
          pr: {
            number: pr.number,
            url: pr.url,
            title: pr.title,
            baseRef: pr.baseRef,
            headRef: pr.headRef,
            state: pr.state,
          },
        })
        .pipe(
          Effect.tap((result) =>
            result.status === "completed"
              ? Effect.logInfo("VcsStatusBroadcaster pr-merged lifecycle completed", {
                  cwd,
                  prNumber: pr.number,
                  scriptId: result.scriptId,
                  scriptName: result.scriptName,
                })
              : Effect.void,
          ),
          Effect.catch((error) =>
            Effect.logWarning("VcsStatusBroadcaster pr-merged lifecycle failed", {
              cwd,
              prNumber: pr.number,
              cause: error,
            }),
          ),
          Effect.forkIn(broadcasterScope),
        );
    },
  );

  const updateCachedLocalStatus = Effect.fn("VcsStatusBroadcaster.updateCachedLocalStatus")(
    function* (cwd: string, local: VcsStatusLocalResult, options?: { publish?: boolean }) {
      const nextLocal = {
        fingerprint: fingerprintStatusPart(local),
        value: local,
      } satisfies CachedValue<VcsStatusLocalResult>;
      const shouldPublish = yield* Ref.modify(cacheRef, (cache) => {
        const previous = cache.get(cwd) ?? { local: null, remote: null };
        const nextCache = new Map(cache);
        nextCache.set(cwd, {
          ...previous,
          local: nextLocal,
        });
        return [previous.local?.fingerprint !== nextLocal.fingerprint, nextCache] as const;
      });

      if (options?.publish && shouldPublish) {
        yield* PubSub.publish(changesPubSub, {
          cwd,
          event: {
            _tag: "localUpdated",
            local,
          },
        });
      }

      return local;
    },
  );

  const updateCachedRemoteStatus = Effect.fn("VcsStatusBroadcaster.updateCachedRemoteStatus")(
    function* (cwd: string, remote: VcsStatusRemoteResult | null, options?: { publish?: boolean }) {
      const nextRemote = {
        fingerprint: fingerprintStatusPart(remote),
        value: remote,
      } satisfies CachedValue<VcsStatusRemoteResult | null>;
      const { previousRemote, shouldPublish } = yield* Ref.modify(cacheRef, (cache) => {
        const previous = cache.get(cwd) ?? { local: null, remote: null };
        const nextCache = new Map(cache);
        nextCache.set(cwd, {
          ...previous,
          remote: nextRemote,
        });
        return [
          {
            previousRemote: previous.remote?.value,
            shouldPublish: previous.remote?.fingerprint !== nextRemote.fingerprint,
          },
          nextCache,
        ] as const;
      });

      yield* maybeRunPrMergedLifecycle(cwd, previousRemote, remote);

      if (options?.publish && shouldPublish) {
        yield* PubSub.publish(changesPubSub, {
          cwd,
          event: {
            _tag: "remoteUpdated",
            remote,
          },
        });
      }

      return remote;
    },
  );

  const updateCachedStatus = Effect.fn("VcsStatusBroadcaster.updateCachedStatus")(function* (
    cwd: string,
    local: VcsStatusLocalResult,
    remote: VcsStatusRemoteResult | null,
    options?: { publish?: boolean },
  ) {
    const nextLocal = {
      fingerprint: fingerprintStatusPart(local),
      value: local,
    } satisfies CachedValue<VcsStatusLocalResult>;
    const nextRemote = {
      fingerprint: fingerprintStatusPart(remote),
      value: remote,
    } satisfies CachedValue<VcsStatusRemoteResult | null>;
    const { previousRemote, shouldPublish } = yield* Ref.modify(cacheRef, (cache) => {
      const previous = cache.get(cwd) ?? { local: null, remote: null };
      const nextCache = new Map(cache);
      nextCache.set(cwd, {
        local: nextLocal,
        remote: nextRemote,
      });
      return [
        {
          previousRemote: previous.remote?.value,
          shouldPublish:
            previous.local?.fingerprint !== nextLocal.fingerprint ||
            previous.remote?.fingerprint !== nextRemote.fingerprint,
        },
        nextCache,
      ] as const;
    });

    yield* maybeRunPrMergedLifecycle(cwd, previousRemote, remote);

    if (options?.publish && shouldPublish) {
      yield* PubSub.publish(changesPubSub, {
        cwd,
        event: {
          _tag: "snapshot",
          local,
          remote,
        },
      });
    }

    return mergeGitStatusParts(local, remote);
  });

  const loadLocalStatus = Effect.fn("VcsStatusBroadcaster.loadLocalStatus")(function* (
    cwd: string,
  ) {
    const local = yield* workflow.localStatus({ cwd });
    return yield* updateCachedLocalStatus(cwd, local);
  });

  const getOrLoadLocalStatus = Effect.fn("VcsStatusBroadcaster.getOrLoadLocalStatus")(function* (
    cwd: string,
  ) {
    const cached = yield* getCachedStatus(cwd);
    if (cached?.local) {
      return cached.local.value;
    }
    return yield* loadLocalStatus(cwd);
  });

  const withFileSystem = Effect.provideService(FileSystem.FileSystem, fs);

  const getStatus: VcsStatusBroadcaster["Service"]["getStatus"] = Effect.fn(
    "VcsStatusBroadcaster.getStatus",
  )(function* (input) {
    const cwd = yield* withFileSystem(normalizeCwd(input.cwd));
    const cached = yield* getCachedStatus(cwd);
    if (cached?.local && cached.remote) {
      return mergeGitStatusParts(cached.local.value, cached.remote.value);
    }
    return yield* withRemoteWriteLock(
      cwd,
      Effect.gen(function* () {
        const latest = yield* getCachedStatus(cwd);
        const [local, remote] = yield* Effect.all(
          [
            latest?.local ? Effect.succeed(latest.local.value) : workflow.localStatus({ cwd }),
            latest?.remote ? Effect.succeed(latest.remote.value) : workflow.remoteStatus({ cwd }),
          ],
          { concurrency: "unbounded" },
        );
        return yield* updateCachedStatus(cwd, local, remote);
      }),
    );
  });

  const refreshLocalStatusCore = Effect.fn("VcsStatusBroadcaster.refreshLocalStatusCore")(
    function* (cwd: string) {
      yield* workflow.invalidateLocalStatus(cwd);
      const local = yield* workflow.localStatus({ cwd });
      return yield* updateCachedLocalStatus(cwd, local, { publish: true });
    },
  );

  const refreshLocalStatus: VcsStatusBroadcaster["Service"]["refreshLocalStatus"] = Effect.fn(
    "VcsStatusBroadcaster.refreshLocalStatus",
  )(function* (rawCwd) {
    const cwd = yield* withFileSystem(normalizeCwd(rawCwd));
    return yield* refreshLocalStatusCore(cwd);
  });

  const maybeAutoPull = Effect.fn("VcsStatusBroadcaster.maybeAutoPull")(function* (
    cwd: string,
    remote: VcsStatusRemoteResult | null,
    policyCwds: ReadonlyArray<string>,
  ) {
    return yield* Effect.gen(function* () {
      const autoPullEnabled = (yield* Effect.forEach(policyCwds, autoPullPolicy.isEnabled, {
        concurrency: "unbounded",
      })).some(Boolean);
      if (
        remote === null ||
        !remote.hasUpstream ||
        remote.aheadCount > 0 ||
        remote.behindCount <= 0 ||
        !autoPullEnabled
      ) {
        return null;
      }

      yield* workflow.invalidateLocalStatus(cwd);
      const local = yield* workflow.localStatus({ cwd });
      if (!local.isRepo || !local.isDefaultRef || local.hasWorkingTreeChanges) return null;

      yield* workflow.pullCurrentBranch(cwd);
      yield* workflow.invalidateStatus(cwd);
      const [refreshedLocal, refreshedRemote] = yield* Effect.all(
        [workflow.localStatus({ cwd }), workflow.remoteStatus({ cwd }, { refreshUpstream: false })],
        { concurrency: "unbounded" },
      );
      yield* updateCachedStatus(cwd, refreshedLocal, refreshedRemote, { publish: true });
      return { local: refreshedLocal, remote: refreshedRemote };
    }).pipe(
      Effect.catch(() =>
        Effect.logWarning("Automatic project pull failed", { cwd }).pipe(Effect.as(null)),
      ),
    );
  });

  const refreshRemoteStatus = Effect.fn("VcsStatusBroadcaster.refreshRemoteStatus")(function* (
    cwd: string,
    options?: {
      readonly refreshUpstream?: boolean;
      readonly forceInvalidate?: boolean;
      readonly policyCwds?: ReadonlyArray<string>;
    },
  ) {
    // Automatic poller ticks rely on GitManager's remote status TTL rather than
    // wiping the cache every interval (which re-spawns gh for every worktree).
    // Manual refreshStatus still force-invalidates.
    return yield* withRemoteWriteLock(
      cwd,
      Effect.gen(function* () {
        if (options?.forceInvalidate) {
          yield* workflow.invalidateRemoteStatus(cwd);
        }
        const remote = yield* workflow.remoteStatus({ cwd }, options);
        const pulled = yield* maybeAutoPull(cwd, remote, options?.policyCwds ?? [cwd]);
        if (pulled !== null) return pulled.remote;
        return yield* updateCachedRemoteStatus(cwd, remote, { publish: true });
      }),
    );
  });

  const refreshStatus: VcsStatusBroadcaster["Service"]["refreshStatus"] = Effect.fn(
    "VcsStatusBroadcaster.refreshStatus",
  )(function* (rawCwd) {
    const cwd = yield* withFileSystem(normalizeCwd(rawCwd));
    // invalidateStatus (not the two partial invalidations) so an explicit
    // refresh also bypasses GitManager's slow PR-lookup cache.
    return yield* withRemoteWriteLock(
      cwd,
      Effect.gen(function* () {
        yield* workflow.invalidateStatus(cwd);
        const [local, remote] = yield* Effect.all(
          [workflow.localStatus({ cwd }), workflow.remoteStatus({ cwd })],
          { concurrency: "unbounded" },
        );
        const pulled = yield* maybeAutoPull(cwd, remote, [rawCwd]);
        if (pulled !== null) return mergeGitStatusParts(pulled.local, pulled.remote);
        return yield* updateCachedStatus(cwd, local, remote, { publish: true });
      }),
    );
  });

  const refreshPullRequestStatus: VcsStatusBroadcaster["Service"]["refreshPullRequestStatus"] =
    Effect.fn("VcsStatusBroadcaster.refreshPullRequestStatus")(function* (rawCwd) {
      const cwd = yield* withFileSystem(normalizeCwd(rawCwd));
      return yield* withRemoteWriteLock(
        cwd,
        Effect.gen(function* () {
          const cached = yield* getCachedStatus(cwd);
          if (cached?.remote?.value == null) return null;
          const poller = (yield* SynchronizedRef.get(pollersRef)).get(cwd);
          const demandCwds = poller ? [...(yield* Ref.get(poller.demandCwds)).keys()] : [rawCwd];
          const shouldRefresh = (yield* Effect.forEach(
            demandCwds,
            (demandCwd) =>
              backgroundPolicy.shouldRunScopeWork({ type: "vcs-status", cwd: demandCwd }),
            { concurrency: "unbounded" },
          )).some(Boolean);
          if (!shouldRefresh) return null;
          // Resolve the checked-out branch again. A cached PR can belong to
          // the previous branch after an agent checks out another branch.
          const remote = yield* workflow.remoteStatus(
            { cwd },
            { refreshUpstream: false, refreshMissingPullRequest: true },
          );
          return yield* updateCachedRemoteStatus(cwd, remote, { publish: true });
        }),
      );
    });

  const makeRemoteRefreshLoop = (
    cwd: string,
    demandCwdsRef: Ref.Ref<ReadonlyMap<string, number>>,
    automaticRemoteRefreshInterval: Effect.Effect<Duration.Duration, never>,
    refreshImmediately: boolean,
  ) => {
    return Effect.gen(function* () {
      const consecutiveFailuresRef = yield* Ref.make(0);
      const needsInitialRefreshRef = yield* Ref.make(refreshImmediately);
      /** When false, sleep once before the first refresh (warm cache path). */
      const mayRefreshImmediatelyRef = yield* Ref.make(refreshImmediately);
      const refreshRemoteStatusIfEnabled = Effect.gen(function* () {
        const configuredInterval = yield* automaticRemoteRefreshInterval;
        const activeInterval = Duration.isZero(configuredInterval)
          ? DEFAULT_VCS_STATUS_REFRESH_INTERVAL
          : configuredInterval;
        const needsInitialRefresh = yield* Ref.get(needsInitialRefreshRef);
        if (Duration.isZero(configuredInterval) && !needsInitialRefresh) {
          return activeInterval;
        }

        const demandCwds = yield* Ref.get(demandCwdsRef);
        const shouldRun =
          needsInitialRefresh ||
          (yield* Effect.all(
            [...demandCwds.keys()].map((demandCwd) =>
              backgroundPolicy.shouldRunScopeWork({
                type: "vcs-status",
                cwd: demandCwd,
              }),
            ),
            { concurrency: "unbounded" },
          )).some(Boolean);
        if (!shouldRun) {
          return activeInterval;
        }

        const exit = yield* refreshRemoteStatus(cwd, {
          refreshUpstream: !Duration.isZero(configuredInterval),
          policyCwds: [...demandCwds.keys()],
        }).pipe(Effect.exit);
        if (Exit.isSuccess(exit)) {
          yield* Ref.set(needsInitialRefreshRef, false);
          yield* Ref.set(consecutiveFailuresRef, 0);
          return activeInterval;
        }

        const interruptionReasons = exit.cause.reasons.filter(Cause.isInterruptReason);
        if (interruptionReasons.length > 0) {
          return yield* Effect.failCause(Cause.fromReasons<never>(interruptionReasons));
        }

        const consecutiveFailures = yield* Ref.updateAndGet(
          consecutiveFailuresRef,
          (count) => count + 1,
        );
        const nextDelay = remoteRefreshFailureDelay(consecutiveFailures, activeInterval);
        yield* Effect.logWarning("VCS remote status refresh failed", {
          cwdLength: cwd.length,
          ...remoteRefreshFailureDiagnostics(exit.cause),
          consecutiveFailures,
          nextDelayMs: Duration.toMillis(nextDelay),
        });
        return nextDelay;
      });

      // Work → wait → work. Delay starts only after refresh fully completes.
      return yield* Effect.forever(
        Effect.gen(function* () {
          const mayRefreshImmediately = yield* Ref.get(mayRefreshImmediatelyRef);
          if (!mayRefreshImmediately) {
            const configuredInterval = yield* automaticRemoteRefreshInterval;
            yield* Effect.sleep(
              Duration.isZero(configuredInterval)
                ? DEFAULT_VCS_STATUS_REFRESH_INTERVAL
                : configuredInterval,
            );
            yield* Ref.set(mayRefreshImmediatelyRef, true);
          }
          const delay = yield* refreshRemoteStatusIfEnabled;
          yield* Effect.sleep(delay);
        }),
      );
    });
  };

  const retainRemotePoller = Effect.fn("VcsStatusBroadcaster.retainRemotePoller")(function* (
    cwd: string,
    demandCwd: string,
    automaticRemoteRefreshInterval: Effect.Effect<Duration.Duration, never>,
    refreshImmediately: boolean,
  ) {
    yield* SynchronizedRef.modifyEffect(pollersRef, (activePollers) => {
      const existing = activePollers.get(cwd);
      if (existing) {
        return Ref.update(existing.demandCwds, (demandCwds) => {
          const next = new Map(demandCwds);
          next.set(demandCwd, (next.get(demandCwd) ?? 0) + 1);
          return next;
        }).pipe(
          Effect.map(() => {
            const nextPollers = new Map(activePollers);
            nextPollers.set(cwd, {
              ...existing,
              subscriberCount: existing.subscriberCount + 1,
            });
            return [undefined, nextPollers] as const;
          }),
        );
      }

      return Ref.make<ReadonlyMap<string, number>>(new Map([[demandCwd, 1]])).pipe(
        Effect.flatMap((demandCwds) =>
          makeRemoteRefreshLoop(
            cwd,
            demandCwds,
            automaticRemoteRefreshInterval,
            refreshImmediately,
          ).pipe(
            Effect.forkIn(broadcasterScope),
            Effect.map((fiber) => {
              const nextPollers = new Map(activePollers);
              nextPollers.set(cwd, {
                fiber,
                subscriberCount: 1,
                demandCwds,
              });
              return [undefined, nextPollers] as const;
            }),
          ),
        ),
      );
    });
  });

  const releaseRemotePoller = Effect.fn("VcsStatusBroadcaster.releaseRemotePoller")(function* (
    cwd: string,
    demandCwd: string,
  ) {
    const pollerToInterrupt = yield* SynchronizedRef.modifyEffect(pollersRef, (activePollers) => {
      const existing = activePollers.get(cwd);
      if (!existing) {
        return Effect.succeed([null, activePollers] as const);
      }

      if (existing.subscriberCount > 1) {
        return Ref.update(existing.demandCwds, (demandCwds) => {
          const nextDemandCwds = new Map(demandCwds);
          const count = nextDemandCwds.get(demandCwd) ?? 0;
          if (count <= 1) {
            nextDemandCwds.delete(demandCwd);
          } else {
            nextDemandCwds.set(demandCwd, count - 1);
          }
          return nextDemandCwds;
        }).pipe(
          Effect.as([
            null,
            new Map(activePollers).set(cwd, {
              ...existing,
              subscriberCount: existing.subscriberCount - 1,
            }),
          ] as const),
        );
      }

      const nextPollers = new Map(activePollers);
      nextPollers.delete(cwd);
      // Keep the broadcaster snapshot after the last subscriber leaves so a
      // reconnect (or sidebar re-subscribe) can rehydrate without immediately
      // re-running multi-process local status for every worktree. Capacity is
      // bounded by unique cwds; explicit invalidate/refresh still force reload.
      return Effect.succeed([existing.fiber, nextPollers] as const);
    });

    if (pollerToInterrupt) {
      yield* Fiber.interrupt(pollerToInterrupt).pipe(Effect.ignore);
    }
  });

  /**
   * Budgeted remote refresh for list-interested cwds without a full-mode poller.
   * Exclusive (mutex): never overlaps another list sweep. Round-robins a small
   * batch so dozens of worktrees cannot run multi-minute all-at-once storms that
   * starve SessionStore.verify / websocket-ticket (SQLite is single-permit).
   */
  const runListRemoteRefreshSweep = Effect.fn("VcsStatusBroadcaster.runListRemoteRefreshSweep")(
    function* () {
      yield* listSweepMutex.withPermits(1)(
        Effect.gen(function* () {
          const interests = yield* SynchronizedRef.get(listInterestRef);
          const fullPollers = yield* SynchronizedRef.get(pollersRef);
          const cwds = [...interests.keys()].filter((cwd) => !fullPollers.has(cwd));
          if (cwds.length === 0) {
            return;
          }

          const cursor = yield* Ref.get(listRefreshCursorRef);
          const start = cwds.length === 0 ? 0 : cursor % cwds.length;
          const batch: string[] = [];
          for (let i = 0; i < Math.min(LIST_REMOTE_REFRESH_BATCH_SIZE, cwds.length); i += 1) {
            const cwd = cwds[(start + i) % cwds.length];
            if (cwd !== undefined) {
              batch.push(cwd);
            }
          }
          yield* Ref.set(
            listRefreshCursorRef,
            cwds.length === 0 ? 0 : (start + batch.length) % cwds.length,
          );

          yield* Effect.forEach(
            batch,
            (cwd) => refreshRemoteStatus(cwd, { refreshUpstream: false }).pipe(Effect.ignore),
            { concurrency: LIST_REMOTE_REFRESH_CONCURRENCY },
          );
        }),
      );
    },
  );

  const makeListRemoteRefreshLoop = () =>
    // Always: complete a sweep → then wait → repeat. Never schedule the next
    // wait until the previous batch has fully finished.
    Effect.forever(
      Effect.gen(function* () {
        yield* runListRemoteRefreshSweep();
        yield* Effect.sleep(LIST_REMOTE_REFRESH_INTERVAL);
      }),
    );

  const retainListInterest = Effect.fn("VcsStatusBroadcaster.retainListInterest")(function* (
    cwd: string,
  ) {
    yield* SynchronizedRef.modifyEffect(listInterestRef, (interests) => {
      const next = new Map(interests);
      next.set(cwd, (next.get(cwd) ?? 0) + 1);
      return Effect.succeed([undefined, next] as const);
    });

    yield* SynchronizedRef.modifyEffect(listRefreshFiberRef, (existing) => {
      if (existing) {
        return Effect.succeed([undefined, existing] as const);
      }
      return makeListRemoteRefreshLoop().pipe(
        Effect.forkIn(broadcasterScope),
        Effect.map((fiber) => [undefined, fiber] as const),
      );
    });
  });

  const releaseListInterest = Effect.fn("VcsStatusBroadcaster.releaseListInterest")(function* (
    cwd: string,
  ) {
    const shouldStopLoop = yield* SynchronizedRef.modifyEffect(listInterestRef, (interests) => {
      const current = interests.get(cwd) ?? 0;
      if (current <= 0) {
        return Effect.succeed([false, interests] as const);
      }
      const next = new Map(interests);
      if (current === 1) {
        next.delete(cwd);
      } else {
        next.set(cwd, current - 1);
      }
      return Effect.succeed([next.size === 0, next] as const);
    });

    if (!shouldStopLoop) {
      return;
    }

    const fiber = yield* SynchronizedRef.modifyEffect(listRefreshFiberRef, (existing) =>
      Effect.succeed([existing, null] as const),
    );
    if (fiber) {
      yield* Fiber.interrupt(fiber).pipe(Effect.ignore);
    }
  });

  const streamStatus: VcsStatusBroadcaster["Service"]["streamStatus"] = (input, options) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const cwd = yield* withFileSystem(normalizeCwd(input.cwd));
        const mode = input.mode ?? "full";
        const subscription = yield* PubSub.subscribe(changesPubSub);
        const initialLocal = yield* getOrLoadLocalStatus(cwd);
        let cachedStatus = yield* getCachedStatus(cwd);

        // List mode: shared budgeted refresher keeps remote/PR state fresh for all
        // list-interested cwds without one 30s poller fiber per worktree (storm root).
        // Full mode: dedicated poller (may include git fetch) for active git chrome.
        let release: Effect.Effect<void> = Effect.void;
        if (mode === "list") {
          // Registers cwd with the shared budgeted refresher (keeps PR/remote fresh).
          // No per-cwd poller and no per-subscribe remote stampede (reconnect storms
          // used to fire N concurrent remoteStatus calls and block auth SQL).
          yield* retainListInterest(cwd);
          cachedStatus = yield* getCachedStatus(cwd);
          // If cold, kick the exclusive shared sweep without awaiting it so the
          // stream can open immediately; the sweep publishes remoteUpdated.
          if (cachedStatus?.remote === null || cachedStatus?.remote === undefined) {
            yield* runListRemoteRefreshSweep().pipe(
              Effect.forkIn(broadcasterScope),
              Effect.asVoid,
              Effect.ignore,
            );
          }
          release = releaseListInterest(cwd).pipe(Effect.ignore, Effect.asVoid);
        } else {
          yield* retainRemotePoller(
            cwd,
            input.cwd,
            options?.automaticRemoteRefreshInterval ??
              Effect.succeed(DEFAULT_VCS_STATUS_REFRESH_INTERVAL),
            cachedStatus?.remote === null || cachedStatus?.remote === undefined,
          );
          release = releaseRemotePoller(cwd, input.cwd).pipe(Effect.ignore, Effect.asVoid);
        }

        const initialRemote = cachedStatus?.remote?.value ?? null;

        // When remote is not cached yet, emit localUpdated only — never a snapshot that
        // fabricates remote defaults (pr:null). Downstream clients treat that fake null
        // PR as "no PR" and thrash badges (Discord ▫️⇄❌🔀 on every rehydrate).
        const initialEvent =
          initialRemote !== null
            ? ({
                _tag: "snapshot" as const,
                local: initialLocal,
                remote: initialRemote,
              } as const)
            : ({
                _tag: "localUpdated" as const,
                local: initialLocal,
              } as const);

        return Stream.concat(
          Stream.make(initialEvent),
          Stream.fromSubscription(subscription).pipe(
            Stream.filter((event) => event.cwd === cwd),
            Stream.map((event) => event.event),
          ),
        ).pipe(Stream.ensuring(release));
      }),
    );

  return VcsStatusBroadcaster.of({
    getStatus,
    refreshLocalStatus,
    refreshStatus,
    refreshPullRequestStatus,
    streamStatus,
  });
});

export const layer = Layer.effect(VcsStatusBroadcaster, make);
