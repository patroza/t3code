import type { OrchestrationThreadActivity } from "@t3tools/contracts";

export interface PresentedResolvedUserInput {
  readonly activityId: string;
  readonly createdAt: string;
  readonly answers: ReadonlyArray<{
    readonly header: string;
    readonly question: string;
    readonly answer: string;
  }>;
}

export function presentResolvedUserInputs(
  _activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<PresentedResolvedUserInput> {
  // Stub for dumbed-down upstream contribution; advanced user-input transcripts
  // are a newer feature not required for the initial VS Code extension.
  return [];
}
