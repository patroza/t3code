import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

import { useEnvironmentQuery } from "./query";
import { presentThreadPr, type ThreadPrPresentation } from "./thread-pr-presentation";
import { vcsEnvironment } from "./vcs";

export {
  presentThreadPr,
  type ThreadPr,
  type ThreadPrPresentation,
} from "./thread-pr-presentation";

/**
 * List-mode PR status for a thread's branch (no remote poller). Deduped per
 * (environmentId, cwd); use full `vcsEnvironment.status` only for active git chrome.
 */
export function useThreadPr(
  thread: EnvironmentThreadShell,
  projectCwd: string | null,
): ThreadPrPresentation | null {
  const cwd = thread.worktreePath ?? projectCwd;
  const gitStatus = useEnvironmentQuery(
    thread.branch !== null && cwd !== null
      ? vcsEnvironment.listStatus({
          environmentId: thread.environmentId,
          input: { cwd },
        })
      : null,
  );

  const status = gitStatus.data;
  if (status === null || thread.branch === null || status.refName !== thread.branch) {
    return null;
  }
  if (!status.pr) {
    return null;
  }
  return presentThreadPr(status.pr, status.sourceControlProvider);
}
