import { EnvironmentId, type OrchestrationShellSnapshot } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom, type AtomRegistry } from "effect/unstable/reactivity";

export type ArchivedSnapshotEntry = {
  readonly environmentId: EnvironmentId;
  readonly snapshot: OrchestrationShellSnapshot;
};

export interface ArchivedThreadsClient {
  readonly getArchivedShellSnapshot: () => Promise<OrchestrationShellSnapshot>;
}

export interface ArchivedThreadsSnapshotState {
  readonly snapshots: ReadonlyArray<ArchivedSnapshotEntry>;
  readonly error: string | null;
  readonly isLoading: boolean;
}

const ARCHIVED_THREADS_ENVIRONMENT_KEY_SEPARATOR = "\u001f";
const DEFAULT_ARCHIVED_THREADS_STALE_TIME_MS = 5_000;
const DEFAULT_ARCHIVED_THREADS_IDLE_TTL_MS = 5 * 60_000;

export function makeArchivedThreadsEnvironmentKey(
  environmentIds: ReadonlyArray<EnvironmentId>,
): string {
  return environmentIds.toSorted().join(ARCHIVED_THREADS_ENVIRONMENT_KEY_SEPARATOR);
}

export function parseArchivedThreadsEnvironmentKey(key: string): ReadonlyArray<EnvironmentId> {
  if (key.length === 0) {
    return [];
  }
  return key
    .split(ARCHIVED_THREADS_ENVIRONMENT_KEY_SEPARATOR)
    .map((environmentId) => EnvironmentId.make(environmentId));
}

export function readArchivedThreadsSnapshotState(
  result: AsyncResult.AsyncResult<ReadonlyArray<ArchivedSnapshotEntry>, unknown>,
): ArchivedThreadsSnapshotState {
  const snapshots = Option.getOrElse(AsyncResult.value(result), () => []);
  let error: string | null = null;
  if (result._tag === "Failure") {
    const cause = Cause.squash(result.cause);
    error = cause instanceof Error ? cause.message : "Failed to load archived threads.";
  }

  return {
    snapshots,
    error,
    isLoading: result.waiting,
  };
}

export function createArchivedThreadsManager(config: {
  readonly getRegistry: () => AtomRegistry.AtomRegistry;
  readonly getClient: (environmentId: EnvironmentId) => ArchivedThreadsClient | null;
  readonly staleTimeMs?: number;
  readonly idleTtlMs?: number;
}) {
  const knownEnvironmentKeys = new Set<string>();
  const staleTime = config.staleTimeMs ?? DEFAULT_ARCHIVED_THREADS_STALE_TIME_MS;
  const idleTtl = config.idleTtlMs ?? DEFAULT_ARCHIVED_THREADS_IDLE_TTL_MS;

  const snapshotsAtom = Atom.family((environmentKey: string) => {
    knownEnvironmentKeys.add(environmentKey);
    return Atom.make(
      Effect.promise(async (): Promise<ReadonlyArray<ArchivedSnapshotEntry>> => {
        const snapshots = await Promise.all(
          parseArchivedThreadsEnvironmentKey(environmentKey).map(async (environmentId) => {
            const client = config.getClient(environmentId);
            if (!client) {
              return null;
            }
            return {
              environmentId,
              snapshot: await client.getArchivedShellSnapshot(),
            };
          }),
        );
        return snapshots.filter((snapshot) => snapshot !== null);
      }),
    ).pipe(
      Atom.swr({
        staleTime,
        revalidateOnMount: true,
      }),
      Atom.setIdleTTL(idleTtl),
      Atom.withLabel(`archived-thread-snapshots:${environmentKey}`),
    );
  });

  function getAtom(environmentKey: string) {
    return snapshotsAtom(environmentKey);
  }

  function refresh(environmentIds: ReadonlyArray<EnvironmentId>): void {
    config.getRegistry().refresh(getAtom(makeArchivedThreadsEnvironmentKey(environmentIds)));
  }

  function refreshForEnvironment(environmentId: EnvironmentId): void {
    for (const environmentKey of knownEnvironmentKeys) {
      if (parseArchivedThreadsEnvironmentKey(environmentKey).includes(environmentId)) {
        config.getRegistry().refresh(getAtom(environmentKey));
      }
    }
  }

  return {
    getAtom,
    refresh,
    refreshForEnvironment,
  };
}
