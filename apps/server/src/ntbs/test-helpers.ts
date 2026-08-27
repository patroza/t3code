import { Context, Effect, Layer, PubSub, Queue, Stream } from "effect";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import {
  OrchestrationCommand,
  OrchestrationEvent,
  ProjectId,
  ThreadId,
  VcsCreateWorktreeResult,
} from "@t3tools/contracts";
import type { Request, Exchange, ThreadCreated } from "./exchange.ts";
import type { T3Context } from "./t3gateway.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { makeNTBSAdapterTag, ThreadNotFound, type NTBSResponse } from "./adapter.ts";

export const createGitLayerMock = () => {
  const gitCalls = {
    createWorktree: [] as unknown[],
    fetchRemote: [] as unknown[],
    resolveRemoteTrackingCommit: [] as unknown[],
    removeWorktree: [] as unknown[],
  };

  const layer = Layer.mock(GitWorkflowService, {
    fetchRemote: (input) =>
      Effect.sync(function () {
        gitCalls.fetchRemote.push(input);
      }),
    resolveRemoteTrackingCommit: (input) =>
      Effect.sync(() => {
        gitCalls.resolveRemoteTrackingCommit.push(input);

        return { commitSha: "input-sha", remoteRefName: input.refName };
      }),
    createWorktree: (input) =>
      Effect.sync(() => {
        gitCalls.createWorktree.push(input);
        return VcsCreateWorktreeResult.make({
          worktree: {
            path: "createworktreepath",
            refName: input.refName,
          },
        });
      }),
    removeWorktree: (input) =>
      Effect.sync(() => {
        gitCalls.removeWorktree.push(input);

        return;
      }),
  });

  return {
    gitCalls,
    layer,
  };
};

export const createAdapterRequest = (
  uniqueId: string,
): {
  request: Request;
  t3Context: T3Context;
} => ({
  request: {
    snapshot: "This is an ongoing discussion",
    attachments: [],
    sourceUri: uniqueId,
  },
  t3Context: {
    startBranchName: "fork/dev",
    projectId: ProjectId.make("project"),
  },
});

/*
    # Testing strategy

    At its core the processor provides the business logic implementation that interacts with external services.

    The two core *behavioral* boundaries that are coordinated by the processor are the:
    
    - T3 orchestration engine. Emits event that the processor reads, receives commands (such as `thread.create` or `thread.turn.start` from the processor.
    
    - Adapter. The software responsible for the external platform (such as Jira or Discord) integration. It records acknowledgements and responses, stores lifecycle records, and answers deduplication and thread lookup queries.

    The other boundaries that communicate with the processor are:
    - ProjectionSnapshotQuery: reads project and thread state
    - ProjectionTurnRepository: reads turn progress
    - GitWorkflowService: fetches refs and creates worktrees
    - ProjectSetupScriptRunner: runs project setup

    Focusing on the behavioral boundary allows to quickly test the happy cases.

    The test simulates T3 events entering the processor, and the commands that the processor sends to T3 via `TestT3Engine`.

    It inspects the acknowledgements, responses and lifecycle events of the adapter via `TestAdapter`.
*/

class TestEngine extends Context.Service<
  TestEngine,
  {
    /**
     * Every command the processor dispatched, in order.
     */
    readonly commandsReceived: Array<OrchestrationCommand>;
    /**
     * Emits a domain event as if the orchestration engine produced it.
     */
    readonly publish: (event: OrchestrationEvent) => Effect.Effect<void>;

    readonly domainEvents: PubSub.PubSub<OrchestrationEvent>;
  }
