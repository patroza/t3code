import {
  type EnvironmentId,
  type GitActionProgressEvent,
  type GitRunStackedActionResult,
  type GitStackedAction,
  type GitResolvePullRequestResult,
  type SourceControlCloneProtocol,
  type SourceControlPublishRepositoryResult,
  type SourceControlRepositoryVisibility,
  type ThreadId,
  type VcsPullResult,
} from "@t3tools/contracts";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  useTransition,
} from "react";

import { ensureEnvironmentApi } from "../environmentApi";
import { requireEnvironmentConnection } from "../environments/runtime";
import { refreshGitStatus } from "./gitStatusState";
import { vcsRefManager } from "./vcsRefState";

type SourceControlActionKind =
  | "init"
  | "pull"
  | "publishRepository"
  | "runStackedAction"
  | "preparePullRequestThread";

interface SourceControlActionScope {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
}

interface SourceControlActionState<TArgs extends ReadonlyArray<unknown>, TResult> {
  readonly isPending: boolean;
  readonly error: unknown;
  readonly run: (...args: TArgs) => Promise<TResult>;
  readonly resetError: () => void;
}

const actionListeners = new Set<() => void>();
const activeActionCounts = new Map<string, number>();

function notifyActionListeners(): void {
  for (const listener of actionListeners) {
    listener();
  }
}

function subscribeActionState(listener: () => void): () => void {
  actionListeners.add(listener);
  return () => {
    actionListeners.delete(listener);
  };
}

function actionKey(kind: SourceControlActionKind, scope: SourceControlActionScope): string {
  return `${kind}:${scope.environmentId ?? ""}:${scope.cwd ?? ""}`;
}

function beginAction(key: string): () => void {
  activeActionCounts.set(key, (activeActionCounts.get(key) ?? 0) + 1);
  notifyActionListeners();
  let ended = false;
  return () => {
    if (ended) {
      return;
    }
    ended = true;
    const next = (activeActionCounts.get(key) ?? 1) - 1;
    if (next <= 0) {
      activeActionCounts.delete(key);
    } else {
      activeActionCounts.set(key, next);
    }
    notifyActionListeners();
  };
}

function isAnyActionRunning(
  kinds: ReadonlyArray<SourceControlActionKind>,
  scope: SourceControlActionScope,
): boolean {
  return kinds.some((kind) => (activeActionCounts.get(actionKey(kind, scope)) ?? 0) > 0);
}

export function invalidateSourceControlState(scope?: {
  readonly environmentId?: EnvironmentId | null;
  readonly cwd?: string | null;
}): Promise<void> {
  const environmentId = scope?.environmentId ?? null;
  const cwd = scope?.cwd ?? null;
  if (cwd !== null) {
    vcsRefManager.invalidateScope({ environmentId, cwd });
    if (environmentId !== null) {
      return refreshGitStatus({ environmentId, cwd }).then(
        () => undefined,
        () => undefined,
      );
    }
    return Promise.resolve();
  }

  vcsRefManager.invalidate();
  return Promise.resolve();
}

function useSourceControlAction<TArgs extends ReadonlyArray<unknown>, TResult>(input: {
  readonly kind: SourceControlActionKind;
  readonly scope: SourceControlActionScope;
  readonly action: (...args: TArgs) => Promise<TResult>;
  readonly invalidateOnSuccess?: boolean;
}): SourceControlActionState<TArgs, TResult> {
  const { action, invalidateOnSuccess = true, kind, scope } = input;
  const [error, setError] = useState<unknown>(null);
  const [activeCount, setActiveCount] = useState(0);
  const [isTransitionPending, startTransition] = useTransition();
  const key = actionKey(kind, scope);

  const resetError = useCallback(() => {
    startTransition(() => setError(null));
  }, [startTransition]);

  const run = useCallback(
    async (...args: TArgs): Promise<TResult> => {
      const endAction = beginAction(key);
      startTransition(() => {
        setError(null);
        setActiveCount((count) => count + 1);
      });
      try {
        const result = await action(...args);
        if (invalidateOnSuccess) {
          await invalidateSourceControlState(scope);
        }
        return result;
      } catch (nextError) {
        startTransition(() => setError(nextError));
        throw nextError;
      } finally {
        endAction();
        startTransition(() => setActiveCount((count) => Math.max(0, count - 1)));
      }
    },
    [action, invalidateOnSuccess, key, scope, startTransition],
  );

  return {
    error,
    isPending: activeCount > 0 || isTransitionPending,
    resetError,
    run,
  };
}

export function useSourceControlActionRunning(
  scope: SourceControlActionScope,
  kinds: ReadonlyArray<SourceControlActionKind>,
): boolean {
  const stableKinds = useMemo(() => [...kinds].sort(), [kinds]);
  return useSyncExternalStore(
    subscribeActionState,
    () => isAnyActionRunning(stableKinds, scope),
    () => false,
  );
}

export function useVcsInitAction(scope: SourceControlActionScope) {
  const action = useCallback(async () => {
    if (!scope.cwd || !scope.environmentId) throw new Error("Git init is unavailable.");
    return ensureEnvironmentApi(scope.environmentId).vcs.init({ cwd: scope.cwd });
  }, [scope]);

  return useSourceControlAction({
    kind: "init",
    scope,
    action,
  });
}

