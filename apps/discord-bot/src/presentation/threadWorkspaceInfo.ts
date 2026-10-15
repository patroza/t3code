import { ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE } from "@t3tools/contracts";
import type { IntegrationThreadView } from "@t3tools/shared/integrationThreadView";

/** A missing path during preparation is not evidence that the thread runs locally. */
export function threadWorkspaceInfo(thread: IntegrationThreadView) {
  const preparing = thread.latestTurn?.runStatus === "preparing";
  const failed =
    !preparing &&
    thread.activities.some((activity) => {
      if (activity.turnId !== thread.latestTurn?.turnId) return false;
      const payload = activity.payload;
      if (typeof payload !== "object" || payload === null || !("failure" in payload)) return false;
      const failure = payload.failure;
      return (
        "status" in payload &&
        payload.status === "failed" &&
        typeof failure === "object" &&
        failure !== null &&
        "code" in failure &&
        failure.code === ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE
      );
    });
  const workspaceStatus: "preparing" | "failed" | undefined = preparing
    ? "preparing"
    : failed
      ? "failed"
      : undefined;
  return {
    worktreePath: thread.worktreePath,
    local: workspaceStatus === undefined && thread.worktreePath === null,
    workspaceStatus,
  };
}
