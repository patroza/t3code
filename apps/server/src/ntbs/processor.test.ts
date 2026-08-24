import { describe, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import {
  OrchestrationProjectShell,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { DateTime, Deferred, Effect, Layer, PubSub, Stream } from "effect";
import { makeNTBSAdapterTag, ThreadNotFound, type NTBSAdapter } from "./adapter.ts";
import { makeNTBSProcessor, makeNTBSProcessorTag } from "./t3gateway.ts";
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
    acknowledge: () => Effect.succeed("acknowledgement id"),
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

  TODO: Add a recovery-path test for a stored thread with no matching projected
  turn; recovery should start the original turn and monitor it.
*/

/*
  TODO: Test processor-owned exchange serialization thoroughly.

  `process` first checks the repository and only then plans and persists a new
  `RequestClaimed`. Without serialization, two concurrent deliveries carrying
  the same `sourceUri` can both observe a missing exchange, mint different T3
  coordinates, and provision competing threads. Repository uniqueness alone
  does not make that read-then-write sequence atomic.

  The processor should therefore serialize all work for one `sourceUri` while
  allowing unrelated exchanges to run concurrently. A duplicate must wait for
  the current caller and then perform the repository lookup again. It must not
  merely be dropped: if the first caller fails before persisting its claim, the
  waiting caller must get an opportunity to claim the request.

  Cover at least these cases using `Deferred` gates rather than sleeps:

  - Two simultaneous successful deliveries with the same `sourceUri`: block
    the first during planning or persistence, start the second, and prove that
    only one plan, claim, thread, turn, and acknowledgement are produced. Once
    the first finishes, the second must re-read the repository and return as a
    no-op.
  - The first same-source caller fails before `RequestClaimed` is persisted:
    the queued caller must acquire the lock afterward, observe no exchange,
    and successfully claim and advance it.
  - The first caller fails after persisting `RequestClaimed`: the queued caller
    must observe the durable claim and return without planning new coordinates
    or trying to repair the exchange.
  - Different `sourceUri`s: block one request and prove that another request can
    still plan and advance. The lock must be keyed, not global.
  - Cancellation or interruption while holding the lock: the permit must be
    released and the next caller must proceed.
  - Cancellation or interruption while waiting for the lock: caller tracking
    must be cleaned up without deleting a lock still used by another caller.
  - Lock cleanup after the last caller exits, on both success and failure. The
    lock map must not retain every `sourceUri` seen during the server lifetime.
  - A platform redelivery racing with startup recovery or T3 thread activity:
    every entry point must use the same source-keyed lock so stale state cannot
    overwrite a newer transition and provisioning, turn start, or reply posting
    cannot happen twice.

  Assert observable behavior rather than internal lock implementation wherever
  possible. Count gateway, adapter, and repository calls; capture the exact T3
  coordinates and persisted states; and prove queued fibers are still blocked
  by polling their completion before releasing each `Deferred` gate.
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
            Effect.gen(function* () {
              const now = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
              return some(
                OrchestrationProjectShell.make({
                  createdAt: now,
                  id: projectId,
                  title: "project title",
                  workspaceRoot: "workspaceRoot",
                  defaultModelSelection: {
                    model: "gpt-does-not-exist-v2",
                    instanceId: ProviderInstanceId.make("gpt-does-not-exist-v2"),
                  },
                  updatedAt: now,
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
          runForThread: (_) =>
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
