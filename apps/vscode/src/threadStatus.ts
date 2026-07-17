import type { OrchestrationLatestTurnState, OrchestrationSessionStatus } from "@t3tools/contracts";
import { shouldShowPlanReadyStatus } from "@t3tools/shared/proposedPlan";

export type ThreadDisplayStatusKind =
  | "working"
  | "completed"
  | "needs-wake-up"
  | "connecting"
  | "needs-attention"
  | "plan-ready"
  | "error"
  | "ready";

export interface ThreadDisplayStatus {
  readonly kind: ThreadDisplayStatusKind;
  readonly label: string;
}

export interface ThreadStatusSource {
  readonly latestTurn: null | { readonly state: OrchestrationLatestTurnState };
  readonly session: null | { readonly status: OrchestrationSessionStatus };
  readonly hasPendingApprovals?: boolean;
  readonly hasPendingUserInput?: boolean;
  readonly interactionMode?: string | null;
  readonly hasActionableProposedPlan?: boolean;
}

export function resolveThreadDisplayStatus(source: ThreadStatusSource): ThreadDisplayStatus {
  if (source.hasPendingApprovals || source.hasPendingUserInput) {
    return { kind: "needs-attention", label: "Needs attention" };
  }
  if (
    shouldShowPlanReadyStatus({
      interactionMode: source.interactionMode,
      hasPendingUserInput: Boolean(source.hasPendingUserInput),
      hasActionableProposedPlan: Boolean(source.hasActionableProposedPlan),
    })
  ) {
    return { kind: "plan-ready", label: "Plan Ready" };
  }
  if (source.session?.status === "interrupted" || source.latestTurn?.state === "interrupted") {
    return { kind: "needs-wake-up", label: "Needs wake up" };
  }
  if (source.session?.status === "starting") {
    return { kind: "connecting", label: "Connecting" };
  }
  if (source.session?.status === "running" || source.latestTurn?.state === "running") {
    return { kind: "working", label: "Working" };
  }
  if (source.session?.status === "error" || source.latestTurn?.state === "error") {
    return { kind: "error", label: "Error" };
  }
  if (source.latestTurn?.state === "completed") {
    return { kind: "completed", label: "Completed" };
  }
  return { kind: "ready", label: "Ready" };
}
