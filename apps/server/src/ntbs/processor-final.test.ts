import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Queue, Stream } from "effect";
import { ExchangeRepository, inMemoryExchangeRepository } from "./ExchangeRepository.ts";
import { makeNTBSProcessor, type NTBSProcessor, type T3Target } from "./processor.ts";
import { MessageId, ProjectId, ThreadId } from "@t3tools/contracts";
import { RetryableError, T3Gateway } from "./t3gateway.ts";
import { AdapterError, NTBSAdapter } from "./adapter.ts";
import {
  makeRequestClaimed,
  toReplyPending,
  toReplyPosted,
  toThreadCreated,
  type Exchange,
  type Request,
  type WorkCoordinates,
} from "./exchange.ts";

/**
 * The test configuration of the services.
 * While T3Gateway tests took flags as input (failX?: boolean, etc), this does not scale for processor test, because instead of a single call we're often testing an entire choreography of events and how the processor behaves in that situation.
 *
 * Flags, on the other hand, work when behaviors are small, enumerable and reused. Scripts pay off for testing choreography.
 */
type ServiceInput = {
  readonly t3Gateway?: Partial<T3Gateway>;
  readonly adapter?: Partial<NTBSAdapter>;
};

type Call = {
  service: string;
  method: string;
  args: ReadonlyArray<unknown>;
};

/**
 * Everything the test harness hands back to the file.
 *
 * The assembled service as well as probes to look into its state.
 */
type ProcessorTestContext = {
  /** The subject under test, built from mocked services.*/
  readonly processor: NTBSProcessor;
  /** Assesses the persisted state in most of the tests. What has been recorded about the events and changes? */
  readonly repository: ExchangeRepository;
  /** The shared ordered call log. We know what has been dispatched and with which arguments. This is not testing internals but actual business-logic. */
  readonly calls: ReadonlyArray<Call>;
  /** Pushes a threadId to the `threadActivity` stream, waking up the processor. */
  readonly pingActivity: (threadId: ThreadId) => Effect.Effect<void>;
  /**
   * Polls the repository until the exchange at `sourceUri` carries `tag`.
   * A Deferred signalled from inside a mock fires before the processor persists the transition, so anything that asserts on stored state after a mock call must wait on the store itself.
   */
  readonly awaitStoredTag: (sourceUri: string, tag: Exchange["tag"]) => Effect.Effect<Exchange>;
};

const request: Request = {
  sourceUri: "test://request/1",
  snapshot: "Please fix the bug",
  attachments: [],
};

const defaultProjectId = ProjectId.make("defaultProjectId");
const defaultThreadId = ThreadId.make("defaultThreadId");
const defaultUserMessageId = MessageId.make("defaultUserMessageId");

const defaultWorkCoordinates: WorkCoordinates = {
  projectId: defaultProjectId,
  startBranchName: "fork/dev",
  startCommitSha: "start-commit-sha",
  threadId: defaultThreadId,
  userMessageId: defaultUserMessageId,
  worktreeBranchName: "ntbs/defaultThreadId",
};

const secondRequest: Request = {
  ...request,
  sourceUri: "test://request/2",
};

const secondThreadId = ThreadId.make("secondThreadId");

const secondWorkCoordinates: WorkCoordinates = {
  ...defaultWorkCoordinates,
  startCommitSha: "second-start-commit-sha",
  threadId: secondThreadId,
  userMessageId: MessageId.make("secondUserMessageId"),
  worktreeBranchName: "ntbs/secondThreadId",
};

const target: T3Target = {
  projectId: defaultProjectId,
  startBranchName: "fork/dev",
};

const postedReplyUri = "test://reply/1";

/**
 * Happy-path defaults:
 * - fresh request flowing to a started turn
 * - nothing settled yet
 * - replies deliverable
 *
 * Each test overrides only the methods its scenario changes.
 */
const defaultT3Gateway: Omit<T3Gateway, "threadActivity"> = {
  planCoordinates: () => Effect.succeed(defaultWorkCoordinates),
  getThreadStatus: () => Effect.succeed({ thread: "missing" }),
  provisionThread: () => Effect.void,
  getTurnStatus: () => Effect.succeed({ turn: "missing" }),
  startTurn: () => Effect.void,
};

const defaultAdapter: NTBSAdapter = {
  acknowledge: () => Effect.void,
  postReply: () => Effect.succeed(postedReplyUri),
  findPostedReply: () => Effect.succeed(null),
};

