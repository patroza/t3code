import { assert, describe, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { Context, DateTime, Effect, Layer, PubSub, Queue, Stream } from "effect";
import {
  makeNTBSAdapterTag,
  ThreadNotFound,
  type NTBSAdapter,
  type NTBSResponse,
} from "./adapter.ts";
import type { NTBSInput, NTBSLifecycle, ThreadCreated } from "./lifecycle.ts";
import { makeNTBSProcessor, makeNTBSProcessorTag } from "./processor.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionTurnRepository } from "../persistence/Services/ProjectionTurns.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { ProjectSetupScriptRunner } from "../project/ProjectSetupScriptRunner.ts";

/*
  Harness layout:

  The fakes' observable state lives in dedicated context services (TestEngine,
  TestAdapterState). The real service tags (OrchestrationEngineService, the
  adapter) get thin layers derived from that state. `Layer.provideMerge` keeps
  the state services visible to the tests, so a test pulls its handles from
  context instead of building fakes inline and closing over them.

  Everything is provided per test with `Effect.provide(Harness)`: the processor
  holds internal mutable state (dedup keys, outcome locks, monitor baselines),
  so a shared `layer(...)` block would leak state across tests.
*/

class TestEngine extends Context.Service<
  TestEngine,
  {
    /** Every command the processor dispatched, in order. */
    readonly commands: Array<OrchestrationCommand>;
    /** Emits a domain event as if the orchestration engine produced it. */
    readonly publish: (event: OrchestrationEvent) => Effect.Effect<void>;
    readonly domainEvents: PubSub.PubSub<OrchestrationEvent>;
  }
>()("test/ntbs/TestEngine") {
  static readonly layer = Layer.effect(
    TestEngine,
    Effect.gen(function* () {
      const domainEvents = yield* PubSub.unbounded<OrchestrationEvent>();
      return {
        commands: [],
        domainEvents,
        publish: (event: OrchestrationEvent) =>
          PubSub.publish(domainEvents, event).pipe(Effect.asVoid),
      };
    }),
  );
}

const OrchestrationEngineFromTestEngine = Layer.effect(
  OrchestrationEngineService,
  Effect.gen(function* () {
    const engine = yield* TestEngine;
    let sequence = 0;

    return OrchestrationEngineService.of({
      readEvents: () => Stream.empty,
      dispatch: (command) =>
        Effect.sync(() => {
          engine.commands.push(command);
          return { sequence: ++sequence };
        }),
      streamDomainEvents: Stream.fromPubSub(engine.domainEvents),
      latestSequence: Effect.sync(() => sequence),
    });
  }),
);

class TestAdapterState extends Context.Service<
  TestAdapterState,
  {
    /** Lifecycle records keyed by T3 thread — seed before acting, inspect after. */
    readonly records: Map<ThreadId, NTBSLifecycle>;
    readonly postedAcks: Array<ThreadCreated>;
    readonly postedResponses: Array<{
      readonly record: ThreadCreated;
      readonly response: NTBSResponse;
    }>;
    /** One entry per findByThreadId call; taking from it awaits event delivery. */
    readonly threadLookups: Queue.Queue<ThreadId>;
  }
>()("test/ntbs/TestAdapterState") {
  static readonly layer = Layer.effect(
    TestAdapterState,
    Effect.gen(function* () {
      return {
        records: new Map<ThreadId, NTBSLifecycle>(),
        postedAcks: [],
        postedResponses: [],
        threadLookups: yield* Queue.unbounded<ThreadId>(),
      };
    }),
  );
}

const TestAdapter = makeNTBSAdapterTag("ntbs/TestAdapter");

const AdapterFromState = Layer.effect(
  TestAdapter,
  Effect.gen(function* () {
    const state = yield* TestAdapterState;

    const adapter: NTBSAdapter = {
      save: (lifecycleEvent) =>
        Effect.sync(() => {
          state.records.set(lifecycleEvent.t3Data.threadId, lifecycleEvent);
        }),
      postAcknowledgement: (record) =>
        Effect.sync(() => {
          state.postedAcks.push(record);
          return `ack-${state.postedAcks.length}`;
        }),
      postResponse: (record, response) =>
        Effect.sync(() => {
          state.postedResponses.push({ record, response });
          return `response-${state.postedResponses.length}`;
        }),
      findByRequest: (request) =>
        Effect.sync(
          () =>
            [...state.records.values()].find((record) => record.sourceUri === request.sourceUri) ??
            null,
        ),
      findMatchingResponseMessage: () => Effect.succeed(null),
      findByThreadId: (threadId) =>
        Queue.offer(state.threadLookups, threadId).pipe(
          Effect.flatMap(() => {
            const record = state.records.get(threadId);
            return record === undefined
              ? Effect.fail(new ThreadNotFound())
              : Effect.succeed(record);
          }),
        ),
      loadThreadsAwaitingResponse: Effect.sync(() =>
        [...state.records.values()].filter(
          (record): record is ThreadCreated => record.state === "thread.created",
        ),
      ),
    };

    return adapter;
  }),
);

const TestProcessor = makeNTBSProcessorTag("ntbs/TestProcessor");

const Harness = Layer.effect(TestProcessor, makeNTBSProcessor(TestAdapter)).pipe(
  Layer.provide(AdapterFromState),
  Layer.provide(OrchestrationEngineFromTestEngine),
  Layer.provideMerge(TestAdapterState.layer),
  Layer.provideMerge(TestEngine.layer),
  Layer.provide(Layer.mock(ProjectionSnapshotQuery)({})),
  Layer.provide(Layer.mock(ProjectionTurnRepository)({})),
  Layer.provide(Layer.mock(GitWorkflowService)({})),
  Layer.provide(Layer.mock(ProjectSetupScriptRunner)({})),
  // Provides Crypto (plus FileSystem/Path) for UUID generation.
  Layer.provide(NodeServices.layer),
);

const sessionSetEvent = (threadId: ThreadId): Effect.Effect<OrchestrationEvent> =>
  Effect.map(DateTime.now, (nowDateTime) => {
    const now = DateTime.formatIso(nowDateTime);
    return {
      type: "thread.session-set",
      eventId: EventId.make(`event-for-${threadId}`),
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
    };
  });

const makeRequest = (platformMessageId: string): NTBSInput => ({
  sourceUri: platformMessageId,
  snapshot: "please look into this",
  attachments: [],
});

const recordedThread = (request: NTBSInput, threadId: ThreadId): ThreadCreated => ({
  ...request,
  state: "thread.created",
  t3Data: { threadId, userMessageId: MessageId.make(`message-for-${threadId}`) },
});

describe("NTBSProcessor (layer harness)", () => {
  it.effect("delivers T3 session events to the adapter and ignores unknown threads", () =>
    Effect.gen(function* () {
      const engine = yield* TestEngine;
      const adapterState = yield* TestAdapterState;
      const processor = yield* TestProcessor;

      yield* processor.subscribeToT3Events.pipe(Effect.forkChild({ startImmediately: true }));

      const threadId = ThreadId.make("unknown-thread");
      yield* engine.publish(yield* sessionSetEvent(threadId));

      // Taking the recorded lookup proves the event crossed the stream into
      // the adapter; an unknown thread must produce no further activity.
      assert.strictEqual(yield* Queue.take(adapterState.threadLookups), threadId);
      assert.deepStrictEqual(adapterState.postedResponses, []);
      assert.deepStrictEqual(engine.commands, []);
    }).pipe(Effect.provide(Harness)),
  );

  it.effect("drops a redelivered request that already has a recorded thread", () =>
    Effect.gen(function* () {
      const engine = yield* TestEngine;
      const adapterState = yield* TestAdapterState;
      const processor = yield* TestProcessor;

      const request = makeRequest("platform-message-1");
      const threadId = ThreadId.make("existing-thread");
      adapterState.records.set(threadId, recordedThread(request, threadId));

      yield* processor.process(request, {
        projectId: ProjectId.make("some-project"),
        baseRef: "main",
      });

      // Durable dedup: no new thread or turn, no second acknowledgement.
      assert.deepStrictEqual(engine.commands, []);
      assert.deepStrictEqual(adapterState.postedAcks, []);
    }).pipe(Effect.provide(Harness)),
  );

  it.effect("records an already-posted response without posting again", () =>
    Effect.gen(function* () {
      const engine = yield* TestEngine;
      const adapterState = yield* TestAdapterState;
      const processor = yield* TestProcessor;

      const request = makeRequest("platform-message-2");
      const threadId = ThreadId.make("answered-thread");
      adapterState.records.set(threadId, {
        ...recordedThread(request, threadId),
        state: "thread.response.posted",
        responseMessageId: "already-posted",
      });

      yield* processor.subscribeToT3Events.pipe(Effect.forkChild({ startImmediately: true }));
      yield* engine.publish(yield* sessionSetEvent(threadId));

      // The processor loads the record twice: once to route the event and once
      // under the outcome lock before deciding what to post.
      yield* Queue.take(adapterState.threadLookups);
      yield* Queue.take(adapterState.threadLookups);

      assert.deepStrictEqual(adapterState.postedResponses, []);
    }).pipe(Effect.provide(Harness)),
  );
});
