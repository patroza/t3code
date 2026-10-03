import { expect, it } from "@effect/vitest";
import { DateTime, Effect, Layer, Schema, Stream } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { OrchestrationV2ServerCommand } from "@t3tools/contracts";
import {
  MessageId,
  ModelSelection,
  OrchestrationV2ThreadProjection,
  ProjectId,
  ThreadId,
  type OrchestrationV2RunStatus,
} from "@t3tools/contracts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { ProjectStoreV2 } from "../orchestration-v2/ProjectStore.ts";
import { v2PullRequestThread } from "../orchestration-v2/testkit/pullRequestFixtures.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { ProjectSetupScriptRunner } from "../project/ProjectSetupScriptRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import { makeRequestAccepted, toThreadCreated, toWorkPlanned } from "./exchange.ts";
import { T3Gateway, t3GatewayLive } from "./t3gateway.ts";

const now = "2026-01-01T00:00:00.000Z";
const timestamp = DateTime.makeUnsafe(now);
const threadId = ThreadId.make("ntbs-thread");
const projectId = ProjectId.make("ntbs-project");
const messageId = MessageId.make("ntbs-message");
const modelSelection = Schema.decodeUnknownSync(ModelSelection)({
  instanceId: "codex",
  model: "gpt-5.4",
});
const threadData = {
  id: threadId,
  projectId,
  title: "External request",
  modelSelection,
  runtimeMode: "auto" as const,
  interactionMode: "default" as const,
  branch: null,
  worktreePath: null,
  pullRequests: [],
  latestUserMessageAt: null,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
};
const shell = v2PullRequestThread(threadData);
// Decode fixtures through the production wire schemas, including durable run/message links.
const decodeProjection = Schema.decodeUnknownSync(OrchestrationV2ThreadProjection);
const projection = (status?: OrchestrationV2RunStatus) =>
  decodeProjection({
    thread: {
      ...threadData,
      createdAt: timestamp,
      updatedAt: timestamp,
      providerInstanceId: "codex",
      createdBy: "user",
      creationSource: "server",
      activeProviderThreadId: null,
      lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
      forkedFrom: null,
      deletedAt: null,
    },
    runs:
      status === undefined
        ? []
        : [
            {
              id: "ntbs-run",
              threadId,
              ordinal: 1,
              providerInstanceId: "codex",
              modelSelection,
              providerThreadId: null,
              userMessageId: messageId,
              rootNodeId: null,
              activeAttemptId: null,
              status,
              requestedAt: timestamp,
              startedAt: null,
              completedAt: status === "completed" ? timestamp : null,
              checkpointId: null,
              contextHandoffId: null,
            },
          ],
    messages: [
      {
        id: "reply",
        threadId,
        runId: "ntbs-run",
        nodeId: null,
        role: "assistant",
        text: "The requested change is ready.",
        attachments: [],
        streaming: false,
        createdBy: "agent",
        creationSource: "provider",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      {
        id: "unrelated",
        threadId,
        runId: "different-run",
        nodeId: null,
        role: "assistant",
        text: "Unrelated answer",
        attachments: [],
        streaming: false,
        createdBy: "agent",
        creationSource: "provider",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    attempts: [],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runtimeRequests: [],
    plans: [],
    turnItems: [],
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems: [],
    updatedAt: timestamp,
  });
const exchange = toThreadCreated(
  toWorkPlanned(
    makeRequestAccepted(
      { attachments: [], snapshot: "Please fix this", sourceUri: "discord://thread/123" },
      { projectId, startBranchName: "main" },
      1,
    ),
    {
      projectId,
      startBranchName: "main",
      startCommitSha: "abc",
      threadId,
      userMessageId: messageId,
      worktreeBranchName: "ntbs/work",
    },
    1,
  ),
  1,
);
const fixture = (status?: OrchestrationV2RunStatus, missing = false) => {
  const commands: OrchestrationV2ServerCommand[] = [];
  const layer = t3GatewayLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagementService, {
          getThreadShell: () => Effect.succeed(missing ? null : shell),
          getThreadProjection: () => Effect.succeed(projection(status)),
          dispatch: (command) =>
            Effect.sync(() => {
              commands.push(command);
              return { sequence: 1, storedEvents: [] };
            }),
          streamDomainEvents: Stream.empty,
        }),
        Layer.mock(ProjectStoreV2, {}),
        Layer.mock(GitWorkflowService, {}),
        Layer.mock(ProjectSetupScriptRunner, {}),
        NodeServices.layer,
        ServerSettings.layerTest({}),
      ),
    ),
  );
  return { commands, layer };
};
it.effect(
  "queues integration requests through native intake with stable retry identity and source",
  () => {
    const { commands, layer } = fixture();
    return Effect.gen(function* () {
      const gateway = yield* T3Gateway;
      yield* gateway.startTurn(exchange);
      yield* gateway.startTurn(exchange);
      expect(commands).toHaveLength(2);
      expect(commands[0]).toEqual(commands[1]);
      expect(commands[0]).toMatchObject({
        type: "message.dispatch",
        commandId: "ntbs:message:ntbs-message",
        messageId,
        dispatchMode: { type: "queue_after_active" },
        source: { channel: "discord" },
      });
    }).pipe(Effect.provide(layer));
  },
);
it.effect.each(["queued", "preparing", "starting", "running", "waiting"] as const)(
  "treats native %s runs as active without redispatch",
  (status) =>
    Effect.gen(function* () {
      const gateway = yield* T3Gateway;
      expect(yield* gateway.getTurnStatus(exchange)).toEqual({ turn: "active" });
    }).pipe(Effect.provide(fixture(status).layer)),
);
it.effect("matches a terminal run to its original message and excludes unrelated answers", () =>
  Effect.gen(function* () {
    const gateway = yield* T3Gateway;
    expect(yield* gateway.getTurnStatus(exchange)).toMatchObject({
      turn: "completed",
      reply: {
        type: "answer",
        text: "The requested change is ready.",
        turnId: "ntbs-run",
        userMessageId: messageId,
      },
    });
  }).pipe(Effect.provide(fixture("completed").layer)),
);
it.effect.each(["interrupted", "cancelled"] as const)(
  "delivers native %s as cancellation",
  (status) =>
    Effect.gen(function* () {
      const gateway = yield* T3Gateway;
      expect(yield* gateway.getTurnStatus(exchange)).toMatchObject({
        turn: "completed",
        reply: { type: "cancellation" },
      });
    }).pipe(Effect.provide(fixture(status).layer)),
);
it.effect("starts only when no durable run exists", () =>
  Effect.gen(function* () {
    const gateway = yield* T3Gateway;
    expect(yield* gateway.getTurnStatus(exchange)).toEqual({ turn: "missing" });
  }).pipe(Effect.provide(fixture().layer)),
);
it.effect("delivers missing threads as settled failures", () =>
  Effect.gen(function* () {
    const gateway = yield* T3Gateway;
    expect(yield* gateway.getTurnStatus(exchange)).toMatchObject({
      turn: "completed",
      reply: { type: "failure" },
    });
  }).pipe(Effect.provide(fixture(undefined, true).layer)),
);
