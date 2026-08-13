import { describe, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import {
  OrchestrationProjectShell,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { Deferred, Effect, Layer, PubSub, Stream } from "effect";
import { makeNTBSAdapterTag, ThreadNotFound, type NTBSAdapter } from "./adapter.ts";
import { makeNTBSProcessor, makeNTBSProcessorTag } from "./processor.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionTurnRepository } from "../persistence/Services/ProjectionTurns.ts";
import { ProjectSetupScriptRunner } from "../project/ProjectSetupScriptRunner.ts";
import { createAdapterRequest, createGitLayerMock } from "./test-helpers.ts";
import { some } from "effect/Option";

const TestAdapter = makeNTBSAdapterTag("ntbs/TestAdapter");

const makeTestAdapter = Effect.gen(function* () {
  const eventReceived = yield* Deferred.make<ThreadId>();

  const service: NTBSAdapter = {
    save: () => Effect.void,
    postAcknowledgement: () => Effect.succeed("acknowledgement id"),
    postResponse: () => Effect.succeed("response id"),
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

const TestProcessor = makeNTBSProcessorTag("ntbs/TestProcessor");

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
  adapter: Layer.Layer<NTBSAdapter>,
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

describe("Basic happy case", () => {
  it.effect("receives a T3 event", () =>
    Effect.gen(function* () {
      const { processor } = yield* createProcessor;

      const request = createAdapterRequest("someRequestId");

      yield* processor.process(request.request, request.t3Context);
    }),
  );
});
