import { assert, describe, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { Effect, Layer, Stream } from "effect";
import { makeNTBSAdapterTag, ThreadNotFound } from "./adapter.ts";
import type { PlatformData } from "./lifecycle.ts";
import { makeNTBSProcessor, makeNTBSProcessorTag } from "./processor.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionTurnRepository } from "../persistence/Services/ProjectionTurns.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { ProjectSetupScriptRunner } from "../project/ProjectSetupScriptRunner.ts";

type TestData = PlatformData<{ messageId: string }, { responseMessageId: string }>;

const TestAdapter = makeNTBSAdapterTag<TestData>("ntbs/TestAdapter");

const TestAdapterLive = Layer.succeed(TestAdapter, {
  save: () => Effect.void,
  postAcknowledgement: () => Effect.succeed("acknowledgement id"),
  postResponse: () => Effect.succeed("response id"),
  getRequestKey: () => "requestKey",
  findByRequest: () => Effect.succeed(null),
  findMatchingResponseMessage: () => Effect.succeed(null),
  findByThreadId: () => new ThreadNotFound(),
  loadThreadsAwaitingResponse: Effect.succeed([]),
});

const TestProcessor = makeNTBSProcessorTag<TestData>("ntbs/TestProcessor");

/*
  The processor's direct requirements are mocked one by one with `Layer.mock`:
  a method left out simply dies if the test path reaches it, so each test only
  fills in what it actually exercises.
*/
const TestProcessorLive = Layer.effect(TestProcessor, makeNTBSProcessor(TestAdapter)).pipe(
  Layer.provide(TestAdapterLive),
  Layer.provide(
    Layer.mock(OrchestrationEngineService)({
      streamDomainEvents: Stream.empty,
    }),
  ),
  Layer.provide(Layer.mock(ProjectionSnapshotQuery)({})),
  Layer.provide(Layer.mock(ProjectionTurnRepository)({})),
  Layer.provide(Layer.mock(GitWorkflowService)({})),
  Layer.provide(Layer.mock(ProjectSetupScriptRunner)({})),
  // Provides Crypto (plus FileSystem/Path) for UUID generation.
  Layer.provide(NodeServices.layer),
);

describe("NTBSProcessor", () => {
  it.effect("builds with mocked dependencies", () =>
    Effect.gen(function* () {
      const processor = yield* TestProcessor;

      assert.isDefined(processor.process);
      assert.isDefined(processor.subscribeToT3Events);
    }).pipe(Effect.provide(TestProcessorLive)),
  );
});
