import {
  ChatAttachment,
  EventId,
  MessageId,
  ModelSelection,
  OrchestrationV2Notification,
  ProjectId,
  ThreadId,
  TurnId,
  ProviderInstanceId,
  RuntimeMode,
  ProviderInteractionMode,
  SourceRef,
  ThreadParticipantSummary,
  ThreadPullRequestLink,
  ThreadLinkedPullRequest,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

// External-platform renderers consume a compact presentation view. Runs remain
// owned by V2; this view never dispatches, stores, or drains queued work.
export const IntegrationMessage = Schema.Struct({
  id: MessageId,
  role: Schema.Literals(["user", "assistant", "system"]),
  text: Schema.String,
  attachments: Schema.optional(Schema.Array(ChatAttachment)),
  turnId: Schema.NullOr(TurnId),
  streaming: Schema.Boolean,
  source: Schema.optional(SourceRef),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  // v2 keeps the wake prompt on the user message and the visible fact here.
  // Discord reads these so it can show the summary without echoing the prompt.
  createdBy: Schema.optional(Schema.String),
  creationSource: Schema.optional(Schema.String),
  notification: Schema.optional(OrchestrationV2Notification),
  delegatedCompletion: Schema.optional(Schema.Unknown),
});
export const IntegrationActivity = Schema.Struct({
  id: EventId,
  tone: Schema.Literals(["info", "tool", "approval", "error"]),
  kind: Schema.String,
  summary: Schema.String,
  payload: Schema.Unknown,
  turnId: Schema.NullOr(TurnId),
  sequence: Schema.optional(Schema.Number),
  createdAt: Schema.String,
});
export const IntegrationLatestTurn = Schema.Struct({
  turnId: TurnId,
  state: Schema.Literals(["running", "interrupted", "completed", "error"]),
  requestedAt: Schema.String,
  startedAt: Schema.NullOr(Schema.String),
  completedAt: Schema.NullOr(Schema.String),
  assistantMessageId: Schema.NullOr(MessageId),
});
export const IntegrationSession = Schema.Struct({
  threadId: ThreadId,
  status: Schema.Literals(["starting", "running", "ready", "waiting", "stopped", "error"]),
  providerName: Schema.NullOr(Schema.String),
  providerInstanceId: Schema.optional(ProviderInstanceId),
  runtimeMode: RuntimeMode,
  activeTurnId: Schema.NullOr(TurnId),
  lastError: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
});
export const IntegrationThreadView = Schema.Struct({
  id: ThreadId,
  projectId: ProjectId,
  title: Schema.String,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  linkedPullRequest: Schema.optional(Schema.NullOr(ThreadLinkedPullRequest)),
  pullRequests: Schema.Array(ThreadPullRequestLink),
  branchPullRequest: Schema.optional(Schema.NullOr(ThreadLinkedPullRequest)),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  archivedAt: Schema.NullOr(Schema.String),
  deletedAt: Schema.NullOr(Schema.String),
  settledOverride: Schema.NullOr(Schema.Literals(["settled", "active"])),
  settledAt: Schema.NullOr(Schema.String),
  unsettledAt: Schema.optional(Schema.NullOr(Schema.String)),
  snoozedUntil: Schema.optional(Schema.NullOr(Schema.String)),
  pinnedAt: Schema.optional(Schema.NullOr(Schema.String)),
  activeOrderKey: Schema.optional(Schema.NullOr(Schema.String)),
  autoSettleDisabledAt: Schema.optional(Schema.NullOr(Schema.String)),
  runStatuses: Schema.optional(
    Schema.Array(
      Schema.Struct({ id: Schema.String, status: Schema.String, userMessageId: MessageId }),
    ),
  ),
  hasPendingApprovals: Schema.optional(Schema.Boolean),
  hasPendingUserInput: Schema.optional(Schema.Boolean),
  latestTurn: Schema.NullOr(IntegrationLatestTurn),
  messages: Schema.Array(IntegrationMessage),
  activities: Schema.Array(IntegrationActivity),
  session: Schema.NullOr(IntegrationSession),
  proposedPlans: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      turnId: Schema.NullOr(TurnId),
      text: Schema.String,
      createdAt: Schema.String,
      updatedAt: Schema.String,
      implementedAt: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
  checkpoints: Schema.Array(
    Schema.Struct({
      turnId: TurnId,
      checkpointTurnCount: Schema.Number,
      checkpointRef: Schema.String,
      status: Schema.String,
      files: Schema.Array(
        Schema.Struct({
          path: Schema.String,
          kind: Schema.String,
          additions: Schema.Number,
          deletions: Schema.Number,
        }),
      ),
      assistantMessageId: Schema.NullOr(MessageId),
      completedAt: Schema.String,
    }),
  ),
  originSource: Schema.optional(Schema.NullOr(SourceRef)),
  participantSummaries: Schema.optional(Schema.Array(ThreadParticipantSummary)),
});
export type IntegrationThreadView = typeof IntegrationThreadView.Type;
export type IntegrationMessage = typeof IntegrationMessage.Type;
export type IntegrationActivity = typeof IntegrationActivity.Type;
export type IntegrationLatestTurn = typeof IntegrationLatestTurn.Type;
export type IntegrationSession = typeof IntegrationSession.Type;
export type IntegrationThreadShellView = Omit<
  IntegrationThreadView,
  "messages" | "activities" | "proposedPlans" | "checkpoints"
>;
const iso = (value: DateTime.Utc | null | undefined) =>
  value == null ? null : DateTime.formatIso(value);
const active = (status: string) => ["preparing", "starting", "running", "waiting"].includes(status);

export function integrationThreadShellView(
  shell: OrchestrationV2ThreadShell,
): IntegrationThreadShellView {
  const latestTurn =
    shell.latestRunId === null || shell.status === "queued"
      ? null
      : {
          turnId: TurnId.make(shell.latestRunId),
          state: active(shell.status)
            ? ("running" as const)
            : shell.status === "completed"
              ? ("completed" as const)
              : shell.status === "failed"
                ? ("error" as const)
                : ("interrupted" as const),
          requestedAt: iso(shell.latestRunRequestedAt) ?? iso(shell.updatedAt)!,
          startedAt: iso(shell.latestRunStartedAt),
          completedAt: iso(shell.latestRunCompletedAt),
          assistantMessageId: null,
        };
  return {
    ...shell,
    createdAt: iso(shell.createdAt)!,
    updatedAt: iso(shell.updatedAt)!,
    archivedAt: iso(shell.archivedAt),
    deletedAt: iso(shell.deletedAt),
    settledAt: iso(shell.settledAt),
    unsettledAt: iso(shell.unsettledAt),
    snoozedUntil: iso(shell.snoozedUntil),
    pinnedAt: iso(shell.pinnedAt),
    autoSettleDisabledAt: iso(shell.autoSettleDisabledAt),
    hasPendingApprovals:
      shell.pendingRuntimeRequest !== null && shell.pendingRuntimeRequest.kind !== "user_input",
    hasPendingUserInput: shell.pendingRuntimeRequest?.kind === "user_input",
    settledOverride: shell.settledOverride ?? null,
    pullRequests: shell.pullRequests ?? [],
    latestTurn,
    session:
      shell.activeRunId === null
        ? null
        : {
            threadId: shell.id,
            status:
              shell.status === "preparing" || shell.status === "starting" ? "starting" : "running",
            providerName: null,
            providerInstanceId: shell.providerInstanceId,
            runtimeMode: shell.runtimeMode,
            activeTurnId: TurnId.make(shell.activeRunId),
            lastError: shell.lastError ?? null,
            updatedAt: iso(shell.updatedAt)!,
          },
  };
}

export function integrationThreadView(
  projection: OrchestrationV2ThreadProjection,
): IntegrationThreadView {
  const { thread } = projection;
  // Queued runs do not own an active response; their result is discovered by
  // the durable user-message/run link rather than arrival order of assistants.
  const run = projection.runs
    .filter((r) => r.status !== "queued")
    .sort((a, b) => b.ordinal - a.ordinal)[0];
  const latestTurn =
    run === undefined
      ? null
      : {
          turnId: TurnId.make(run.id),
          state: active(run.status)
            ? ("running" as const)
            : run.status === "completed"
              ? ("completed" as const)
              : run.status === "failed"
                ? ("error" as const)
                : ("interrupted" as const),
          requestedAt: iso(run.requestedAt)!,
          startedAt: iso(run.startedAt),
          completedAt: iso(run.completedAt),
          assistantMessageId:
            projection.messages.findLast((m) => m.runId === run.id && m.role === "assistant")?.id ??
            null,
        };
  const provider = [...projection.providerSessions].sort(
    (a, b) => DateTime.toEpochMillis(b.updatedAt) - DateTime.toEpochMillis(a.updatedAt),
  )[0];
  const activities: IntegrationActivity[] = projection.turnItems
    .filter((item) => item.type !== "user_message" && item.type !== "assistant_message")
    .map((item): IntegrationActivity => {
      // The wake prompt stays a user message. This row is the fact the user sees.
      if (item.type === "notification") {
        return {
          id: EventId.make(item.id),
          tone: item.outcome === "failed" ? "error" : "info",
          kind: "notification",
          summary: item.summary,
          payload: {
            ...item,
            itemId: item.id,
            itemType: item.type,
            source: item.source,
            outcome: item.outcome,
          },
          turnId: item.runId === null ? null : TurnId.make(item.runId),
          sequence: item.ordinal,
          createdAt: iso(item.startedAt ?? item.updatedAt)!,
        };
      }
      return {
        id: EventId.make(item.id),
        tone:
          item.type === "error"
            ? "error"
            : item.type === "user_input_request"
              ? "approval"
              : "tool",
        kind:
          item.type === "todo_list"
            ? "turn.plan.updated"
            : item.type === "user_input_request"
              ? "user-input.requested"
              : item.status === "completed"
                ? "tool.completed"
                : "tool.updated",
        summary: item.title ?? item.type,
        payload: {
          ...item,
          itemId: item.id,
          toolCallId: item.id,
          itemType: item.type,
          title: item.title ?? item.type,
          detail:
            item.type === "command_execution"
              ? item.input
              : item.type === "file_change"
                ? item.fileName
                : item.type === "reasoning"
                  ? item.text
                  : undefined,
          steps: item.type === "todo_list" ? item.steps : undefined,
          requestId: item.type === "user_input_request" ? item.requestId : undefined,
        },
        turnId: item.runId === null ? null : TurnId.make(item.runId),
        sequence: item.ordinal,
        createdAt: iso(item.startedAt ?? item.updatedAt)!,
      };
    });
  for (const request of projection.runtimeRequests) {
    const node = projection.nodes.find((n) => n.id === request.nodeId);
    const item = projection.turnItems.find(
      (item) => item.type === "user_input_request" && item.requestId === request.id,
    );
    const userInput = request.kind === "user_input";
    activities.push({
      id: EventId.make(request.id),
      tone: "approval",
      kind: userInput ? "user-input.requested" : "approval.requested",
      summary: userInput ? "Agent needs an answer" : "Agent needs approval",
      payload: {
        requestId: request.id,
        requestKind: request.kind,
        questions: item?.type === "user_input_request" ? item.questions : undefined,
      },
      turnId: node?.runId ? TurnId.make(node.runId) : null,
      createdAt: iso(request.createdAt)!,
    });
    if (request.status !== "pending")
      activities.push({
        id: EventId.make(request.id + ":resolved"),
        tone: "approval",
        kind: userInput ? "user-input.resolved" : "approval.resolved",
        summary: "Request closed",
        payload: { requestId: request.id },
        turnId: node?.runId ? TurnId.make(node.runId) : null,
        createdAt: iso(request.resolvedAt ?? request.createdAt)!,
      });
  }
  for (const turn of projection.providerTurns) {
    if (!turn.turnTokenUsage) continue;
    const attempt = projection.attempts.find((a) => a.id === turn.runAttemptId);
    const r = projection.runs.find((r) => r.id === attempt?.runId);
    activities.push({
      id: EventId.make(turn.id),
      tone: "info",
      kind: "context-window.updated",
      summary: "Turn token usage",
      payload: { ...turn.tokenUsage, ...turn.turnTokenUsage },
      turnId: r ? TurnId.make(r.id) : null,
      createdAt: iso(turn.completedAt ?? turn.startedAt ?? projection.updatedAt)!,
    });
  }
  return {
    ...thread,
    pullRequests: thread.pullRequests ?? [],
    createdAt: iso(thread.createdAt)!,
    updatedAt: iso(thread.updatedAt)!,
    archivedAt: iso(thread.archivedAt),
    deletedAt: iso(thread.deletedAt),
    settledAt: iso(thread.settledAt),
    unsettledAt: iso(thread.unsettledAt),
    snoozedUntil: iso(thread.snoozedUntil),
    pinnedAt: iso(thread.pinnedAt),
    autoSettleDisabledAt: iso(thread.autoSettleDisabledAt),
    settledOverride: thread.settledOverride ?? null,
    hasPendingApprovals: projection.runtimeRequests.some(
      (r) => r.status === "pending" && r.kind !== "user_input",
    ),
    hasPendingUserInput: projection.runtimeRequests.some(
      (r) => r.status === "pending" && r.kind === "user_input",
    ),
    runStatuses: projection.runs.map((r) => ({
      id: r.id,
      status: r.status,
      userMessageId: r.userMessageId,
    })),
    latestTurn,
    session: !provider
      ? null
      : {
          threadId: thread.id,
          status: provider.status,
          providerName: provider.driver,
          providerInstanceId: provider.providerInstanceId,
          runtimeMode: thread.runtimeMode,
          activeTurnId: run && active(run.status) ? TurnId.make(run.id) : null,
          lastError: provider.lastError,
          updatedAt: iso(provider.updatedAt)!,
        },
    messages: projection.messages.map((m) => ({
      ...m,
      turnId: m.runId === null ? null : TurnId.make(m.runId),
      createdAt: iso(m.createdAt)!,
      updatedAt: iso(m.updatedAt)!,
    })),
    activities,
    proposedPlans: projection.plans
      .filter((p) => p.kind === "proposed_plan")
      .map((p) => ({
        id: p.id,
        turnId: p.runId === null ? null : TurnId.make(p.runId),
        text: p.markdown,
        createdAt: iso(projection.updatedAt)!,
        updatedAt: iso(projection.updatedAt)!,
        implementedAt: p.status === "completed" ? iso(projection.updatedAt) : null,
      })),
    checkpoints: projection.checkpoints
      .filter((c) => c.runId !== null)
      .map((c) => ({
        turnId: TurnId.make(c.runId!),
        checkpointTurnCount: c.appRunOrdinal ?? c.ordinalWithinScope,
        checkpointRef: c.ref,
        status: c.status,
        files: c.files,
        assistantMessageId: null,
        completedAt: iso(c.capturedAt)!,
      })),
  };
}
