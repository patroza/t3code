// @effect-diagnostics nodeBuiltinImport:off
/* oxlint-disable t3code/no-manual-effect-runtime-in-tests -- Legacy regression harness uses a manually controlled runtime. */
/**
 * Regression: Grok multi-segment ACP turns must not mint duplicate assistant
 * bubbles with the same text.
 *
 * Grok emits one agent_message_chunk per status line, then tools, then the next
 * status. T3 closes the assistant segment on each tool call. The projected
 * transcript must contain each status text exactly once (not A, tools, A, B…).
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeItemId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ServerSettings,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { afterEach, describe, expect, it } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { ProviderRuntimeIngestionLive } from "./ProviderRuntimeIngestion.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProviderRuntimeIngestionService } from "../Services/ProviderRuntimeIngestion.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { assistantItemId } from "../../provider/acp/AcpSessionRuntime.ts";

const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asItemId = (value: string): RuntimeItemId => RuntimeItemId.make(value);
const asEventId = (value: string): EventId => EventId.make(value);
const asThreadId = (value: string): ThreadId => ThreadId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);

function makeTestServerSettingsLayer(overrides: Partial<ServerSettings> = {}) {
  return ServerSettingsService.layerTest(overrides);
}

function createProviderServiceHarness() {
  const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());
  const runtimeSessions: ProviderSession[] = [];
  const unsupported = () => Effect.die(new Error("Unsupported provider call in test")) as never;
  const service: ProviderServiceShape = {
    startSession: () => unsupported(),
    sendTurn: () => unsupported(),
    interruptTurn: () => unsupported(),
    respondToRequest: () => unsupported(),
    respondToUserInput: () => unsupported(),
    stopSession: () => unsupported(),
    listSessions: () => Effect.succeed([...runtimeSessions]),
    getCapabilities: () => Effect.succeed({ sessionModelSwitch: "in-session" }),
    getInstanceInfo: (instanceId) => {
      const driverKind = ProviderDriverKind.make(String(instanceId));
      return Effect.succeed({
        instanceId,
        driverKind,
        displayName: undefined,
        enabled: true,
        continuationIdentity: {
          driverKind,
          continuationKey: `${driverKind}:instance:${instanceId}`,
        },
      });
    },
    rollbackConversation: () => unsupported(),
    get streamEvents() {
      return Stream.fromPubSub(runtimeEventPubSub);
    },
  };

  const setSession = (session: ProviderSession): void => {
    const existingIndex = runtimeSessions.findIndex((entry) => entry.threadId === session.threadId);
    if (existingIndex >= 0) {
      runtimeSessions[existingIndex] = session;
      return;
    }
    runtimeSessions.push(session);
  };

  return {
    service,
    setSession,
    emit: (event: ProviderRuntimeEvent): void => {
      Effect.runSync(PubSub.publish(runtimeEventPubSub, event));
    },
  };
}

type TestThread = {
  readonly id: ThreadId;
  readonly messages: ReadonlyArray<{
    readonly id: string;
    readonly role: string;
    readonly text: string;
    readonly turnId: string | null;
    readonly streaming: boolean;
  }>;
  readonly session?: { readonly status?: string; readonly activeTurnId?: string | null } | null;
};

async function waitForThread(
  readModel: () => Promise<{ threads: ReadonlyArray<TestThread> }>,
  predicate: (thread: TestThread) => boolean,
  timeoutMs = 3000,
  threadId: ThreadId = asThreadId("thread-1"),
): Promise<TestThread> {
  const deadline = (await Effect.runPromise(Clock.currentTimeMillis)) + timeoutMs;
  const poll = async (): Promise<TestThread> => {
    const snapshot = await readModel();
    const thread = snapshot.threads.find((entry) => entry.id === threadId);
    if (thread && predicate(thread)) {
      return thread;
    }
    if ((await Effect.runPromise(Clock.currentTimeMillis)) >= deadline) {
      const latest = snapshot.threads.find((entry) => entry.id === threadId);
      throw new Error(
        `Timed out waiting for thread state. messages=${JSON.stringify(latest?.messages ?? [], null, 2)}`,
      );
    }
    await Effect.runPromise(Effect.yieldNow);
    return poll();
  };
  return poll();
}

/**
 * Emit the runtime-event shape GrokAdapter produces for one assistant segment
 * (item.started → content.delta → item.completed) using AcpSessionRuntime item ids.
 */
