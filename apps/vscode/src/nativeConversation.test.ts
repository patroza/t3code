// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import { expect, it } from "vite-plus/test";
import {
  MessageId,
  OrchestrationV2ThreadProjection,
  OrchestrationV2ShellSnapshot,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import {
  activeConversationRun,
  canPromoteQueuedConversation,
  steeringCapabilitiesAllowPromotion,
  decodeShellSnapshotText,
  decodeThreadSnapshotText,
  queuedConversationMessages,
  queuedRunForMessage,
} from "./nativeConversation.ts";
const at = DateTime.makeUnsafe("2026-10-03T00:00:00Z");
const modelSelection = { instanceId: "codex", model: "gpt-5.4" };
const decodeProjection = Schema.decodeUnknownSync(OrchestrationV2ThreadProjection);
const projection = decodeProjection({
  thread: {
    id: "thread",
    projectId: "project",
    title: "Queued work",
    providerInstanceId: "codex",
    modelSelection,
    runtimeMode: "auto",
    interactionMode: "default",
    createdBy: "user",
    creationSource: "server",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: "thread", parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
    deletedAt: null,
  },
  runs: [
    { id: "active", userMessageId: "active-message", ordinal: 1, status: "running" },
    {
      id: "queue-a",
      userMessageId: "message-a",
      ordinal: 2,
      status: "queued",
      queuePosition: 2,
      queueHeld: true,
    },
    { id: "queue-b", userMessageId: "message-b", ordinal: 3, status: "queued", queuePosition: 1 },
  ].map((run) => ({
    ...run,
    threadId: "thread",
    providerInstanceId: "codex",
    modelSelection,
    providerThreadId: null,
    rootNodeId: null,
    activeAttemptId: null,
    requestedAt: at,
    startedAt: null,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  })),
  messages: ["a", "b"].map((suffix) => ({
    id: `message-${suffix}`,
    threadId: "thread",
    runId: `queue-${suffix}`,
    nodeId: null,
    role: "user",
    text: suffix,
    source: { channel: "vscode" },
    attachments: [],
    streaming: false,
    createdBy: "user",
    creationSource: "server",
    createdAt: at,
    updatedAt: at,
  })),
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
  updatedAt: at,
});
const encodeDetail = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.toCodecJson(
      Schema.Struct({
        snapshotSequence: Schema.Number,
        projection: OrchestrationV2ThreadProjection,
      }),
    ),
  ),
);
const encodeShell = Schema.encodeSync(
  Schema.fromJsonString(Schema.toCodecJson(OrchestrationV2ShellSnapshot)),
);
it("renders held native queues in server order with sender attribution", () => {
  expect(
    queuedConversationMessages(projection).map((message) => [
      message.messageId,
      message.source?.channel,
    ]),
  ).toEqual([
    ["message-b", "vscode"],
    ["message-a", "vscode"],
  ]);
  expect(queuedRunForMessage(projection, MessageId.make("message-a"))).toMatchObject({
    id: "queue-a",
    queueHeld: true,
  });
  expect(activeConversationRun(projection).id).toBe("active");
});
it("rejects stale queue actions instead of targeting a running message", () => {
  expect(() => queuedRunForMessage(projection, MessageId.make("active-message"))).toThrow(
    "Queued message no longer exists",
  );
  expect(() =>
    activeConversationRun({
      ...projection,
      runs: projection.runs.filter((run) => run.status === "queued"),
    }),
  ).toThrow("No active run");
});
it("loads native HTTP codecs into projections with native timestamps and queued runs", () => {
  const text = encodeDetail({ snapshotSequence: 4, projection });
  const result = decodeThreadSnapshotText(text);
  expect(DateTime.formatIso(result.projection.thread.createdAt)).toBe(DateTime.formatIso(at));
  expect(queuedConversationMessages(result.projection)).toEqual(
    queuedConversationMessages(projection),
  );
  const shellText = encodeShell({
    schemaVersion: 2,
    snapshotSequence: 4,
    threads: [],
    archivedThreads: [],
    projects: [],
  });
  expect(decodeShellSnapshotText(shellText).snapshotSequence).toBe(4);
});

it("offers promotion for native steering and interrupt restart providers", () => {
  expect(
    steeringCapabilitiesAllowPromotion({
      supportsActiveSteering: true,
      supportsInterrupt: false,
      supportsSteeringByInterruptRestart: false,
    }),
  ).toBe(true);
  expect(
    steeringCapabilitiesAllowPromotion({
      supportsActiveSteering: false,
      supportsInterrupt: true,
      supportsSteeringByInterruptRestart: true,
    }),
  ).toBe(true);
  expect(
    steeringCapabilitiesAllowPromotion({
      supportsActiveSteering: false,
      supportsInterrupt: false,
      supportsSteeringByInterruptRestart: true,
    }),
  ).toBe(false);
  expect(canPromoteQueuedConversation(projection)).toBe(false);
});
it("retains VS Code queued work controls and the held queue resume surface", () => {
  const source = NodeFS.readFileSync(new URL("./webview.ts", import.meta.url), "utf8");
  expect(source).toContain('requiredElement<HTMLElement>("queued-messages")');
  expect(source).toContain('resume.textContent = "Resume queued messages"');
  expect(source).toContain('steer.textContent = "Send now"');
});
