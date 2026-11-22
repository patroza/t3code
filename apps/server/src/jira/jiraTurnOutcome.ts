import {
  appendTurnResponseStatsFooter,
  formatTurnResponseStatsLine,
} from "@t3tools/shared/turnResponseStats";
import type { IntegrationThreadView as OrchestrationThread } from "@t3tools/shared/integrationThreadView";

const FAILED_RESPONSE =
  "T3 could not complete this request. Check the linked T3 thread for details.";

function assistantMessagesForTurn(
  thread: OrchestrationThread,
  turnId: string | null,
): ReadonlyArray<OrchestrationThread["messages"][number]> {
  if (turnId !== null) {
    return thread.messages.filter(
      (message) => message.role === "assistant" && message.turnId === turnId,
    );
  }
  let lastUserIndex = -1;
  for (let index = thread.messages.length - 1; index >= 0; index -= 1) {
    if (thread.messages[index]?.role === "user") {
      lastUserIndex = index;
      break;
    }
  }
  return thread.messages.slice(lastUserIndex + 1).filter((message) => message.role === "assistant");
}

// Prefer assistants from the dispatched turn; after-last-user fallback can select an unrelated later wake.
function jiraFinalAnswerText(thread: OrchestrationThread, turnId: string | null = null): string {
  const texts = assistantMessagesForTurn(thread, turnId)
    .map((message) => message.text.trimEnd())
    .filter((text) => text.trim() !== "");
  if (texts.length === 0) return "";
  if (texts.length === 1) return texts[0]!;
  const last = texts[texts.length - 1]!;
  const longest = texts.reduce((left, right) => (left.length >= right.length ? left : right));
  return longest.length >= 800 && last.length < longest.length * 0.5 ? longest : last;
}

/** Final comment body: assistant answer + small italic turn stats footer when available. */
export function jiraFinalAnswerWithStats(
  thread: OrchestrationThread,
  turnId: string | null = null,
): string {
  const answer = jiraFinalAnswerText(thread, turnId);
  if (answer.trim() === "") return "";
  return appendTurnResponseStatsFooter(
    answer,
    formatTurnResponseStatsLine({
      modelSelection: thread.modelSelection,
      activities: thread.activities,
      turnId,
      latestTurn: thread.latestTurn,
    }),
  );
}

// Recover targetTurnId from its persisted value, then the dispatched message, then the first turn after previousTurnId.
// Only use latestTurn without later history, so a later wake cannot steal an older delivery.
export function discoverJiraTargetTurnId(
  thread: OrchestrationThread,
  options: {
    readonly userMessageId: string | null;
    readonly previousTurnId: string | null;
    readonly knownTargetTurnId: string | null;
  },
): string | null {
  if (options.knownTargetTurnId !== null) return options.knownTargetTurnId;

  if (options.userMessageId !== null) {
    const userIndex = thread.messages.findIndex((message) => message.id === options.userMessageId);
    if (userIndex >= 0) {
      const linkedRun = thread.messages[userIndex]?.turnId;
      if (linkedRun != null) return linkedRun;
      for (let index = userIndex + 1; index < thread.messages.length; index += 1) {
        const message = thread.messages[index]!;
        if (message.role === "assistant" && message.turnId !== null) {
          return message.turnId;
        }
      }
    }
  }

  // Legacy deliveries and restores without userMessageId: walk message order so a
  // completed original turn is chosen before any subsequent wake-up turn.
  if (options.previousTurnId !== null) {
    let seenPrevious = false;
    let previousPresentInHistory = false;
    for (const message of thread.messages) {
      if (message.turnId === options.previousTurnId) {
        previousPresentInHistory = true;
        seenPrevious = true;
        continue;
      }
      if (!seenPrevious) continue;
      if (
        message.role === "assistant" &&
        message.turnId !== null &&
        message.turnId !== options.previousTurnId
      ) {
        return message.turnId;
      }
    }
    // Detail snapshots drop older messages. If previousTurnId is gone, every retained
    // assistant is newer — pick the earliest distinct turn (original), not latest.
    if (!previousPresentInHistory) {
      for (const message of thread.messages) {
        if (
          message.role === "assistant" &&
          message.turnId !== null &&
          message.turnId !== options.previousTurnId
        ) {
          return message.turnId;
        }
      }
    }
  }

  const latestTurnId = thread.latestTurn?.turnId ?? null;
  if (latestTurnId !== null && latestTurnId !== options.previousTurnId) {
    return latestTurnId;
  }
  return null;
}