function emitGrokAssistantSegment(input: {
  readonly emit: (event: ProviderRuntimeEvent) => void;
  readonly turnId: TurnId;
  readonly sessionId: string;
  readonly runId: string;
  readonly segmentIndex: number;
  readonly text: string;
  readonly createdAt: string;
  readonly eventPrefix: string;
  readonly streaming: boolean;
}) {
  const itemId = assistantItemId(input.sessionId, input.runId, input.segmentIndex);
  const provider = ProviderDriverKind.make("grok");
  const threadId = asThreadId("thread-1");

  input.emit({
    type: "item.started",
    eventId: asEventId(`${input.eventPrefix}-started`),
    provider,
    createdAt: input.createdAt,
    threadId,
    turnId: input.turnId,
    itemId: asItemId(itemId),
    payload: {
      itemType: "assistant_message",
      status: "inProgress",
    },
  });
  input.emit({
    type: "content.delta",
    eventId: asEventId(`${input.eventPrefix}-delta`),
    provider,
    createdAt: input.createdAt,
    threadId,
    turnId: input.turnId,
    itemId: asItemId(itemId),
    payload: {
      streamKind: "assistant_text",
      delta: input.text,
    },
  });
  input.emit({
    type: "item.completed",
    eventId: asEventId(`${input.eventPrefix}-completed`),
    provider,
    createdAt: input.createdAt,
    threadId,
    turnId: input.turnId,
    itemId: asItemId(itemId),
    payload: {
      itemType: "assistant_message",
      status: "completed",
    },
  });
  void input.streaming;
}

function emitGrokTool(input: {
  readonly emit: (event: ProviderRuntimeEvent) => void;
  readonly turnId: TurnId;
  readonly toolCallId: string;
  readonly title: string;
  readonly createdAt: string;
  readonly eventPrefix: string;
}) {
  const provider = ProviderDriverKind.make("grok");
  const threadId = asThreadId("thread-1");
  const itemId = asItemId(input.toolCallId);

  input.emit({
    type: "item.updated",
    eventId: asEventId(`${input.eventPrefix}-updated`),
    provider,
    createdAt: input.createdAt,
    threadId,
    turnId: input.turnId,
    itemId,
    payload: {
      itemType: "command_execution",
      status: "inProgress",
      title: input.title,
      detail: input.title,
    },
  });
  input.emit({
    type: "item.completed",
    eventId: asEventId(`${input.eventPrefix}-completed`),
    provider,
    createdAt: input.createdAt,
    threadId,
    turnId: input.turnId,
    itemId,
    payload: {
      itemType: "command_execution",
      status: "completed",
      title: input.title,
      detail: input.title,
    },
  });
}