export function useGitStackedAction(scope: SourceControlActionScope) {
  const action = useCallback(
    async ({
      actionId,
      action,
      commitMessage,
      featureBranch,
      filePaths,
      onProgress,
    }: {
      actionId: string;
      action: GitStackedAction;
      commitMessage?: string;
      featureBranch?: boolean;
      filePaths?: string[];
      onProgress?: (event: GitActionProgressEvent) => void;
    }): Promise<GitRunStackedActionResult> => {
      if (!scope.cwd || !scope.environmentId) throw new Error("Git action is unavailable.");
      return requireEnvironmentConnection(scope.environmentId).client.git.runStackedAction(
        {
          action,
          actionId,
          cwd: scope.cwd,
          ...(commitMessage ? { commitMessage } : {}),
          ...(featureBranch ? { featureBranch: true } : {}),
          ...(filePaths && filePaths.length > 0 ? { filePaths } : {}),
        },
        ...(onProgress ? [{ onProgress }] : []),
      );
    },
    [scope],
  );

  return useSourceControlAction({
    kind: "runStackedAction",
    scope,
    action,
  });
}

export function useVcsPullAction(scope: SourceControlActionScope) {
  const action = useCallback(async (): Promise<VcsPullResult> => {
    if (!scope.cwd || !scope.environmentId) throw new Error("Git pull is unavailable.");
    return ensureEnvironmentApi(scope.environmentId).vcs.pull({ cwd: scope.cwd });
  }, [scope]);

  return useSourceControlAction({
    kind: "pull",
    scope,
    action,
  });
}

export function useSourceControlPublishRepositoryAction(scope: SourceControlActionScope) {
  const action = useCallback(
    async (args: {
      provider: "github" | "gitlab" | "bitbucket" | "azure-devops";
      repository: string;
      visibility: SourceControlRepositoryVisibility;
      remoteName: string;
      protocol: SourceControlCloneProtocol;
    }): Promise<SourceControlPublishRepositoryResult> => {
      if (!scope.cwd || !scope.environmentId) {
        throw new Error("Repository publishing is unavailable.");
      }
      return ensureEnvironmentApi(scope.environmentId).sourceControl.publishRepository({
        cwd: scope.cwd,
        ...args,
      });
    },
    [scope],
  );

  return useSourceControlAction({
    kind: "publishRepository",
    scope,
    action,
  });
}

export function usePreparePullRequestThreadAction(scope: SourceControlActionScope) {
  const action = useCallback(
    async (args: { reference: string; mode: "local" | "worktree"; threadId?: ThreadId }) => {
      if (!scope.cwd || !scope.environmentId) {
        throw new Error("Pull request thread preparation is unavailable.");
      }
      return ensureEnvironmentApi(scope.environmentId).git.preparePullRequestThread({
        cwd: scope.cwd,
        reference: args.reference,
        mode: args.mode,
        ...(args.threadId ? { threadId: args.threadId } : {}),
      });
    },
    [scope],
  );

  return useSourceControlAction({
    kind: "preparePullRequestThread",
    scope,
    action,
  });
}

interface PullRequestResolutionTarget {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly reference: string | null;
}

interface PullRequestResolutionState {
  readonly data: GitResolvePullRequestResult | null;
  readonly error: unknown;
  readonly isPending: boolean;
  readonly isFetching: boolean;
}

const EMPTY_PULL_REQUEST_RESOLUTION: PullRequestResolutionState = {
  data: null,
  error: null,
  isPending: false,
  isFetching: false,
};

const pullRequestResolutionCache = new Map<string, GitResolvePullRequestResult>();

function pullRequestResolutionKey(target: PullRequestResolutionTarget): string | null {
  if (!target.environmentId || !target.cwd || !target.reference) {
    return null;
  }
  return `${target.environmentId}:${target.cwd}:${target.reference}`;
}

export function readCachedPullRequestResolution(
  target: PullRequestResolutionTarget,
): GitResolvePullRequestResult | null {
  const key = pullRequestResolutionKey(target);
  return key ? (pullRequestResolutionCache.get(key) ?? null) : null;
}

export function usePullRequestResolution(
  target: PullRequestResolutionTarget,
): PullRequestResolutionState {
  const stableTarget = useMemo(
    () => ({
      environmentId: target.environmentId,
      cwd: target.cwd,
      reference: target.reference,
    }),
    [target.cwd, target.environmentId, target.reference],
  );
  const key = pullRequestResolutionKey(stableTarget);
  const [state, setState] = useState<PullRequestResolutionState>(() => {
    const cached = readCachedPullRequestResolution(stableTarget);
    return cached
      ? { data: cached, error: null, isPending: false, isFetching: false }
      : EMPTY_PULL_REQUEST_RESOLUTION;
  });

  useEffect(() => {
    if (!key || !stableTarget.environmentId || !stableTarget.cwd || !stableTarget.reference) {
      setState(EMPTY_PULL_REQUEST_RESOLUTION);
      return;
    }

    const cached = pullRequestResolutionCache.get(key) ?? null;
    setState({
      data: cached,
      error: null,
      isPending: cached === null,
      isFetching: true,
    });

    let cancelled = false;
    ensureEnvironmentApi(stableTarget.environmentId)
      .git.resolvePullRequest({ cwd: stableTarget.cwd, reference: stableTarget.reference })
      .then((result) => {
        if (cancelled) {
          return;
        }
        pullRequestResolutionCache.set(key, result);
        setState({ data: result, error: null, isPending: false, isFetching: false });
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }
        setState({ data: cached, error, isPending: false, isFetching: false });
      });

    return () => {
      cancelled = true;
    };
  }, [key, stableTarget]);

  return state;
}