/**
 * The harness.
 *
 * The term "harness" comes from electrical engineering for describing hardware test benches: the wiring harness is the fixed rig that holds the device under test and connects it to instruments, so each experiment only varies the stimulus.
 *
 * In software it means the same thing: the _fixed_ part of the test setup such as system assembly, instrumentation, probes, as opposed to fixtures (the data) and tests (the scenarios).
 *
 * `withProcessor` is our harness.
 *
 * <A, E> generics allow for our test callback to pass through its types.
 * We never specify A and E manually, and we rarely care, but if we ever have to chain the result of withProcessor or do anything with its returned value they are useful to avoid spreading `any`s.
 */
const withProcessor = <A, E>(
  servicesInput: ServiceInput,
  test: (context: ProcessorTestContext) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const calls: Call[] = [];
    const activity = yield* Queue.unbounded<ThreadId>();

    /**
     * Records the call, then runs the wrapped behavior.
     * Recording lives here so no implementation or override can forget it.
     * The push happens when the effect runs, not when it's created, which keeps the log ordering honest in the concurrency tests.
     */
    const wrap =
      (service: string) =>
      <Args extends ReadonlyArray<unknown>, B, E2>(
        method: string,
        fn: (...args: Args) => Effect.Effect<B, E2>,
      ) =>
      (...args: Args) =>
        Effect.suspend(() => {
          calls.push({ service, method, args });
          return fn(...args);
        });

    const wrapT3 = wrap("T3Gateway");
    const wrapAdapter = wrap("NTBSAdapter");

    const t3 = { ...defaultT3Gateway, ...servicesInput.t3Gateway };
    const adapter = { ...defaultAdapter, ...servicesInput.adapter };

    const layer = Layer.mergeAll(
      Layer.mock(T3Gateway, {
        planCoordinates: wrapT3("planCoordinates", t3.planCoordinates),
        getThreadStatus: wrapT3("getThreadStatus", t3.getThreadStatus),
        getTurnStatus: wrapT3("getTurnStatus", t3.getTurnStatus),
        provisionThread: wrapT3("provisionThread", t3.provisionThread),
        startTurn: wrapT3("startTurn", t3.startTurn),
        threadActivity: Stream.fromQueue(activity),
      }),
      Layer.mock(NTBSAdapter, {
        acknowledge: wrapAdapter("acknowledge", adapter.acknowledge),
        findPostedReply: wrapAdapter("findPostedReply", adapter.findPostedReply),
        postReply: wrapAdapter("postReply", adapter.postReply),
      }),
      inMemoryExchangeRepository,
    );

    return yield* Effect.gen(function* () {
      const processor = yield* makeNTBSProcessor;
      const repository = yield* ExchangeRepository;

      return yield* test({
        processor,
        repository,
        calls,
        pingActivity: (threadId) => Queue.offer(activity, threadId).pipe(Effect.asVoid),
        awaitStoredTag: (sourceUri, tag) =>
          Effect.gen(function* () {
            while (true) {
              const state = yield* repository.findBySourceUri(sourceUri);
              if (state !== null && state.tag === tag) {
                return state;
              }
              yield* Effect.yieldNow;
            }
          }),
      });
    }).pipe(Effect.provide(layer));
  });

