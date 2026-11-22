import {
  type MessageId,
  type OrchestrationV2ThreadProjection,
  OrchestrationV2ShellSnapshot,
  OrchestrationV2ThreadDetailSnapshot,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
export const decodeShellSnapshotText = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.toCodecJson(OrchestrationV2ShellSnapshot)),
);
export const decodeThreadSnapshotText = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.toCodecJson(OrchestrationV2ThreadDetailSnapshot)),
);
export function queuedRunForMessage(
  projection: OrchestrationV2ThreadProjection | null,
  messageId: MessageId,
) {
  const run = projection?.runs.find(
    (run) => run.userMessageId === messageId && run.status === "queued",
  );
  if (!run) throw new Error("Queued message no longer exists.");
  return run;
}
export function activeConversationRun(projection: OrchestrationV2ThreadProjection | null) {
  const run = projection?.runs.find((run) =>
    ["preparing", "starting", "running", "waiting"].includes(run.status),
  );
  if (!run) throw new Error("No active run.");
  return run;
}
export function queuedConversationMessages(projection: OrchestrationV2ThreadProjection | null) {
  return (projection?.runs ?? [])
    .filter((run) => run.status === "queued")
    .toSorted((a, b) => (a.queuePosition ?? a.ordinal) - (b.queuePosition ?? b.ordinal))
    .flatMap((run) => {
      const message = projection?.messages.find((message) => message.id === run.userMessageId);
      return message
        ? [
            {
              messageId: message.id,
              text: message.text,
              attachments: message.attachments,
              queuedAt: DateTime.formatIso(run.requestedAt),
              source: message.source,
            },
          ]
        : [];
    });
}
export function steeringCapabilitiesAllowPromotion(
  turns:
    | {
        readonly supportsActiveSteering: boolean;
        readonly supportsInterrupt: boolean;
        readonly supportsSteeringByInterruptRestart: boolean;
      }
    | undefined,
) {
  return (
    turns?.supportsActiveSteering === true ||
    (turns?.supportsInterrupt === true && turns.supportsSteeringByInterruptRestart)
  );
}
export function canPromoteQueuedConversation(projection: OrchestrationV2ThreadProjection | null) {
  const run = projection?.runs.find((run) => run.status === "running" || run.status === "waiting");
  const providerThread = projection?.providerThreads.find(
    (thread) => thread.id === run?.providerThreadId,
  );
  const session = projection?.providerSessions.find(
    (session) => session.id === providerThread?.providerSessionId,
  );
  return run !== undefined && steeringCapabilitiesAllowPromotion(session?.capabilities.turns);
}

export function hasPendingConversationStart(projection: OrchestrationV2ThreadProjection | null) {
  return (
    projection?.runs.some((run) => run.status === "preparing" || run.status === "starting") ?? false
  );
}
