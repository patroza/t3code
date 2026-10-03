import type { OrchestrationThreadActivity, TurnId } from "@t3tools/contracts";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function toolCallIdFromPayload(payload: Record<string, unknown>): string | null {
  // Match web client: payload.data.toolCallId is the stable id.
  return text(asRecord(payload.data)?.toolCallId) ?? text(payload.toolCallId);
}

function normalizeToolLabel(value: string): string {
  return value.replace(/\s+(?:complete|completed)\s*$/iu, "").trim();
}

function collapseKeyForToolActivity(activity: OrchestrationThreadActivity): string | null {
  if (activity.kind !== "tool.updated" && activity.kind !== "tool.completed") return null;
  // Plan-boundary markers are not real tools (client skips them in the work log).
  const payload = asRecord(activity.payload) ?? {};
  if (typeof payload.detail === "string" && payload.detail.startsWith("ExitPlanMode:")) {
    return null;
  }
  if (activity.tone !== "tool" && activity.tone !== "error") return null;

  const id = toolCallIdFromPayload(payload);
  if (id !== null) return `id:${id}`;

  const itemType = text(payload.itemType) ?? "";
  const title = normalizeToolLabel(
    text(payload.title) ?? activity.summary.replace(/\s+complete(?:d)?$/iu, "").trim(),
  );
  const detail = text(payload.detail) ?? "";
  if (itemType === "" && title === "" && detail === "") return null;
  // No stable id — fall back to a content key (same idea as the web work-log collapse key).
  return `meta:${itemType}\u001f${title}\u001f${detail}`;
}

export type ToolCountMessage = {
  readonly role: string;
  readonly turnId?: string | null;
  readonly streaming?: boolean;
  readonly createdAt?: string;
  readonly sequence?: number;
};

/**
 * Count distinct tool calls in the **latest in-progress work segment** for the active turn.
 *
 * - Strictly scopes to `latestTurnId` when known (does not pull older turns / null-turn noise).
 * - Collapses lifecycle updates by stable toolCallId (Set, not only consecutive).
 * - Only tools after the last **settled** (non-streaming) assistant message of that turn,
 *   so intermediate prose does not keep accumulating the whole turn’s historical tools.
 * - If there is no settled assistant yet, counts tools for the whole turn (first work batch).
 *
 * Discord only shows this count on Working — never individual tool rows.
 */
export function countTurnToolCalls(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  latestTurnId: TurnId | string | null,
  messages: ReadonlyArray<ToolCountMessage> = [],
): number {
  const turnId = latestTurnId?.trim() ?? "";

  // Start of the current in-progress segment: right after the last settled assistant
  // for this turn (so we don't keep counting tools from earlier intermediate bubbles).
  let segmentAfterCreatedAt: string | null = null;
  let segmentAfterSequence: number | null = null;
  if (turnId !== "" && messages.length > 0) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (message === undefined) continue;
      if (message.role !== "assistant") continue;
      if (message.streaming === true) continue;
      const messageTurn = message.turnId?.trim() ?? "";
      if (messageTurn !== "" && messageTurn !== turnId) continue;
      segmentAfterCreatedAt = message.createdAt ?? null;
      segmentAfterSequence =
        typeof message.sequence === "number" && Number.isFinite(message.sequence)
          ? message.sequence
          : null;
      break;
    }
  }

  const ordered = [...activities].toSorted((left, right) => {
    if (left.sequence !== undefined && right.sequence !== undefined) {
      return left.sequence - right.sequence;
    }
    return left.createdAt.localeCompare(right.createdAt);
  });

  const seen = new Set<string>();
  for (const activity of ordered) {
    // Strict turn scope: when we know the active turn, require matching turnId.
    if (turnId !== "") {
      if (activity.turnId === null || activity.turnId !== turnId) continue;
    }

    if (segmentAfterSequence !== null && activity.sequence !== undefined) {
      if (activity.sequence <= segmentAfterSequence) continue;
    } else if (segmentAfterCreatedAt !== null) {
      // Inclusive guard: tool created at the same instant as the settled assistant still
      // belongs to the prior segment if sequence is unavailable.
      if (activity.createdAt.localeCompare(segmentAfterCreatedAt) <= 0) continue;
    }

    const key = collapseKeyForToolActivity(activity);
    if (key === null) continue;
    seen.add(key);
  }
  return seen.size;
}