export type JiraBridgeTurnOutcome =
  | { readonly _tag: "waiting" }
  | {
      readonly _tag: "terminal";
      readonly status: "completed" | "rejected";
      readonly body: string;
      readonly targetTurnId: string | null;
    };

/**
 * Decide whether the delivery's target turn is done without requiring latestTurn to still
 * point at that turn (session-set used to clear latest_turn_id; later turns can also move it).
 */
export function resolveJiraBridgeTurnOutcome(
  thread: OrchestrationThread,
  options: {
    readonly userMessageId: string | null;
    readonly previousTurnId: string | null;
    readonly knownTargetTurnId: string | null;
  },
): JiraBridgeTurnOutcome {
  const targetTurnId = discoverJiraTargetTurnId(thread, options);
  if (targetTurnId === null) return { _tag: "waiting" };

  const nativeRun = thread.runStatuses?.find((run) => run.id === targetTurnId);
  if (nativeRun !== undefined) {
    if (["queued", "preparing", "starting", "running", "waiting"].includes(nativeRun.status))
      return { _tag: "waiting" };
    const completed = nativeRun.status === "completed";
    return {
      _tag: "terminal",
      status: completed ? "completed" : "rejected",
      body: completed
        ? jiraFinalAnswerWithStats(thread, targetTurnId) || FAILED_RESPONSE
        : FAILED_RESPONSE,
      targetTurnId,
    };
  }
  const latest = thread.latestTurn;
  const session = thread.session;
  const assistants = assistantMessagesForTurn(thread, targetTurnId);
  const anyStreaming = assistants.some((message) => message.streaming);

  const activelyRunningThisTurn =
    anyStreaming ||
    (latest !== null && latest.turnId === targetTurnId && latest.state === "running") ||
    (session !== null &&
      session.activeTurnId === targetTurnId &&
      (session.status === "running" || session.status === "starting"));

  if (activelyRunningThisTurn) return { _tag: "waiting" };

  if (latest !== null && latest.turnId === targetTurnId) {
    if (latest.state === "running") return { _tag: "waiting" };
    if (latest.state === "completed") {
      return {
        _tag: "terminal",
        status: "completed",
        body: jiraFinalAnswerWithStats(thread, targetTurnId) || FAILED_RESPONSE,
        targetTurnId,
      };
    }
    return {
      _tag: "terminal",
      status: "rejected",
      body: FAILED_RESPONSE,
      targetTurnId,
    };
  }

  // Target turn is no longer latest (or latest_turn_id was wiped). If we already have
  // non-streaming assistants, or a checkpoint, the turn finished.
  const hasCheckpoint = thread.checkpoints.some((checkpoint) => checkpoint.turnId === targetTurnId);
  const laterTurnObserved =
    (latest !== null && latest.turnId !== targetTurnId) ||
    thread.messages.some(
      (message) =>
        message.turnId !== null &&
        message.turnId !== targetTurnId &&
        message.turnId !== options.previousTurnId &&
        assistants.length > 0,
    );

  if (assistants.length > 0 || hasCheckpoint || laterTurnObserved) {
    const body = jiraFinalAnswerWithStats(thread, targetTurnId);
    if (body.trim() !== "" || hasCheckpoint || laterTurnObserved) {
      return {
        _tag: "terminal",
        status: body.trim() !== "" ? "completed" : "rejected",
        body: body || FAILED_RESPONSE,
        targetTurnId,
      };
    }
  }

  return { _tag: "waiting" };
}
