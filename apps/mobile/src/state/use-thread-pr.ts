import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  createLinkedPullRequestDetailAtomFamily,
  pullRequestDetailToVcsStatus,
} from "@t3tools/client-runtime/state/pull-requests";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery } from "./query";
import { presentThreadPr, type ThreadPrPresentation } from "./thread-pr-presentation";
import { vcsEnvironment } from "./vcs";

const linkedPullRequestDetailAtom = createLinkedPullRequestDetailAtomFamily(connectionAtomRuntime);

export {
  presentThreadPr,
  type ThreadPr,
  type ThreadPrPresentation,
} from "./thread-pr-presentation";

/**
 * List-mode PR status for a thread's branch (shared budgeted remote refresh).
 * Deduped per (environmentId, cwd); use full `status` for active git chrome.
 */
export function useThreadPr(
  thread: EnvironmentThreadShell,
  projectCwd: string | null,
): ThreadPrPresentation | null {
  const cwd = thread.worktreePath ?? projectCwd;
  const gitStatus = useEnvironmentQuery(
    thread.linkedPullRequest == null && thread.branch !== null && cwd !== null
      ? vcsEnvironment.listStatus({
          environmentId: thread.environmentId,
          input: { cwd },
        })
      : null,
  );
  const linkedPullRequest = useEnvironmentQuery(
    thread.linkedPullRequest == null
      ? null
      : linkedPullRequestDetailAtom({
          environmentId: thread.environmentId,
          input: {
            projectId: thread.linkedPullRequest.projectId,
            repository: thread.linkedPullRequest.repository,
            number: thread.linkedPullRequest.number,
          },
        }),
  );

  if (thread.linkedPullRequest != null) {
    const detail = linkedPullRequest.data;
    return detail === null
      ? null
      : presentThreadPr(pullRequestDetailToVcsStatus(detail), {
          kind: detail.provider,
          name: detail.provider,
          baseUrl: "",
        });
  }

  const status = gitStatus.data;
  if (status === null || thread.branch === null || status.refName !== thread.branch) {
    return null;
  }
  if (!status.pr) {
    return null;
  }
  return presentThreadPr(status.pr, status.sourceControlProvider);
}
