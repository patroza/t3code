import { type ScopedProjectRef, type ScopedThreadRef, type ThreadId } from "@t3tools/contracts";
import {
  contextWindowSnapshotsEqual,
  deriveLatestContextWindowSnapshot,
  type ContextWindowSnapshot,
} from "./lib/contextWindow";
import { selectEnvironmentState, type AppState, type EnvironmentState } from "./store";
import { type Project, type Thread } from "./types";
import { getThreadFromEnvironmentState } from "./threadDerivation";

export function createProjectSelectorByRef(
  ref: ScopedProjectRef | null | undefined,
): (state: AppState) => Project | undefined {
  return (state) =>
    ref ? selectEnvironmentState(state, ref.environmentId).projectById[ref.projectId] : undefined;
}

function createScopedThreadSelector(
  resolveRef: (state: AppState) => ScopedThreadRef | null | undefined,
): (state: AppState) => Thread | undefined {
  let previousEnvironmentState: EnvironmentState | undefined;
  let previousThreadId: ThreadId | undefined;
  let previousThread: Thread | undefined;

  return (state) => {
    const ref = resolveRef(state);
    if (!ref) {
      return undefined;
    }

    const environmentState = selectEnvironmentState(state, ref.environmentId);
    if (
      previousThread &&
      previousEnvironmentState === environmentState &&
      previousThreadId === ref.threadId
    ) {
      return previousThread;
    }

    previousEnvironmentState = environmentState;
    previousThreadId = ref.threadId;
    previousThread = getThreadFromEnvironmentState(environmentState, ref.threadId);
    return previousThread;
  };
}

export function createThreadSelectorByRef(
  ref: ScopedThreadRef | null | undefined,
): (state: AppState) => Thread | undefined {
  return createScopedThreadSelector(() => ref);
}

export function createContextWindowSnapshotSelectorByRef(
  ref: ScopedThreadRef | null | undefined,
): (state: AppState) => ContextWindowSnapshot | null {
  let previousEnvironmentState: EnvironmentState | undefined;
  let previousThreadId: ThreadId | undefined;
  let previousActivityIds: readonly string[] | undefined;
  let previousSnapshot: ContextWindowSnapshot | null = null;

  return (state) => {
    if (!ref) {
      previousEnvironmentState = undefined;
      previousThreadId = undefined;
      previousActivityIds = undefined;
      previousSnapshot = null;
      return null;
    }

    const environmentState = selectEnvironmentState(state, ref.environmentId);
    const activityIds = environmentState.activityIdsByThreadId[ref.threadId];
    if (
      previousEnvironmentState === environmentState &&
      previousThreadId === ref.threadId &&
      previousActivityIds === activityIds
    ) {
      return previousSnapshot;
    }

    const activities =
      activityIds?.flatMap((activityId) => {
        const activity = environmentState.activityByThreadId[ref.threadId]?.[activityId];
        return activity ? [activity] : [];
      }) ?? [];
    const nextSnapshot = deriveLatestContextWindowSnapshot(activities);
    previousEnvironmentState = environmentState;
    previousThreadId = ref.threadId;
    previousActivityIds = activityIds;

    if (contextWindowSnapshotsEqual(previousSnapshot, nextSnapshot)) {
      return previousSnapshot;
    }

    previousSnapshot = nextSnapshot;
    return nextSnapshot;
  };
}

export function createThreadSelectorAcrossEnvironments(
  threadId: ThreadId | null | undefined,
): (state: AppState) => Thread | undefined {
  return createScopedThreadSelector((state) => {
    if (!threadId) {
      return undefined;
    }

    for (const [environmentId, environmentState] of Object.entries(
      state.environmentStateById,
    ) as Array<[ScopedThreadRef["environmentId"], EnvironmentState]>) {
      if (environmentState.threadShellById[threadId]) {
        return {
          environmentId,
          threadId,
        };
      }
    }
    return undefined;
  });
}
