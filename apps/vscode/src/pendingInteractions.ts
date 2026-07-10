import type { OrchestrationThreadActivity, UserInputQuestion } from "@t3tools/contracts";

export interface PendingApproval {
  readonly kind: "approval";
  readonly requestId: string;
  readonly requestKind: "command" | "file-read" | "file-change";
  readonly detail: string | null;
  readonly createdAt: string;
}

export interface PendingUserInput {
  readonly kind: "user-input";
  readonly requestId: string;
  readonly questions: ReadonlyArray<UserInputQuestion>;
  readonly createdAt: string;
}

export type PendingInteraction = PendingApproval | PendingUserInput;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requestKind(value: unknown): PendingApproval["requestKind"] | null {
  if (value === "command" || value === "file-read" || value === "file-change") return value;
  if (
    value === "command_execution_approval" ||
    value === "exec_command_approval" ||
    value === "dynamic_tool_call"
  )
    return "command";
  if (value === "file_read_approval") return "file-read";
  if (value === "file_change_approval" || value === "apply_patch_approval") return "file-change";
  return null;
}

function questions(value: unknown): ReadonlyArray<UserInputQuestion> | null {
  if (!Array.isArray(value)) return null;
  const parsed = value.filter((entry): entry is UserInputQuestion => {
    const question = record(entry);
    return (
      typeof question?.id === "string" &&
      typeof question.header === "string" &&
      typeof question.question === "string" &&
      Array.isArray(question.options) &&
      question.options.every((option) => {
        const value = record(option);
        return typeof value?.label === "string" && typeof value.description === "string";
      })
    );
  });
  return parsed.length === value.length && parsed.length > 0 ? parsed : null;
}

function isStaleFailure(payload: Record<string, unknown>): boolean {
  const detail = typeof payload.detail === "string" ? payload.detail.toLowerCase() : "";
  return (
    detail.includes("stale pending approval request") ||
    detail.includes("stale pending user-input request") ||
    detail.includes("unknown pending approval request") ||
    detail.includes("unknown pending user-input request")
  );
}

export function derivePendingInteractions(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<PendingInteraction> {
  const pending = new Map<string, PendingInteraction>();
  for (const activity of [...activities].toSorted((left, right) => {
    if (left.sequence !== undefined && right.sequence !== undefined)
      return left.sequence - right.sequence;
    return left.createdAt.localeCompare(right.createdAt);
  })) {
    const payload = record(activity.payload);
    if (payload === null || typeof payload.requestId !== "string") continue;
    const requestId = payload.requestId;
    if (activity.kind === "approval.requested") {
      const kind = requestKind(payload.requestKind ?? payload.requestType);
      if (kind !== null) {
        pending.set(requestId, {
          kind: "approval",
          requestId,
          requestKind: kind,
          detail: typeof payload.detail === "string" ? payload.detail : null,
          createdAt: activity.createdAt,
        });
      }
    } else if (activity.kind === "user-input.requested") {
      const parsed = questions(payload.questions);
      if (parsed !== null) {
        pending.set(requestId, {
          kind: "user-input",
          requestId,
          questions: parsed,
          createdAt: activity.createdAt,
        });
      }
    } else if (activity.kind === "approval.resolved" || activity.kind === "user-input.resolved") {
      pending.delete(requestId);
    } else if (
      (activity.kind === "provider.approval.respond.failed" ||
        activity.kind === "provider.user-input.respond.failed") &&
      isStaleFailure(payload)
    ) {
      pending.delete(requestId);
    }
  }
  return [...pending.values()].toSorted((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
}
