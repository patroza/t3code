import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  createLinkedPullRequestSummaryAtomFamily,
  pullRequestDetailToVcsStatus,
} from "@t3tools/client-runtime/state/pull-requests";
import type { EnvironmentId, PullRequestSummary } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom } from "effect/reactivity";
import { use, useCallback, useEffect, useMemo } from "react";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { appAtomRegistry } from "./atom-registry";

import { connectionAtomRuntime } from "../connection/runtime";
import { serverEnvironment } from "./server";
import { useEnvironmentQuery } from "./query";
import { vcsEnvironment } from "./vcs";
import { ThreadPrDemandContext } from "./thread-pr-demand";
import {
  rememberBounded,
  resolveThreadPrSource,
  presentThreadPr,
  type ThreadPrPresentation,
} from "./thread-pr-presentation";

const MAX_PULL_REQUEST_SNAPSHOTS = 500;

// One bounded cache survives row virtualization (the summary query is dropped once idle) without
// retaining one live atom for every pull request ever seen.
const pullRequestSnapshotsAtom = Atom.make<ReadonlyMap<string, PullRequestSummary>>(new Map()).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:thread-pr-snapshots"),
);

function snapshotKey(
  environmentId: EnvironmentId,
  reference: { readonly projectId: string; readonly repository: string; readonly number: number },
): string {
  return JSON.stringify([
    environmentId,
    reference.projectId,
    reference.repository,
    reference.number,
  ]);
}

const pullRequestSummaryAtom = createLinkedPullRequestSummaryAtomFamily(
  connectionAtomRuntime,
  undefined,
  ({ environmentId, input }, summary, registry) =>
    Effect.sync(() =>
      registry.update(pullRequestSnapshotsAtom, (current) =>
        rememberBounded(
          current,
          snapshotKey(environmentId, input),
          summary,
          MAX_PULL_REQUEST_SNAPSHOTS,
        ),
      ),
    ),
);

const MAX_THREAD_PR_SNAPSHOTS = 500;

interface ThreadPrSnapshot {
  readonly identity: string;
  readonly presentation: ThreadPrPresentation;
}

// Bound the cache across row virtualization instead of retaining live atoms for every past thread or PR.
const threadPrSnapshotsAtom = Atom.make<ReadonlyMap<string, ThreadPrSnapshot>>(new Map()).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:thread-pr-snapshots"),
);

export {
  presentThreadPr,
  type ThreadPr,
  type ThreadPrPresentation,
} from "./thread-pr-presentation";

export function useThreadPr(
  thread: EnvironmentThreadShell,
  projectCwd?: string | null,
): ThreadPrPresentation | null {
  const cwd = thread.worktreePath ?? projectCwd ?? null;
  const demand = use(ThreadPrDemandContext);
  const supportsLinks = useAtomValue(
    serverEnvironment.configValueAtom(thread.environmentId),
    (config) => config !== null,
  );
  const { linkedPresentation, pullRequestRef } = useMemo(
    () =>
      resolveThreadPrSource(
        {
          pullRequests: thread.pullRequests,
          linkedPullRequest: thread.linkedPullRequest,
          branchPullRequest: thread.branchPullRequest,
        },
        supportsLinks,
      ),
    [thread.pullRequests, thread.linkedPullRequest, thread.branchPullRequest, supportsLinks],
  );
  const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
  const snapshotIdentity = JSON.stringify(pullRequestRef ?? { branch: thread.branch, cwd });
  // Select this row's entry so writes for other rows do not re-render it.
  const snapshotEntry = useAtomValue(
    threadPrSnapshotsAtom,
    useCallback(
      (current: ReadonlyMap<string, ThreadPrSnapshot>) => current.get(threadKey),
      [threadKey],
    ),
  );
  const branchSnapshot =
    snapshotEntry?.identity === snapshotIdentity ? snapshotEntry.presentation : null;
  const gitStatus = useEnvironmentQuery(
    demand && pullRequestRef === null && thread.branch !== null && cwd !== null
      ? vcsEnvironment.listStatus({
          environmentId: thread.environmentId,
          input: { cwd },
        })
      : null,
  );

  const key = pullRequestRef === null ? null : snapshotKey(thread.environmentId, pullRequestRef);
  // Select this row's entry so answers for other pull requests do not re-render it.
  const snapshot = useAtomValue(pullRequestSnapshotsAtom, (current) =>
    key === null ? undefined : current.get(key),
  );
  const pullRequestSummary = useEnvironmentQuery(
    pullRequestRef === null || !demand
      ? null
      : pullRequestSummaryAtom({
          environmentId: thread.environmentId,
          input: {
            projectId: pullRequestRef.projectId,
            repository: pullRequestRef.repository,
            number: pullRequestRef.number,
          },
        }),
  );
  const summary = pullRequestRef === null ? undefined : (pullRequestSummary.data ?? snapshot);
  // Rows pass `pr` into callbacks; a fresh object per render would invalidate them.
  const summaryPresentation = useMemo(
    () =>
      summary === undefined
        ? null
        : presentThreadPr(pullRequestDetailToVcsStatus(summary), {
            kind: summary.provider,
            name: summary.provider,
            baseUrl: "",
          }),
    [summary],
  );
  const live = useMemo<ThreadPrPresentation | null | undefined>(() => {
    if (pullRequestRef !== null) return null;

    if (thread.branch === null || cwd === null) return null;
    const status = gitStatus.data;
    if (status === null) return undefined;
    if (status.refName !== thread.branch || !status.pr) return null;
    return presentThreadPr(status.pr, status.sourceControlProvider);
  }, [cwd, gitStatus.data, pullRequestRef, thread.branch]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the bounded PR snapshot registry in step with live query results across row virtualization
  useEffect(() => {
    if (live === undefined) return;
    appAtomRegistry.modify(threadPrSnapshotsAtom, (current) => {
      const existing = current.get(threadKey);
      if (live === null) {
        if (existing === undefined) return [false, current];
        const next = new Map(current);
        next.delete(threadKey);
        return [true, next];
      }
      if (existing?.identity === snapshotIdentity && existing.presentation === live) {
        return [false, current];
      }
      const next = new Map(current);
      next.delete(threadKey);
      next.set(threadKey, { identity: snapshotIdentity, presentation: live });
      while (next.size > MAX_THREAD_PR_SNAPSHOTS) {
        const oldestKey = next.keys().next().value;
        if (oldestKey === undefined) break;
        next.delete(oldestKey);
      }
      return [true, next];
    });
  }, [live, snapshotIdentity, threadKey]);

  return linkedPresentation ?? summaryPresentation ?? (live === undefined ? branchSnapshot : live);
}
