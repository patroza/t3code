import { assert, describe, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import {
  CommandId,
  EventId,
  OrchestrationProjectShell,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { DateTime, Deferred, Effect, Layer, PubSub, Stream } from "effect";
import { makeNTBSAdapterTag, ThreadNotFound, type NTBSAdapter } from "./adapter.ts";
import type { PlatformData } from "./lifecycle.ts";
import { makeNTBSProcessor, makeNTBSProcessorTag } from "./processor.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionTurnRepository } from "../persistence/Services/ProjectionTurns.ts";
import { ProjectSetupScriptRunner } from "../project/ProjectSetupScriptRunner.ts";
import { createAdapterRequest, createGitLayerMock } from "./test-helpers.ts";
import { some } from "effect/Option";

type TestData = PlatformData<{ messageId: string }, { responseMessageId: string }>;

const TestAdapter = makeNTBSAdapterTag<TestData>("ntbs/TestAdapter");

const createRequest = createAdapterRequest<TestData["source"], TestData["responseDestination"]>;

const makeTestAdapter = Effect.gen(function* () {
  const eventReceived = yield* Deferred.make<ThreadId>();

  const service: NTBSAdapter<TestData> = {
    save: () => Effect.void,
    postAcknowledgement: () => Effect.succeed("acknowledgement id"),
    postResponse: () => Effect.succeed("response id"),
    getRequestKey: () => "requestKey",
    findByRequest: () => Effect.succeed(null),
    findMatchingResponseMessage: () => Effect.succeed(null),
    findByThreadId: (threadId) =>
      Effect.gen(function* () {
        yield* Deferred.succeed(eventReceived, threadId);
        return yield* new ThreadNotFound();
      }),
    loadThreadsAwaitingResponse: Effect.succeed([]),
  };

  return {
    eventReceived,
    layer: Layer.succeed(TestAdapter, service),
  };
});

const TestProcessor = makeNTBSProcessorTag<TestData>("ntbs/TestProcessor");

const makeTestOrchestrationEngine = Effect.gen(function* () {
  const domainEvents = yield* PubSub.unbounded<OrchestrationEvent>();
  const commands: OrchestrationCommand[] = [];
  let sequence = 0;

  const service = OrchestrationEngineService.of({
    readEvents: () => Stream.empty,
    dispatch: (command) =>
      Effect.sync(() => {
        commands.push(command);
        return { sequence: ++sequence };
      }),
    streamDomainEvents: Stream.fromPubSub(domainEvents),
    latestSequence: Effect.sync(() => sequence),
  });

  return {
    layer: Layer.succeed(OrchestrationEngineService, service),
    commands,
    publish: (event: OrchestrationEvent) => PubSub.publish(domainEvents, event).pipe(Effect.asVoid),
  };
});

/*
processes a new request into a T3 thread, starts its first turn, persists lifecycle state, and posts an acknowledgement

  Assert that it:

  - fetches and resolves the requested base ref;
  - creates the worktree;
  - dispatches thread.create, then thread.turn.start;
  - preserves the snapshot and attachments;
  - saves thread.created with the generated thread/message IDs;
  - runs setup;
  - posts the acknowledgement;
  - does not duplicate work.
*/

/*
  The processor's direct requirements are mocked one by one with `Layer.mock`:
  a method left out simply dies if the test path reaches it, so each test only
  fills in what it actually exercises.
*/
const makeTestProcessorLive = (
  orchestrationEngine: Layer.Layer<OrchestrationEngineService>,
  adapter: Layer.Layer<NTBSAdapter<TestData>>,
) => {
  const gitLayer = createGitLayerMock();
  return {
    layer: Layer.effect(TestProcessor, makeNTBSProcessor(TestAdapter)).pipe(
      Layer.provide(adapter),
      Layer.provide(orchestrationEngine),
      Layer.provide(
        Layer.mock(ProjectionSnapshotQuery)({
          getProjectShellById: (projectId) =>
            Effect.sync(() => {
              return some(
                OrchestrationProjectShell.make({
                  createdAt: new Date().toISOString(),
                  id: projectId,
                  title: "project title",
                  workspaceRoot: "workspaceRoot",
                  defaultModelSelection: {
                    model: "gpt-does-not-exist-v2",
                    instanceId: ProviderInstanceId.make("gpt-does-not-exist-v2"),
                  },
                  updatedAt: new Date().toISOString(),
                  scripts: [],
                }),
              );
            }),
        }),
      ),
      Layer.provide(Layer.mock(ProjectionTurnRepository)({})),
      Layer.provide(gitLayer.layer),
      Layer.provide(
        Layer.mock(ProjectSetupScriptRunner)({
          runForThread: (input) =>
            Effect.sync(() => {
              return { status: "no-script" };
            }),
        }),
      ),
      // Provides Crypto (plus FileSystem/Path) for UUID generation.
      Layer.provide(NodeServices.layer),
    ),
    gitCalls: gitLayer.gitCalls,
  };
};

const createProcessor = Effect.gen(function* () {
  const testEngine = yield* makeTestOrchestrationEngine;
  const testAdapter = yield* makeTestAdapter;

  const processorLive = makeTestProcessorLive(testEngine.layer, testAdapter.layer);

  const processor = yield* TestProcessor.pipe(Effect.provide(processorLive.layer));
  return {
    processor,
    testEngine,
    testAdapter,
    gitCalls: processorLive.gitCalls,
  };
});

describe("NTBSProcessor", () => {
  it.effect("receives a T3 event", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("someThread");
      const now = DateTime.formatIso(yield* DateTime.now);

      const { processor, testEngine, testAdapter, gitCalls } = yield* createProcessor;

      // Should have done no git operations after starting
      assert.equal(gitCalls.createWorktree.length, 0);
      assert.equal(gitCalls.fetchRemote.length, 0);
      assert.equal(gitCalls.removeWorktree.length, 0);
      assert.equal(gitCalls.resolveRemoteTrackingCommit.length, 0);

      yield* processor.subscribeToT3Events.pipe(Effect.forkChild({ startImmediately: true }));

      yield* testEngine.publish({
        type: "thread.session-set",
        eventId: EventId.make("someEvent"),
        occurredAt: now,
        commandId: CommandId.make("someCommand"),
        aggregateId: threadId,
        aggregateKind: "thread",
        sequence: 0,
        causationEventId: EventId.make("someOtherEvent"),
        correlationId: null,
        metadata: {},
        payload: {
          threadId,
          session: {
            threadId,
            status: "running",
            providerName: null,
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
        },
      });

      assert.equal(yield* Deferred.await(testAdapter.eventReceived), threadId);

      const request = createRequest({
        responseDestination: {
          responseMessageId: "responseMessageId",
        },
        source: {
          messageId: "messageId",
        },
      });

      yield* processor.process(request.request, request.t3Context);

      // should have called to create a worktree
      assert.strictEqual(gitCalls.createWorktree.length, 1);
      // should have fetched a remote
      assert.strictEqual(gitCalls.fetchRemote.length, 1);
      // should have resolved the remote tracking commit
      assert.strictEqual(gitCalls.resolveRemoteTrackingCommit.length, 1);
      // no reason for removing the work tree, yet
      assert.strictEqual(gitCalls.removeWorktree.length, 0);
    }),
  );
});