>()("t3/ntbs/test-helpers/TestEngine") {
  static readonly layer = Layer.effect(
    TestEngine,
    Effect.gen(function* () {
      /**
       * In production `OrchestrationEngineService.streamDomainEvents` is the live
       * feed of domain events the engine emits as it processes commands.
       *
       * It is a Stream<OrchestrationEvent>.
       *
       * Here, `domainEvents` is the PubSub<OrchestrationEvent> where events are published.
       *
       * The main purpose of this PubSub and related code is enabling tests to say "the engine just emitted event X for thread Y" without any real engine, persistence or provider session existing.
       */
      const domainEvents = yield* PubSub.unbounded<OrchestrationEvent>();
      return {
        commandsReceived: [],
        domainEvents,
        /**
         * The entry point for emulating orchestration engine published events in test.
         *
         * Call `TestEngine.publish`.
         * It will publish the event to `domainEvents`.
         * Then, the `OrchestrationEngineService` will stream that event out of `streamDomainEvents`, in the very same fashion the
         */
        publish: (event: OrchestrationEvent) => PubSub.publish(domainEvents, event),
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
      dispatch: (command) =>
        Effect.sync(() => {
          engine.commandsReceived.push(command);
          sequence += 1;
          return { sequence };
        }),
      latestSequence: Effect.sync(() => sequence),
      readEvents: () => Stream.empty,
      streamDomainEvents: Stream.fromPubSub(engine.domainEvents),
    });
  }),
);

// TODO: Continue from here
class TestAdapterState extends Context.Service<
  TestAdapterState,
  {
    /**
     * Lifecycle records keyed by T3 thread.
     */
    readonly records: Map<ThreadId, Exchange>;
    readonly postedAcks: Map<string, ThreadCreated>;
    readonly postedResponses: Map<
      string,
      {
        readonly record: ThreadCreated;
        readonly response: NTBSResponse;
      }
    >;
    /**
     * One entry per findByThreadId call;
     * taking from it awaits event delivery.
     */
    readonly threadLookups: Queue.Queue<ThreadId>;
  }
>()("t3/ntbs/test-helpers/TestAdapterState") {
  static readonly layer = Layer.effect(
    TestAdapterState,
    Effect.gen(function* () {
      return {
        // lifecycleEvents: [],
        records: new Map<ThreadId, Exchange>(),
        postedAcks: new Map<string, ThreadCreated>(),
        postedResponses: new Map<
          string,
          {
            readonly record: ThreadCreated;
            readonly response: NTBSResponse;
          }
        >(),
        threadLookups: yield* Queue.unbounded<ThreadId>(),
      };
    }),
  );
}

const TestAdapter = makeNTBSAdapterTag("test/ntbs/TestAdapter");

const TestAdapterFromState = Layer.effect(
  TestAdapter,
  Effect.gen(function* () {
    const adapterState = yield* TestAdapterState;

    return {
      save: (event) =>
        Effect.sync(() => {
          adapterState.records.set(event.t3.threadId, event);
        }),
      acknowledge: (state) =>
        Effect.sync(() => {
          const acknowledgementId = `acknowledgementId-${adapterState.postedAcks.size}`;
          adapterState.postedAcks.set(acknowledgementId, state);
          return acknowledgementId;
        }),

      postResponse: (state, response) =>
        Effect.sync(() => {
          const messageId = `messageid-${adapterState.postedResponses.size}`;
          adapterState.postedResponses.set(messageId, {
            record: state,
            response,
          });
          return messageId;
        }),
      findByRequest: (request) =>
        Effect.sync(function () {
          return (
            adapterState.records
              .entries()
              .map((el) => el[1])
              .find((entry) => {
                return entry.sourceUri === request.sourceUri;
              }) ?? null
          );
        }),
      findByThreadId: (threadId) =>
        Effect.suspend(() => {
          const maybeRecord = adapterState.records.get(threadId);

          return maybeRecord ? Effect.succeed(maybeRecord) : new ThreadNotFound();
        }),
      findMatchingResponseMessage: (state) =>
        Effect.sync(() => {
          const maybeResponse = adapterState.postedResponses
            .entries()
            .find(([_id, posted]) => posted.record.sourceUri === state.sourceUri);
          return maybeResponse ? maybeResponse[0] : null;
        }),
      loadThreadsAwaitingResponse: Effect.sync(() => {
        const awaitingResponse: ThreadCreated[] = [];
        adapterState.records.forEach((state) => {
          if (state.state === "thread.created") {
            awaitingResponse.push(state);
          }
        });
        return awaitingResponse;
      }),
    };
  }),
);
