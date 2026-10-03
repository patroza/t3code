import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

const v2Now = DateTime.makeUnsafe("2026-06-20T00:00:00.000Z");
const v2ProjectId = ProjectId.make("project-v2");
const v2ThreadId = ThreadId.make("thread-v2");
const v2ProviderInstanceId = ProviderInstanceId.make("codex");

const v2ThreadShell: OrchestrationV2ThreadShell = {
  id: v2ThreadId,
  projectId: v2ProjectId,
  title: "Thread",
  providerInstanceId: v2ProviderInstanceId,
  modelSelection: { instanceId: v2ProviderInstanceId, model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { rootThreadId: v2ThreadId, parentThreadId: null, relationshipToParent: null },
  forkedFrom: null,
  createdBy: "user",
  creationSource: "web",
  latestRunId: null,
  activeRunId: null,
  status: "idle",
  pendingRuntimeRequest: null,
  latestVisibleMessage: null,
  latestUserMessageAt: null,
  hasActionableProposedPlan: false,
  itemCount: 0,
  visibleItemCount: 0,
  createdAt: v2Now,
  updatedAt: v2Now,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
};

const v2Projection: OrchestrationV2ThreadProjection = {
  thread: {
    id: v2ThreadShell.id,
    projectId: v2ThreadShell.projectId,
    title: v2ThreadShell.title,
    providerInstanceId: v2ThreadShell.providerInstanceId,
    modelSelection: v2ThreadShell.modelSelection,
    runtimeMode: v2ThreadShell.runtimeMode,
    interactionMode: v2ThreadShell.interactionMode,
    branch: v2ThreadShell.branch,
    worktreePath: v2ThreadShell.worktreePath,
    activeProviderThreadId: v2ThreadShell.activeProviderThreadId,
    lineage: v2ThreadShell.lineage,
    forkedFrom: v2ThreadShell.forkedFrom,
    createdBy: v2ThreadShell.createdBy,
    creationSource: v2ThreadShell.creationSource,
    createdAt: v2Now,
    updatedAt: v2Now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  },
  runs: [],
  attempts: [],
  nodes: [],
  subagents: [],
  providerSessions: [],
  providerThreads: [],
  providerTurns: [],
  runtimeRequests: [],
  messages: [],
  plans: [],
  turnItems: [],
  checkpointScopes: [],
  checkpoints: [],
  contextHandoffs: [],
  contextTransfers: [],
  visibleTurnItems: [],
  updatedAt: v2Now,
};

import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  OrchestrationV2ConversationMessage,
  OrchestrationV2Run,
  OrchestrationV2RunAttempt,
  OrchestrationV2ProviderTurn,
  OrchestrationV2RuntimeRequest,
  SourceRef,
  ThreadParticipantSummary,
} from "@t3tools/contracts";
import { integrationThreadView, integrationThreadShellView } from "./integrationThreadView.ts";
const decodeMessage = Schema.decodeUnknownSync(OrchestrationV2ConversationMessage);
const decodeRun = Schema.decodeUnknownSync(OrchestrationV2Run);
const decodeAttempt = Schema.decodeUnknownSync(OrchestrationV2RunAttempt);
const decodeTurn = Schema.decodeUnknownSync(OrchestrationV2ProviderTurn);
const decodeRequest = Schema.decodeUnknownSync(OrchestrationV2RuntimeRequest);
const decodeSource = Schema.decodeUnknownSync(SourceRef);
const decodeParticipants = Schema.decodeUnknownSync(Schema.Array(ThreadParticipantSummary));
function run(id: string, ordinal: number, status: "queued" | "running" | "completed") {
  return decodeRun({
    id,
    threadId: v2ThreadId,
    ordinal,
    providerInstanceId: "codex",
    modelSelection: v2ThreadShell.modelSelection,
    providerThreadId: null,
    userMessageId: "message:" + id,
    rootNodeId: null,
    activeAttemptId: null,
    status,
    requestedAt: v2Now,
    startedAt: status === "queued" ? null : v2Now,
    completedAt: status === "completed" ? v2Now : null,
    checkpointId: null,
    contextHandoffId: null,
  });
}
describe("integrationThreadView", () => {
  it("keeps queued runs addressable without inventing an active response", () => {
    const queued = run("run:queued", 2, "queued");
    expect(integrationThreadView({ ...v2Projection, runs: [queued] }).latestTurn).toBeNull();
    const active = run("run:active", 1, "running");
    const view = integrationThreadView({ ...v2Projection, runs: [active, queued] });
    expect(view.latestTurn?.turnId).toBe(active.id);
    expect(view.latestTurn?.state).toBe("running");
    expect(view.runStatuses).toEqual([
      { id: active.id, status: "running", userMessageId: active.userMessageId },
      { id: queued.id, status: "queued", userMessageId: queued.userMessageId },
    ]);
    expect(
      integrationThreadShellView({ ...v2ThreadShell, status: "queued", latestRunId: queued.id })
        .latestTurn,
    ).toBeNull();
  });
  it("retains identity and source metadata in full and shell views", () => {
    const originSource = decodeSource({
      channel: "discord",
      personId: "person-1",
      username: "alice",
    });
    const participantSummaries = decodeParticipants([
      {
        personId: "person-1",
        username: "alice",
        channels: ["discord"],
        firstParticipatedAt: "2026-06-20T00:00:00.000Z",
      },
    ]);
    const thread = { ...v2Projection.thread, originSource, participantSummaries };
    const message = decodeMessage({
      id: "message:source",
      threadId: v2ThreadId,
      runId: null,
      nodeId: null,
      createdBy: "user",
      creationSource: "server",
      role: "user",
      text: "Mention",
      attachments: [],
      streaming: false,
      source: originSource,
      createdAt: v2Now,
      updatedAt: v2Now,
    });
    const full = integrationThreadView({ ...v2Projection, thread, messages: [message] });
    expect(full.messages[0]?.source).toEqual(originSource);
    const shell = integrationThreadShellView({
      ...v2ThreadShell,
      originSource,
      participantSummaries,
    });
    for (const view of [full, shell]) {
      expect(view.originSource).toEqual(originSource);
      expect(view.participantSummaries).toEqual(participantSummaries);
    }
  });
  it("closes resolved runtime requests while keeping unresolved requests actionable", () => {
    const pending = decodeRequest({
      id: "request:pending",
      nodeId: "node:1",
      providerTurnId: null,
      nativeRequestRef: null,
      kind: "user_input",
      status: "pending",
      responseCapability: { type: "message" },
      createdAt: v2Now,
      resolvedAt: null,
    });
    const resolved = decodeRequest({
      ...pending,
      id: "request:resolved",
      status: "resolved",
      resolvedAt: v2Now,
      kind: "command",
    });
    const view = integrationThreadView({ ...v2Projection, runtimeRequests: [pending, resolved] });
    expect(view.hasPendingUserInput).toBe(true);
    expect(view.hasPendingApprovals).toBe(false);
    expect(view.activities.map((a) => [a.id, a.kind])).toEqual([
      [pending.id, "user-input.requested"],
      [resolved.id, "approval.requested"],
      [resolved.id + ":resolved", "approval.resolved"],
    ]);
  });
  it("links turn usage to its own run and preserves main-agent totals", () => {
    const first = run("run:first", 1, "completed");
    const second = run("run:second", 2, "running");
    const attempt = decodeAttempt({
      id: "attempt:1",
      runId: first.id,
      attemptOrdinal: 1,
      rootNodeId: "node:1",
      providerInstanceId: "codex",
      providerThreadId: "provider-thread:1",
      providerTurnId: null,
      reason: "initial",
      status: "completed",
      startedAt: v2Now,
      completedAt: v2Now,
    });
    const turn = decodeTurn({
      id: "provider-turn:1",
      providerThreadId: "provider-thread:1",
      nodeId: "node:1",
      runAttemptId: attempt.id,
      nativeTurnRef: null,
      ordinal: 1,
      status: "completed",
      startedAt: v2Now,
      completedAt: v2Now,
      turnTokenUsage: {
        usageScope: "main_agent",
        usageStatus: "complete",
        hasSubagents: false,
        inputTokens: 10,
        outputTokens: 4,
      },
      tokenUsage: {
        usedTokens: 1000,
        inputTokens: 900,
        outputTokens: 100,
        updatedAt: "2026-06-20T00:00:00.000Z",
      },
    });
    const view = integrationThreadView({
      ...v2Projection,
      runs: [first, second],
      attempts: [attempt],
      providerTurns: [turn],
    });
    const activity = view.activities.find((a) => a.kind === "context-window.updated");
    expect(activity?.turnId).toBe(first.id);
    expect(activity?.payload).toMatchObject({ inputTokens: 10, outputTokens: 4, usedTokens: 1000 });
  });
});