describe("NTBSProcessor", () => {
  /*
    Harness smoke test: the happy-path defaults drive a fresh request to ThreadCreated with a started turn, and the shared log shows the full cross-service pipeline in order.
  */
  it.effect("claims a fresh request and starts its turn on the default behaviors", () =>
    withProcessor({}, ({ processor, repository, calls }) =>
      Effect.gen(function* () {
        yield* processor.process(request, target);

        expect(calls.map((call) => `${call.service}.${call.method}`)).toEqual([
          "T3Gateway.planCoordinates",
          "T3Gateway.getThreadStatus",
          "T3Gateway.provisionThread",
          "NTBSAdapter.acknowledge",
          "T3Gateway.getTurnStatus",
          "T3Gateway.startTurn",
        ]);

        // Still ThreadCreated: a successful startTurn transitions nothing, the exchange only moves when getTurnStatus observes a settled turn.
        const expected = toThreadCreated(makeRequestClaimed(request, defaultWorkCoordinates));

        expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(expected);
      }),
    ),
  );

  /*
    `process` is idempotent per sourceUri: a redelivery finds the claimed exchange and returns without touching T3 or the adapter.
    The smoke test above pins the exact pipeline, so here we check the log length twice: once after the first delivery to prove it actually did the work, once after the second to prove it added nothing — the log is append-only, so an unchanged length means zero service calls.
  */
  it.effect("starts a new request and ignores its sequential redelivery", () =>
    withProcessor({}, ({ processor, repository, calls }) =>
      Effect.gen(function* () {
        yield* processor.process(request, target);

        // The five T3 pipeline steps plus the acknowledgement.
        expect(calls.length).toBe(6);

        yield* processor.process(request, target);

        expect(calls.length).toBe(6);

        // And the stored exchange is still the one the first delivery claimed.
        const expected = toThreadCreated(makeRequestClaimed(request, defaultWorkCoordinates));

        expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(expected);
      }),
    ),
  );

  /*
    The acknowledgement is best-effort: a failing `acknowledge` must not stop the pipeline.
    The log proves the failure was swallowed in place, the T3 steps after it still ran, and the exchange still reached ThreadCreated.
  */
  it.effect("continues after a best-effort acknowledgement fails", () =>
    withProcessor(
      {
        adapter: {
          acknowledge: () =>
            new AdapterError({
              reason: "The acknowledgement could not be posted",
              cause: "test failure",
            }),
        },
      },
      ({ processor, repository, calls }) =>
        Effect.gen(function* () {
          yield* processor.process(request, target);

          expect(calls.map((call) => `${call.service}.${call.method}`)).toEqual([
            "T3Gateway.planCoordinates",
            "T3Gateway.getThreadStatus",
            "T3Gateway.provisionThread",
            "NTBSAdapter.acknowledge",
            "T3Gateway.getTurnStatus",
            "T3Gateway.startTurn",
          ]);

          const expected = toThreadCreated(makeRequestClaimed(request, defaultWorkCoordinates));

          expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(expected);
        }),
    ),
  );

  /*
    A stored ThreadCreated whose turn is still running is a no-op, whether startup recovery or thread activity looks at it.
    The processor asks T3 for the turn status and stops there: no planning, no acknowledgement, no second startTurn, no reply lookup.
  */
  it.effect("leaves an exchange unchanged while its turn is active", () => {
    const recoveryStatusRead = Deferred.makeUnsafe<void>();
    const activityStatusRead = Deferred.makeUnsafe<void>();
    let statusReads = 0;

    return withProcessor(
      {
        t3Gateway: {
          getTurnStatus: () =>
            Effect.gen(function* () {
              statusReads += 1;
              yield* Deferred.succeed(
                statusReads === 1 ? recoveryStatusRead : activityStatusRead,
                undefined,
              );
              return { turn: "active" as const };
            }),
        },
      },
      ({ processor, repository, calls, pingActivity }) =>
        Effect.gen(function* () {
          const threadCreated = toThreadCreated(
            makeRequestClaimed(request, defaultWorkCoordinates),
          );
          yield* repository.upsert(threadCreated);

          const run = yield* processor.run.pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(recoveryStatusRead);
          yield* Effect.yieldNow;

          expect(calls.map((call) => `${call.service}.${call.method}`)).toEqual([
            "T3Gateway.getTurnStatus",
          ]);

          yield* pingActivity(defaultThreadId);
          yield* Deferred.await(activityStatusRead);
          // Give the processor a chance to do anything else it might wrongly want to do after the status reads.
          yield* Effect.yieldNow;

          expect(calls.map((call) => `${call.service}.${call.method}`)).toEqual([
            "T3Gateway.getTurnStatus",
            "T3Gateway.getTurnStatus",
          ]);
          expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(threadCreated);

          yield* Fiber.interrupt(run);
        }),
    );
  });

  /*
    A transient provisioning failure leaves the exchange at RequestClaimed and surfaces as a `process` failure.
    Startup recovery then picks the claim up where it stopped: it re-checks the thread, provisions it, and carries on to the turn.
    Planning is not repeated, the coordinates were already persisted with the claim.
  */
  it.effect("retries a transient provisioning failure during later recovery", () => {
    const turnStarted = Deferred.makeUnsafe<void>();
    let provisionCalls = 0;

    return withProcessor(
      {
        t3Gateway: {
          provisionThread: () =>
            Effect.gen(function* () {
              provisionCalls += 1;
              if (provisionCalls === 1) {
                return yield* new RetryableError({
                  reason: "Thread provisioning temporarily failed",
                  cause: "test failure",
                  method: "provisionThread",
                });
              }
            }),
          startTurn: () => Deferred.succeed(turnStarted, undefined),
        },
      },
      ({ processor, repository, calls }) =>
        Effect.gen(function* () {
          const exit = yield* Effect.exit(processor.process(request, target));
          expect(exit._tag).toBe("Failure");

          expect(calls.map((call) => `${call.service}.${call.method}`)).toEqual([
            "T3Gateway.planCoordinates",
            "T3Gateway.getThreadStatus",
            "T3Gateway.provisionThread",
          ]);

          const claimed = makeRequestClaimed(request, defaultWorkCoordinates);
          expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(claimed);

          const run = yield* processor.run.pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(turnStarted);

          expect(calls.map((call) => `${call.service}.${call.method}`)).toEqual([
            "T3Gateway.planCoordinates",
            "T3Gateway.getThreadStatus",
            "T3Gateway.provisionThread",
            // Recovery resumes from the persisted claim.
            "T3Gateway.getThreadStatus",
            "T3Gateway.provisionThread",
            "NTBSAdapter.acknowledge",
            "T3Gateway.getTurnStatus",
            "T3Gateway.startTurn",
          ]);
          expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(
            toThreadCreated(claimed),
          );

          yield* Fiber.interrupt(run);
        }),
    );
  });

  /*
    A transient turn-start failure happens after ThreadCreated was persisted, so the exchange stays there and `process` fails.
    Recovery resumes from ThreadCreated: the thread is neither re-checked nor re-provisioned, and the acknowledgement is not repeated. Only the turn is retried.
  */
  it.effect("retries a transient turn-start failure during later recovery", () => {
    const turnStarted = Deferred.makeUnsafe<void>();
    let startTurnCalls = 0;

    return withProcessor(
      {
        t3Gateway: {
          startTurn: () =>
            Effect.gen(function* () {
              startTurnCalls += 1;
              if (startTurnCalls === 1) {
                return yield* new RetryableError({
                  reason: "Turn start temporarily failed",
                  cause: "test failure",
                  method: "startTurn",
                });
              }
              yield* Deferred.succeed(turnStarted, undefined);
            }),
        },
      },
      ({ processor, repository, calls }) =>
        Effect.gen(function* () {
          const exit = yield* Effect.exit(processor.process(request, target));
          expect(exit._tag).toBe("Failure");

          expect(calls.map((call) => `${call.service}.${call.method}`)).toEqual([
            "T3Gateway.planCoordinates",
            "T3Gateway.getThreadStatus",
            "T3Gateway.provisionThread",
            "NTBSAdapter.acknowledge",
            "T3Gateway.getTurnStatus",
            "T3Gateway.startTurn",
          ]);

          const threadCreated = toThreadCreated(
            makeRequestClaimed(request, defaultWorkCoordinates),
          );
          expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(threadCreated);

          const run = yield* processor.run.pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(turnStarted);

          expect(calls.map((call) => `${call.service}.${call.method}`)).toEqual([
            "T3Gateway.planCoordinates",
            "T3Gateway.getThreadStatus",
            "T3Gateway.provisionThread",
            "NTBSAdapter.acknowledge",
            "T3Gateway.getTurnStatus",
            "T3Gateway.startTurn",
            // Recovery resumes from ThreadCreated.
            "T3Gateway.getTurnStatus",
            "T3Gateway.startTurn",
          ]);
          expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(threadCreated);

          yield* Fiber.interrupt(run);
        }),
    );
  });

  /*
    Deliveries of the same sourceUri are serialized behind a per-source lock.
    The first delivery is held inside planCoordinates, before anything is persisted, so a naive second delivery would also find nothing stored and plan again.
    Instead it waits: no second planCoordinates while the first is blocked, and once released the log shows a single pipeline, the second delivery having found the claim and returned.
  */
  it.effect("serializes concurrent deliveries of the same request", () => {
    const firstPlanStarted = Deferred.makeUnsafe<void>();
    const releaseFirstPlan = Deferred.makeUnsafe<void>();

    return withProcessor(
      {
        t3Gateway: {
          planCoordinates: () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(firstPlanStarted, undefined);
              yield* Deferred.await(releaseFirstPlan);
              return defaultWorkCoordinates;
            }),
        },
      },
      ({ processor, repository, calls }) =>
        Effect.gen(function* () {
          const first = yield* processor
            .process(request, target)
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(firstPlanStarted);

          const second = yield* processor
            .process(request, target)
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Effect.yieldNow;

          /* Fiber.pollUnsafe() is a synchronous, non-blocking peek at a fiber's state. It returns `undefined` if the fiber is still running.
             It's an indirect soft-assertion that the second delivery is still suspended on the source lock.
          */
          expect(second.pollUnsafe()).toBeUndefined();
          expect(calls.map((call) => `${call.service}.${call.method}`)).toEqual([
            "T3Gateway.planCoordinates",
          ]);
          expect(yield* repository.findBySourceUri(request.sourceUri)).toBeNull();

          yield* Deferred.succeed(releaseFirstPlan, undefined);
          yield* Fiber.join(first);
          yield* Fiber.join(second);

          expect(calls.map((call) => `${call.service}.${call.method}`)).toEqual([
            "T3Gateway.planCoordinates",
            "T3Gateway.getThreadStatus",
            "T3Gateway.provisionThread",
            "NTBSAdapter.acknowledge",
            "T3Gateway.getTurnStatus",
            "T3Gateway.startTurn",
          ]);
          expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(
            toThreadCreated(makeRequestClaimed(request, defaultWorkCoordinates)),
          );
        }),
    );
  });

  /*
    The lock serializes, it does not couple outcomes.
    When the first delivery fails inside planCoordinates, nothing was persisted, so the queued delivery finds an empty repository and claims the request itself.
    The log shows two plans, the failed one and the successful one, followed by a single pipeline.
  */
  it.effect("lets a queued delivery claim after the first fails before persistence", () => {
    const firstPlanStarted = Deferred.makeUnsafe<void>();
    const releaseFirstPlan = Deferred.makeUnsafe<void>();
    let planCalls = 0;

    return withProcessor(
      {
        t3Gateway: {
          planCoordinates: () =>
            Effect.gen(function* () {
              planCalls += 1;
              if (planCalls === 1) {
                yield* Deferred.succeed(firstPlanStarted, undefined);
                yield* Deferred.await(releaseFirstPlan);
                return yield* new RetryableError({
                  reason: "The first planning attempt failed",
                  cause: "test failure",
                  method: "planCoordinates",
                });
              }
              return defaultWorkCoordinates;
            }),
        },
      },
      ({ processor, repository, calls }) =>
        Effect.gen(function* () {
          const first = yield* processor
            .process(request, target)
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(firstPlanStarted);

          const second = yield* processor
            .process(request, target)
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Effect.yieldNow;

          expect(second.pollUnsafe()).toBeUndefined();
          expect(calls.map((call) => `${call.service}.${call.method}`)).toEqual([
            "T3Gateway.planCoordinates",
          ]);
          expect(yield* repository.findBySourceUri(request.sourceUri)).toBeNull();

          yield* Deferred.succeed(releaseFirstPlan, undefined);
          expect((yield* Fiber.await(first))._tag).toBe("Failure");
          yield* Fiber.join(second);

          expect(calls.map((call) => `${call.service}.${call.method}`)).toEqual([
            "T3Gateway.planCoordinates",
            // The queued delivery plans again because the failed one persisted nothing.
            "T3Gateway.planCoordinates",
            "T3Gateway.getThreadStatus",
            "T3Gateway.provisionThread",
            "NTBSAdapter.acknowledge",
            "T3Gateway.getTurnStatus",
            "T3Gateway.startTurn",
          ]);
          expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(
            toThreadCreated(makeRequestClaimed(request, defaultWorkCoordinates)),
          );
        }),
    );
  });

  /*
    The mirror of the previous test: the first delivery fails *after* persisting the claim, inside getThreadStatus.
    The queued redelivery then finds the claim and returns without touching any service, and it is recovery, not the redelivery, that eventually finishes the pipeline.
  */
  it.effect("retains a failed claim for later recovery and ignores its queued redelivery", () => {
    const threadStatusStarted = Deferred.makeUnsafe<void>();
    const releaseThreadStatus = Deferred.makeUnsafe<void>();
    const turnStarted = Deferred.makeUnsafe<void>();
    let threadStatusCalls = 0;

    return withProcessor(
      {
        t3Gateway: {
          getThreadStatus: () =>
            Effect.gen(function* () {
              threadStatusCalls += 1;
              if (threadStatusCalls === 1) {
                yield* Deferred.succeed(threadStatusStarted, undefined);
                yield* Deferred.await(releaseThreadStatus);
                return yield* new RetryableError({
                  reason: "Failed after persisting the claim",
                  cause: "test failure",
                  method: "getThreadStatus",
                });
              }
              return { thread: "missing" as const };
            }),
          startTurn: () => Deferred.succeed(turnStarted, undefined),
        },
      },
      ({ processor, repository, calls }) =>
        Effect.gen(function* () {
          const first = yield* processor
            .process(request, target)
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(threadStatusStarted);

          const claimed = makeRequestClaimed(request, defaultWorkCoordinates);
          expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(claimed);

          const second = yield* processor
            .process(request, target)
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Effect.yieldNow;

          expect(second.pollUnsafe()).toBeUndefined();
          expect(calls.map((call) => `${call.service}.${call.method}`)).toEqual([
            "T3Gateway.planCoordinates",
            "T3Gateway.getThreadStatus",
          ]);

          yield* Deferred.succeed(releaseThreadStatus, undefined);
          expect((yield* Fiber.await(first))._tag).toBe("Failure");
          yield* Fiber.join(second);

          // The redelivery found the claim and added nothing to the log.
          expect(calls.map((call) => `${call.service}.${call.method}`)).toEqual([
            "T3Gateway.planCoordinates",
            "T3Gateway.getThreadStatus",
          ]);
          expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(claimed);

          const run = yield* processor.run.pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(turnStarted);

          expect(calls.map((call) => `${call.service}.${call.method}`)).toEqual([
            "T3Gateway.planCoordinates",
            "T3Gateway.getThreadStatus",
            // Recovery resumes from the persisted claim.
            "T3Gateway.getThreadStatus",
            "T3Gateway.provisionThread",
            "NTBSAdapter.acknowledge",
            "T3Gateway.getTurnStatus",
            "T3Gateway.startTurn",
          ]);
          expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(
            toThreadCreated(claimed),
          );

          yield* Fiber.interrupt(run);
        }),
    );
  });

  /*
    Interruption must release the source lock like any other exit, otherwise one cancelled delivery would wedge its sourceUri forever.
    The first delivery is interrupted while holding the lock inside planCoordinates; the queued one then acquires it, plans again and runs the pipeline.
  */
  it.effect("releases the source lock when its holder is interrupted", () => {
    const firstPlanStarted = Deferred.makeUnsafe<void>();
    const keepFirstPlanBlocked = Deferred.makeUnsafe<void>();
    let planCalls = 0;

    return withProcessor(
      {
        t3Gateway: {
          planCoordinates: () =>
            Effect.gen(function* () {
              planCalls += 1;
              if (planCalls === 1) {
                yield* Deferred.succeed(firstPlanStarted, undefined);
                yield* Deferred.await(keepFirstPlanBlocked);
              }
              return defaultWorkCoordinates;
            }),
        },
      },
      ({ processor, repository, calls }) =>
        Effect.gen(function* () {
          const first = yield* processor
            .process(request, target)
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(firstPlanStarted);

          const second = yield* processor
            .process(request, target)
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Effect.yieldNow;

          expect(second.pollUnsafe()).toBeUndefined();
          expect(calls.map((call) => `${call.service}.${call.method}`)).toEqual([
            "T3Gateway.planCoordinates",
          ]);
          expect(yield* repository.findBySourceUri(request.sourceUri)).toBeNull();

          yield* Fiber.interrupt(first);
          yield* Fiber.join(second);

          expect(calls.map((call) => `${call.service}.${call.method}`)).toEqual([
            "T3Gateway.planCoordinates",
            // The queued delivery plans again because the interrupted one persisted nothing.
            "T3Gateway.planCoordinates",
            "T3Gateway.getThreadStatus",
            "T3Gateway.provisionThread",
            "NTBSAdapter.acknowledge",
            "T3Gateway.getTurnStatus",
            "T3Gateway.startTurn",
          ]);
          expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(
            toThreadCreated(makeRequestClaimed(request, defaultWorkCoordinates)),
          );
        }),
    );
  });

  /*
    The other side of interruption: cancelling a delivery that is *waiting* for the lock must not disturb the holder or the lock itself.
    The holder keeps running, a later delivery queues behind it as usual, and the final log is one pipeline with no extra plan.
  */
  it.effect("interrupting a queued delivery preserves the lock for later deliveries", () => {
    const firstPlanStarted = Deferred.makeUnsafe<void>();
    const releaseFirstPlan = Deferred.makeUnsafe<void>();

    return withProcessor(
      {
        t3Gateway: {
          planCoordinates: () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(firstPlanStarted, undefined);
              yield* Deferred.await(releaseFirstPlan);
              return defaultWorkCoordinates;
            }),
        },
      },
      ({ processor, repository, calls }) =>
        Effect.gen(function* () {
          const first = yield* processor
            .process(request, target)
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(firstPlanStarted);

          const interruptedWaiter = yield* processor
            .process(request, target)
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Effect.yieldNow;

          expect(interruptedWaiter.pollUnsafe()).toBeUndefined();

          yield* Fiber.interrupt(interruptedWaiter);

          // The holder is unaffected: still blocked in planCoordinates, nothing stored.
          expect(first.pollUnsafe()).toBeUndefined();
          expect(calls.map((call) => `${call.service}.${call.method}`)).toEqual([
            "T3Gateway.planCoordinates",
          ]);
          expect(yield* repository.findBySourceUri(request.sourceUri)).toBeNull();

          const later = yield* processor
            .process(request, target)
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Effect.yieldNow;

          expect(later.pollUnsafe()).toBeUndefined();

          yield* Deferred.succeed(releaseFirstPlan, undefined);
          yield* Fiber.join(first);
          yield* Fiber.join(later);

          expect(calls.map((call) => `${call.service}.${call.method}`)).toEqual([
            "T3Gateway.planCoordinates",
            "T3Gateway.getThreadStatus",
            "T3Gateway.provisionThread",
            "NTBSAdapter.acknowledge",
            "T3Gateway.getTurnStatus",
            "T3Gateway.startTurn",
          ]);
          expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(
            toThreadCreated(makeRequestClaimed(request, defaultWorkCoordinates)),
          );
        }),
    );
  });

  /*
    The lock is per sourceUri, not global.
    While the first request is blocked in planCoordinates, a different request runs its whole pipeline to completion.
    `planCoordinates` does not receive the request, so the mock hands out coordinates by call order.
  */
  it.effect("allows different requests to proceed concurrently", () => {
    const firstPlanStarted = Deferred.makeUnsafe<void>();
    const releaseFirstPlan = Deferred.makeUnsafe<void>();
    let planCalls = 0;

    return withProcessor(
      {
        t3Gateway: {
          planCoordinates: () =>
            Effect.gen(function* () {
              planCalls += 1;
              if (planCalls === 1) {
                yield* Deferred.succeed(firstPlanStarted, undefined);
                yield* Deferred.await(releaseFirstPlan);
                return defaultWorkCoordinates;
              }
              return secondWorkCoordinates;
            }),
        },
      },
      ({ processor, repository, calls }) =>
        Effect.gen(function* () {
          const first = yield* processor
            .process(request, target)
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(firstPlanStarted);

          yield* processor.process(secondRequest, target);

          // The second request completed while the first is still held in planCoordinates.
          expect(first.pollUnsafe()).toBeUndefined();
          expect(calls.map((call) => `${call.service}.${call.method}`)).toEqual([
            "T3Gateway.planCoordinates",
            "T3Gateway.planCoordinates",
            "T3Gateway.getThreadStatus",
            "T3Gateway.provisionThread",
            "NTBSAdapter.acknowledge",
            "T3Gateway.getTurnStatus",
            "T3Gateway.startTurn",
          ]);
          expect(yield* repository.findBySourceUri(request.sourceUri)).toBeNull();
          expect(yield* repository.findBySourceUri(secondRequest.sourceUri)).toEqual(
            toThreadCreated(makeRequestClaimed(secondRequest, secondWorkCoordinates)),
          );

          yield* Deferred.succeed(releaseFirstPlan, undefined);
          yield* Fiber.join(first);

          expect(calls.map((call) => `${call.service}.${call.method}`)).toEqual([
            "T3Gateway.planCoordinates",
            "T3Gateway.planCoordinates",
            "T3Gateway.getThreadStatus",
            "T3Gateway.provisionThread",
            "NTBSAdapter.acknowledge",
            "T3Gateway.getTurnStatus",
            "T3Gateway.startTurn",
            // The first request finishes its own pipeline once released.
            "T3Gateway.getThreadStatus",
            "T3Gateway.provisionThread",
            "NTBSAdapter.acknowledge",
            "T3Gateway.getTurnStatus",
            "T3Gateway.startTurn",
          ]);
          expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(
            toThreadCreated(makeRequestClaimed(request, defaultWorkCoordinates)),
          );
        }),
    );
  });

  /*
    Startup recovery walks every non-terminal exchange.
    A stored ThreadCreated whose turn has meanwhile completed is carried to ReplyPosted: the reply is looked up on the platform first, not found, then posted.
  */
  it.effect("resumes non-terminal exchanges when run starts", () => {
    const reply = { type: "answer" as const, text: "Recovered reply" };

    return withProcessor(
      {
        t3Gateway: {
          getTurnStatus: () => Effect.succeed({ turn: "completed", reply }),
        },
      },
      ({ processor, repository, calls, awaitStoredTag }) =>
        Effect.gen(function* () {
          const threadCreated = toThreadCreated(
            makeRequestClaimed(request, defaultWorkCoordinates),
          );
          yield* repository.upsert(threadCreated);

          const run = yield* processor.run.pipe(Effect.forkChild({ startImmediately: true }));
          const posted = yield* awaitStoredTag(request.sourceUri, "reply-posted");

          expect(calls.map((call) => `${call.service}.${call.method}`)).toEqual([
            "T3Gateway.getTurnStatus",
            "NTBSAdapter.findPostedReply",
            "NTBSAdapter.postReply",
          ]);

          const replyPending = toReplyPending(threadCreated, reply);
          expect(calls.at(-1)?.args).toEqual([replyPending]);
          expect(posted).toEqual(toReplyPosted(replyPending, postedReplyUri));

          yield* Fiber.interrupt(run);
        }),
    );
  });

  /*
    Thread activity is routed by threadId. An unknown thread is dropped without any service call; a stored one gets its turn status re-read.
    Recovery sees the turn still active, so the reply only arrives through the ping.
  */
  it.effect("routes thread activity only for stored exchanges", () => {
    const reply = { type: "answer" as const, text: "Reply after thread activity" };
    let statusReads = 0;

    return withProcessor(
      {
        t3Gateway: {
          getTurnStatus: () =>
            Effect.sync(() => {
              statusReads += 1;
              return statusReads === 1
                ? { turn: "active" as const }
                : { turn: "completed" as const, reply };
            }),
        },
      },
      ({ processor, repository, calls, pingActivity, awaitStoredTag }) =>
        Effect.gen(function* () {
          const threadCreated = toThreadCreated(
            makeRequestClaimed(request, defaultWorkCoordinates),
          );
          yield* repository.upsert(threadCreated);

          const run = yield* processor.run.pipe(Effect.forkChild({ startImmediately: true }));

          yield* pingActivity(ThreadId.make("unknown-thread"));
          yield* pingActivity(defaultThreadId);
          const posted = yield* awaitStoredTag(request.sourceUri, "reply-posted");

          expect(calls.map((call) => `${call.service}.${call.method}`)).toEqual([
            // Startup recovery.
            "T3Gateway.getTurnStatus",
            // The unknown thread contributed nothing; this is the stored thread's ping.
            "T3Gateway.getTurnStatus",
            "NTBSAdapter.findPostedReply",
            "NTBSAdapter.postReply",
          ]);
          // Both status reads were for the stored exchange.
          expect(calls[0]?.args).toEqual([threadCreated]);
          expect(calls[1]?.args).toEqual([threadCreated]);
          expect(posted).toEqual(
            toReplyPosted(toReplyPending(threadCreated, reply), postedReplyUri),
          );

          yield* Fiber.interrupt(run);
        }),
    );
  });

  /*
    Activity handling takes the same per-source lock as `process`.
    While the ping's status read is held open, a redelivery of the request parks behind it instead of racing on the stored exchange; once released it finds the reply posted and returns without calls.
  */
  it.effect("serializes thread activity with a redelivered request", () => {
    const activityStatusStarted = Deferred.makeUnsafe<void>();
    const releaseActivityStatus = Deferred.makeUnsafe<void>();
    const reply = { type: "answer" as const, text: "Reply from thread activity" };
    let statusReads = 0;

    return withProcessor(
      {
        t3Gateway: {
          getTurnStatus: () =>
            Effect.gen(function* () {
              statusReads += 1;
              if (statusReads === 1) {
                return { turn: "active" as const };
              }
              yield* Deferred.succeed(activityStatusStarted, undefined);
              yield* Deferred.await(releaseActivityStatus);
              return { turn: "completed" as const, reply };
            }),
        },
      },
      ({ processor, repository, calls, pingActivity, awaitStoredTag }) =>
        Effect.gen(function* () {
          const threadCreated = toThreadCreated(
            makeRequestClaimed(request, defaultWorkCoordinates),
          );
          yield* repository.upsert(threadCreated);

          const run = yield* processor.run.pipe(Effect.forkChild({ startImmediately: true }));

          yield* pingActivity(defaultThreadId);
          yield* Deferred.await(activityStatusStarted);

          const redelivery = yield* processor
            .process(request, target)
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Effect.yieldNow;

          expect(redelivery.pollUnsafe()).toBeUndefined();
          expect(calls.map((call) => `${call.service}.${call.method}`)).toEqual([
            "T3Gateway.getTurnStatus",
            "T3Gateway.getTurnStatus",
          ]);
          expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(threadCreated);

          yield* Deferred.succeed(releaseActivityStatus, undefined);
          const posted = yield* awaitStoredTag(request.sourceUri, "reply-posted");
          yield* Fiber.join(redelivery);

          expect(calls.map((call) => `${call.service}.${call.method}`)).toEqual([
            "T3Gateway.getTurnStatus",
            "T3Gateway.getTurnStatus",
            "NTBSAdapter.findPostedReply",
            "NTBSAdapter.postReply",
          ]);
          expect(posted).toEqual(
            toReplyPosted(toReplyPending(threadCreated, reply), postedReplyUri),
          );

          yield* Fiber.interrupt(run);
        }),
    );
  });
});
