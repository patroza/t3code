import { assert, describe, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import {
  CommandId,
  EventId,
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
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { ProjectSetupScriptRunner } from "../project/ProjectSetupScriptRunner.ts";

type TestData = PlatformData<{ messageId: string }, { responseMessageId: string }>;

const TestAdapter = makeNTBSAdapterTag<TestData>("ntbs/TestAdapter");

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
  The processor's direct requirements are mocked one by one with `Layer.mock`:
  a method left out simply dies if the test path reaches it, so each test only
  fills in what it actually exercises.
*/
const makeTestProcessorLive = (
  orchestrationEngine: Layer.Layer<OrchestrationEngineService>,
  adapter: Layer.Layer<NTBSAdapter<TestData>>,
) =>
  Layer.effect(TestProcessor, makeNTBSProcessor(TestAdapter)).pipe(
    Layer.provide(adapter),
    Layer.provide(orchestrationEngine),
    Layer.provide(Layer.mock(ProjectionSnapshotQuery)({})),
    Layer.provide(Layer.mock(ProjectionTurnRepository)({})),
    Layer.provide(Layer.mock(GitWorkflowService)({})),
    Layer.provide(Layer.mock(ProjectSetupScriptRunner)({})),
    // Provides Crypto (plus FileSystem/Path) for UUID generation.
    Layer.provide(NodeServices.layer),
  );

describe("NTBSProcessor", () => {
  it.effect("receives a T3 event", () =>
    Effect.gen(function* () {
      const testEngine = yield* makeTestOrchestrationEngine;
      const testAdapter = yield* makeTestAdapter;
      const processor = yield* TestProcessor.pipe(
        Effect.provide(makeTestProcessorLive(testEngine.layer, testAdapter.layer)),
      );
      const threadId = ThreadId.make("someThread");
      const now = DateTime.formatIso(yield* DateTime.now);

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
    }),
  );
});