describe("ProviderRuntimeIngestion Grok multi-segment assistant bubbles", () => {
  let runtime: ManagedRuntime.ManagedRuntime<
    OrchestrationEngineService | ProviderRuntimeIngestionService | ProjectionSnapshotQuery,
    unknown
  > | null = null;
  let scope: Scope.Closeable | null = null;
  const tempDirs: string[] = [];

  function makeTempDir(prefix: string): string {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    if (scope) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    scope = null;
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
    for (const dir of tempDirs.splice(0)) {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });

  async function createHarness(options?: { serverSettings?: Partial<ServerSettings> }) {
    const workspaceRoot = makeTempDir("t3-grok-segments-");
    NodeFS.mkdirSync(NodePath.join(workspaceRoot, ".git"));
    const provider = createProviderServiceHarness();
    const orchestrationLayer = OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(RepositoryIdentityResolver.layer),
      Layer.provide(SqlitePersistenceMemory),
    );
    const projectionSnapshotLayer = OrchestrationProjectionSnapshotQueryLive.pipe(
      Layer.provide(RepositoryIdentityResolver.layer),
      Layer.provide(SqlitePersistenceMemory),
    );
    const layer = ProviderRuntimeIngestionLive.pipe(
      Layer.provideMerge(orchestrationLayer),
      Layer.provideMerge(projectionSnapshotLayer),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(Layer.succeed(ProviderService, provider.service)),
      Layer.provideMerge(makeTestServerSettingsLayer(options?.serverSettings)),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(NodeServices.layer),
    );
    runtime = ManagedRuntime.make(layer);
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const snapshotQuery = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
    const ingestion = await runtime.runPromise(Effect.service(ProviderRuntimeIngestionService));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(ingestion.start().pipe(Scope.provide(scope)));

    const createdAt = "2026-07-21T00:00:00.000Z";
    await Effect.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-grok-segments-project"),
        projectId: asProjectId("project-1"),
        title: "Grok Segments",
        workspaceRoot,
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("grok"),
          model: "grok-build",
        },
        createdAt,
      }),
    );
    await Effect.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-grok-segments-thread"),
        threadId: ThreadId.make("thread-1"),
        projectId: asProjectId("project-1"),
        title: "Thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("grok"),
          model: "grok-build",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await Effect.runPromise(
      engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-grok-segments-session"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "grok",
          runtimeMode: "full-access",
          activeTurnId: null,
          updatedAt: createdAt,
          lastError: null,
        },
        createdAt,
      }),
    );
    provider.setSession({
      provider: ProviderDriverKind.make("grok"),
      status: "ready",
      runtimeMode: "full-access",
      threadId: ThreadId.make("thread-1"),
      createdAt,
      updatedAt: createdAt,
    });

    return {
      emit: provider.emit,
      drain: () => Effect.runPromise(ingestion.drain),
      readModel: () => Effect.runPromise(snapshotQuery.getSnapshot()),
      engine,
    };
  }

  async function runGrokStatusSandwichTurn(options: { readonly streaming: boolean }) {
    const harness = await createHarness({
      serverSettings: { enableAssistantStreaming: options.streaming },
    });
    const turnId = asTurnId("turn-grok-sandwich");
    const sessionId = "019f8373-fa8d-7982-a0d7-caf8b866b523";
    const runId = "run-1";
    const provider = ProviderDriverKind.make("grok");
    const threadId = asThreadId("thread-1");

    const statuses = [
      "Aligning Bauhaus with Standard: skip label creation when nothing is still initial, so packed-order reprint goes straight to print.",
      "Validation passed. Booting an isolated Mako stack and running the pack-reprint e2e.",
      "E2E green. Committing, rebasing onto main, and opening the PR.",
    ] as const;

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-grok-sandwich"),
      provider,
      createdAt: "2026-07-21T00:00:00.000Z",
      threadId,
      turnId,
      payload: {},
    });
    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" && thread.session?.activeTurnId === String(turnId),
    );

    // Simulate Grok: status → tools → status → tools → status → tools
    for (let index = 0; index < statuses.length; index += 1) {
      const text = statuses[index]!;
      const at = `2026-07-21T00:0${index}:00.000Z`;
      emitGrokAssistantSegment({
        emit: harness.emit,
        turnId,
        sessionId,
        runId,
        segmentIndex: index,
        text,
        createdAt: at,
        eventPrefix: `evt-seg-${index}`,
        streaming: options.streaming,
      });
      emitGrokTool({
        emit: harness.emit,
        turnId,
        toolCallId: `tool-${index}`,
        title: `command ${index}`,
        createdAt: `2026-07-21T00:0${index}:30.000Z`,
        eventPrefix: `evt-tool-${index}`,
      });
    }

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-grok-sandwich"),
      provider,
      createdAt: "2026-07-21T00:10:00.000Z",
      threadId,
      turnId,
      payload: { state: "completed" },
    });

    await harness.drain();

    const thread = await waitForThread(harness.readModel, (entry) => {
      const assistants = entry.messages.filter((message) => message.role === "assistant");
      return (
        assistants.length >= statuses.length &&
        assistants.every((message) => !message.streaming) &&
        statuses.every((status) => assistants.some((message) => message.text === status))
      );
    });

    const assistantTexts = thread.messages
      .filter((message) => message.role === "assistant")
      .map((message) => message.text);

    return { assistantTexts, messages: thread.messages };
  }

  it("projects each Grok status line once in buffered mode (no A/tool/A sandwich)", async () => {
    const { assistantTexts } = await runGrokStatusSandwichTurn({ streaming: false });

    expect(assistantTexts).toEqual([
      "Aligning Bauhaus with Standard: skip label creation when nothing is still initial, so packed-order reprint goes straight to print.",
      "Validation passed. Booting an isolated Mako stack and running the pack-reprint e2e.",
      "E2E green. Committing, rebasing onto main, and opening the PR.",
    ]);
    // Explicit uniqueness guard — the UI bug is consecutive identical bubbles.
    expect(new Set(assistantTexts).size).toBe(assistantTexts.length);
  });

  it("projects each Grok status line once in streaming mode (no A/tool/A sandwich)", async () => {
    const { assistantTexts } = await runGrokStatusSandwichTurn({ streaming: true });

    expect(assistantTexts).toEqual([
      "Aligning Bauhaus with Standard: skip label creation when nothing is still initial, so packed-order reprint goes straight to print.",
      "Validation passed. Booting an isolated Mako stack and running the pack-reprint e2e.",
      "E2E green. Committing, rebasing onto main, and opening the PR.",
    ]);
    expect(new Set(assistantTexts).size).toBe(assistantTexts.length);
  });

  it("does not re-mint the same status when assistant item.completed uses Acp item ids", async () => {
    // Grok AcpSessionRuntime item ids already start with `assistant:…`. Ingestion
    // must not create a second message row from the completion fallback id path.
    const harness = await createHarness({
      serverSettings: { enableAssistantStreaming: true },
    });
    const turnId = asTurnId("turn-id-prefix");
    const sessionId = "sess-1";
    const runId = "run-1";
    const itemId = assistantItemId(sessionId, runId, 0);
    const provider = ProviderDriverKind.make("grok");
    const threadId = asThreadId("thread-1");
    const text = "status once only";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-id-prefix"),
      provider,
      createdAt: "2026-07-21T00:00:00.000Z",
      threadId,
      turnId,
      payload: {},
    });

    // Stream without item.started first (content.delta alone), then complete with
    // the same Acp item id — matches live GrokAdapter ordering in some paths.
    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-delta-id-prefix"),
      provider,
      createdAt: "2026-07-21T00:00:01.000Z",
      threadId,
      turnId,
      itemId: asItemId(itemId),
      payload: { streamKind: "assistant_text", delta: text },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-complete-id-prefix"),
      provider,
      createdAt: "2026-07-21T00:00:02.000Z",
      threadId,
      turnId,
      itemId: asItemId(itemId),
      payload: { itemType: "assistant_message", status: "completed" },
    });
    // Second completion with active already cleared — must not mint a twin.
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-complete-id-prefix-again"),
      provider,
      createdAt: "2026-07-21T00:00:03.000Z",
      threadId,
      turnId,
      itemId: asItemId(itemId),
      payload: { itemType: "assistant_message", status: "completed" },
    });
    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-id-prefix"),
      provider,
      createdAt: "2026-07-21T00:00:04.000Z",
      threadId,
      turnId,
      payload: { state: "completed" },
    });

    await harness.drain();

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.messages.some((message) => message.role === "assistant" && message.text === text),
    );
    const assistants = thread.messages.filter((message) => message.role === "assistant");
    expect(assistants.map((message) => message.text)).toEqual([text]);
    // ACP item ids already start with `assistant:` — do not double-prefix.
    const ids = assistants.map((message) => message.id);
    expect(ids).toHaveLength(1);
    expect(ids[0]).toBe(MessageId.make(itemId));
  });

  it("drops a buffered assistant segment that repeats the previous status text", async () => {
    const harness = await createHarness({
      serverSettings: { enableAssistantStreaming: false },
    });
    const turnId = asTurnId("turn-dup-status");
    const sessionId = "sess-dup";
    const runId = "run-dup";
    const provider = ProviderDriverKind.make("grok");
    const threadId = asThreadId("thread-1");
    const status =
      "Aligning Bauhaus with Standard: skip label creation when nothing is still initial.";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-dup-status"),
      provider,
      createdAt: "2026-07-21T00:00:00.000Z",
      threadId,
      turnId,
      payload: {},
    });
    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" && thread.session?.activeTurnId === String(turnId),
    );

    // First status
    emitGrokAssistantSegment({
      emit: harness.emit,
      turnId,
      sessionId,
      runId,
      segmentIndex: 0,
      text: status,
      createdAt: "2026-07-21T00:00:01.000Z",
      eventPrefix: "evt-dup-a",
      streaming: false,
    });
    emitGrokTool({
      emit: harness.emit,
      turnId,
      toolCallId: "tool-dup-1",
      title: "validate",
      createdAt: "2026-07-21T00:00:02.000Z",
      eventPrefix: "evt-dup-tool",
    });
    // Twin status (same text, new segment) — must not project a second bubble.
    emitGrokAssistantSegment({
      emit: harness.emit,
      turnId,
      sessionId,
      runId,
      segmentIndex: 1,
      text: status,
      createdAt: "2026-07-21T00:00:03.000Z",
      eventPrefix: "evt-dup-b",
      streaming: false,
    });
    emitGrokAssistantSegment({
      emit: harness.emit,
      turnId,
      sessionId,
      runId,
      segmentIndex: 2,
      text: "Validation passed. Booting e2e.",
      createdAt: "2026-07-21T00:00:04.000Z",
      eventPrefix: "evt-dup-c",
      streaming: false,
    });
    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-dup-status"),
      provider,
      createdAt: "2026-07-21T00:00:05.000Z",
      threadId,
      turnId,
      payload: { state: "completed" },
    });
    await harness.drain();

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.messages.some(
        (message) => message.role === "assistant" && message.text.includes("Validation passed"),
      ),
    );
    const assistantTexts = thread.messages
      .filter((message) => message.role === "assistant")
      .map((message) => message.text);
    expect(assistantTexts).toEqual([status, "Validation passed. Booting e2e."]);
  });
});
