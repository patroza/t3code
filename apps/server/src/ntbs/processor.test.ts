import { describe, expect, it } from "@effect/vitest";
import { Cause, Clock, Deferred, Effect, Exit, Fiber, Layer, Queue, Stream } from "effect";
import { TestClock } from "effect/testing";
import {
  ExchangeRepository,
  ExchangeRepositoryError,
  inMemoryExchangeRepository,
} from "./ExchangeRepository.ts";
import { makeNTBSProcessor, NTBSProcessorError, type NTBSProcessor } from "./processor.ts";
import { MessageId, ProjectId, ThreadId, TurnId } from "@t3tools/contracts";
import { FatalError, RetryableError, T3Gateway } from "./t3gateway.ts";
import { AdapterError, NTBSAdapter, ReplyRejected } from "./adapter.ts";
import {
  makeRequestAccepted,
  toExpired,
  toRejected,
  toReplyPending,
  toReplyPosted,
  toThreadCreated,
  toUndeliverable,
  toWorkPlanned,
  type Exchange,
  type Request,
  type T3Target,
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
  readonly awaitStoredTag: (
    sourceUri: string,
    tag: Exchange["tag"],
  ) => Effect.Effect<Exchange, ExchangeRepositoryError>;
};

const request: Request = {
  sourceUri: "test://request/1",
  snapshot: "Please fix the bug",
  attachments: [],
};

const defaultProjectId = ProjectId.make("defaultProjectId");
const defaultThreadId = ThreadId.make("defaultThreadId");
const defaultUserMessageId = MessageId.make("defaultUserMessageId");

const target: T3Target = {
  projectId: defaultProjectId,
  startBranchName: "fork/dev",
};

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

const postedReplyUri = "test://reply/1";

/** The TestClock starts at epoch, so every transition the processor makes without adjusting it is stamped 0. */
const now = 0;

/** The states the default request walks through, for asserting on stored records. */
const accepted = makeRequestAccepted(request, target, now);
const planned = toWorkPlanned(accepted, defaultWorkCoordinates, now);
const threadCreated = toThreadCreated(planned, now);

const secondThreadCreated = toThreadCreated(
  toWorkPlanned(makeRequestAccepted(secondRequest, target, now), secondWorkCoordinates, now),
  now,
);

/** An answer out of the turn our message started on the given coordinates. */
const answer = (text: string, coordinates: WorkCoordinates = defaultWorkCoordinates) =>
  ({
    type: "answer",
    text,
    threadId: coordinates.threadId,
    userMessageId: coordinates.userMessageId,
    turnId: TurnId.make(`turn-${coordinates.threadId}`),
  }) as const;

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
  it.effect("records a fresh request and starts its turn on the default behaviors", () =>
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
        expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(threadCreated);
      }),
    ),
  );

  /*
    `process` is idempotent per sourceUri: a redelivery finds the recorded exchange and returns without touching T3 or the adapter.
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

        // And the stored exchange is still the one the first delivery produced.
        expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(threadCreated);
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

          expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(threadCreated);
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
    T3 refusing the target for good (a branch that is not on origin, say) is found out at planning, before anything from T3 exists.
    The request was already recorded, so the rejection becomes a failure reply like any other and is posted; the stored record never carries T3 coordinates.
  */
  it.effect("posts a failure reply when T3 rejects the request at planning", () => {
    const rejection = new FatalError({
      reason: "Branch 'nope' does not exist on origin",
      cause: null,
      method: "gitWorkflowService.resolveRemoteTrackingCommit",
    });

    return withProcessor(
      {
        t3Gateway: {
          planCoordinates: () => rejection,
        },
      },
      ({ processor, repository, calls }) =>
        Effect.gen(function* () {
          yield* processor.process(request, target);

          expect(calls.map((call) => `${call.service}.${call.method}`)).toEqual([
            "T3Gateway.planCoordinates",
            "NTBSAdapter.findPostedReply",
            "NTBSAdapter.postReply",
          ]);

          const replyPending = toRejected(accepted, rejection, now);
          expect(replyPending.reply).toEqual({
            type: "failure",
            text: rejection.reason,
            cause: {
              type: "rejected",
              method: rejection.method,
              state: { tag: "request-accepted" },
            },
          });
          expect(calls.at(-1)?.args).toEqual([replyPending]);
          expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(
            toReplyPosted(replyPending, postedReplyUri, now),
          );
        }),
    );
  });

  /*
    A transient planning failure happens after the request was recorded, so the record survives it: the delivery dies, the exchange stays RequestAccepted.
    A redelivery finds the record and plans nothing. The sweeper then re-plans from the record and drives the exchange on to its turn.
  */
  it.effect(
    "keeps an accepted request whose planning failed and re-plans it on the next sweep",
    () => {
      const turnStarted = Deferred.makeUnsafe<void>();
      let planCalls = 0;

      return withProcessor(
        {
          t3Gateway: {
            planCoordinates: () =>
              Effect.gen(function* () {
                planCalls += 1;
                if (planCalls === 1) {
                  return yield* new RetryableError({
                    reason: "Could not fetch origin",
                    cause: "test failure",
                    method: "planCoordinates",
                  });
                }
                return defaultWorkCoordinates;
              }),
            startTurn: () => Deferred.succeed(turnStarted, undefined),
          },
        },
        ({ processor, repository, calls }) =>
          Effect.gen(function* () {
            // Started first so that the sweep, not startup recovery, is what re-plans.
            const run = yield* processor.run.pipe(Effect.forkChild({ startImmediately: true }));
            yield* Effect.yieldNow;

            const exit = yield* Effect.exit(processor.process(request, target));
            expect(exit._tag).toBe("Failure");

            expect(calls.map((call) => `${call.service}.${call.method}`)).toEqual([
              "T3Gateway.planCoordinates",
            ]);
            expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(accepted);

            // Redelivery after acceptance does no planning.
            yield* processor.process(request, target);
            expect(calls.length).toBe(1);

            yield* TestClock.adjust("1 minute");
            yield* Deferred.await(turnStarted);

            expect(calls.map((call) => `${call.service}.${call.method}`)).toEqual([
              "T3Gateway.planCoordinates",
              // The sweep resumes from the record.
              "T3Gateway.planCoordinates",
              "T3Gateway.getThreadStatus",
              "T3Gateway.provisionThread",
              "NTBSAdapter.acknowledge",
              "T3Gateway.getTurnStatus",
              "T3Gateway.startTurn",
            ]);
            // The sweep re-planned a minute in, so its transitions carry that time.
            const sweptAt = yield* Clock.currentTimeMillis;
            expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(
              toThreadCreated(toWorkPlanned(accepted, defaultWorkCoordinates, sweptAt), sweptAt),
            );

            yield* Fiber.interrupt(run);
          }),
      );
    },
  );

  /*
    A transient provisioning failure leaves the exchange at WorkPlanned; the delivery dies, the record survives.
    Startup recovery then picks the exchange up where it stopped: it re-checks the thread, provisions it, and carries on to the turn.
    Planning is not repeated, the coordinates were already persisted.
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
          expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(planned);

          const run = yield* processor.run.pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(turnStarted);

          expect(calls.map((call) => `${call.service}.${call.method}`)).toEqual([
            "T3Gateway.planCoordinates",
            "T3Gateway.getThreadStatus",
            "T3Gateway.provisionThread",
            // Recovery resumes from the persisted plan.
            "T3Gateway.getThreadStatus",
            "T3Gateway.provisionThread",
            "NTBSAdapter.acknowledge",
            "T3Gateway.getTurnStatus",
            "T3Gateway.startTurn",
          ]);
          expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(threadCreated);

          yield* Fiber.interrupt(run);
        }),
    );
  });

  /*
    A transient turn-start failure happens after ThreadCreated was persisted, so the exchange stays there and the delivery dies.
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
    The first delivery is held inside planCoordinates with the request already recorded, so a naive second delivery would find the record and return while the first is still working on it.
    Instead it waits: no calls from it while the first is blocked, and once released the log shows a single pipeline, the second delivery having found the record and returned.
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
          expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(accepted);

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
          expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(threadCreated);
        }),
    );
  });

  /*
    The lock serializes, it does not couple outcomes.
    When the first delivery fails inside planCoordinates, the request was already recorded, so the queued delivery finds the record and returns without planning again; recovery, not the redelivery, finishes the pipeline.
  */
  it.effect("ignores a queued redelivery of an accepted request whose planning failed", () => {
    const firstPlanStarted = Deferred.makeUnsafe<void>();
    const releaseFirstPlan = Deferred.makeUnsafe<void>();
    const turnStarted = Deferred.makeUnsafe<void>();
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
          startTurn: () => Deferred.succeed(turnStarted, undefined),
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
          expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(accepted);

          yield* Deferred.succeed(releaseFirstPlan, undefined);
          expect((yield* Fiber.await(first))._tag).toBe("Failure");
          yield* Fiber.join(second);

          // The redelivery found the record and added nothing to the log.
          expect(calls.map((call) => `${call.service}.${call.method}`)).toEqual([
            "T3Gateway.planCoordinates",
          ]);
          expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(accepted);

          const run = yield* processor.run.pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(turnStarted);

          expect(calls.map((call) => `${call.service}.${call.method}`)).toEqual([
            "T3Gateway.planCoordinates",
            // Recovery plans again from the record.
            "T3Gateway.planCoordinates",
            "T3Gateway.getThreadStatus",
            "T3Gateway.provisionThread",
            "NTBSAdapter.acknowledge",
            "T3Gateway.getTurnStatus",
            "T3Gateway.startTurn",
          ]);
          expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(threadCreated);

          yield* Fiber.interrupt(run);
        }),
    );
  });

  /*
    The same, one step later: the first delivery fails inside getThreadStatus, after the plan was persisted.
    The queued redelivery finds the plan and returns without touching any service, and it is recovery, not the redelivery, that eventually finishes the pipeline.
  */
  it.effect("retains a persisted plan for later recovery and ignores its queued redelivery", () => {
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
                  reason: "Failed after persisting the plan",
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

          expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(planned);

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
          // A failed observation becomes an unknown context: leave the persisted
          // plan in place and let recovery decide whether to retry or expire it.
          expect((yield* Fiber.await(first))._tag).toBe("Success");
          yield* Fiber.join(second);

          // The redelivery found the plan and added nothing to the log.
          expect(calls.map((call) => `${call.service}.${call.method}`)).toEqual([
            "T3Gateway.planCoordinates",
            "T3Gateway.getThreadStatus",
          ]);
          expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(planned);

          const run = yield* processor.run.pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(turnStarted);

          expect(calls.map((call) => `${call.service}.${call.method}`)).toEqual([
            "T3Gateway.planCoordinates",
            "T3Gateway.getThreadStatus",
            // Recovery resumes from the persisted plan.
            "T3Gateway.getThreadStatus",
            "T3Gateway.provisionThread",
            "NTBSAdapter.acknowledge",
            "T3Gateway.getTurnStatus",
            "T3Gateway.startTurn",
          ]);
          expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(threadCreated);

          yield* Fiber.interrupt(run);
        }),
    );
  });

  /*
    Interruption must release the source lock like any other exit, otherwise one cancelled delivery would wedge its sourceUri forever.
    The first delivery is interrupted while holding the lock inside planCoordinates; the queued one then acquires it, finds the record the first one left, and returns.
  */
  it.effect("releases the source lock when its holder is interrupted", () => {
    const firstPlanStarted = Deferred.makeUnsafe<void>();
    const keepFirstPlanBlocked = Deferred.makeUnsafe<void>();

    return withProcessor(
      {
        t3Gateway: {
          planCoordinates: () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(firstPlanStarted, undefined);
              yield* Deferred.await(keepFirstPlanBlocked);
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
          expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(accepted);

          yield* Fiber.interrupt(first);
          yield* Fiber.join(second);

          // The queued delivery got the lock, found the record, and planned nothing.
          expect(calls.map((call) => `${call.service}.${call.method}`)).toEqual([
            "T3Gateway.planCoordinates",
          ]);
          expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(accepted);
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

          // The holder is unaffected: still blocked in planCoordinates, only the record stored.
          expect(first.pollUnsafe()).toBeUndefined();
          expect(calls.map((call) => `${call.service}.${call.method}`)).toEqual([
            "T3Gateway.planCoordinates",
          ]);
          expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(accepted);

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
          expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(threadCreated);
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
          expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(accepted);
          expect(yield* repository.findBySourceUri(secondRequest.sourceUri)).toEqual(
            secondThreadCreated,
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
          expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(threadCreated);
        }),
    );
  });

  /*
    Startup recovery walks every non-terminal exchange.
    A stored ThreadCreated whose turn has meanwhile completed is carried to ReplyPosted: the reply is looked up on the platform first, not found, then posted.
  */
  it.effect("resumes non-terminal exchanges when run starts", () => {
    const reply = answer("Recovered reply");

    return withProcessor(
      {
        t3Gateway: {
          getTurnStatus: () => Effect.succeed({ turn: "completed", reply }),
        },
      },
      ({ processor, repository, calls, awaitStoredTag }) =>
        Effect.gen(function* () {
          yield* repository.upsert(threadCreated);

          const run = yield* processor.run.pipe(Effect.forkChild({ startImmediately: true }));
          const posted = yield* awaitStoredTag(request.sourceUri, "reply-posted");

          expect(calls.map((call) => `${call.service}.${call.method}`)).toEqual([
            "T3Gateway.getTurnStatus",
            "NTBSAdapter.findPostedReply",
            "NTBSAdapter.postReply",
          ]);

          const replyPending = toReplyPending(threadCreated, reply, now);
          expect(calls.at(-1)?.args).toEqual([replyPending]);
          expect(posted).toEqual(toReplyPosted(replyPending, postedReplyUri, now));

          yield* Fiber.interrupt(run);
        }),
    );
  });

  /*
    Thread activity is routed by threadId. An unknown thread is dropped without any service call; a stored one gets its turn status re-read.
    Recovery sees the turn still active, so the reply only arrives through the ping.
  */
  it.effect("routes thread activity only for stored exchanges", () => {
    const reply = answer("Reply after thread activity");
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
            toReplyPosted(toReplyPending(threadCreated, reply, now), postedReplyUri, now),
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
    const reply = answer("Reply from thread activity");
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
            toReplyPosted(toReplyPending(threadCreated, reply, now), postedReplyUri, now),
          );

          yield* Fiber.interrupt(run);
        }),
    );
  });

  /*
    The happy path end to end: a fresh request whose thread already exists and whose turn completes immediately reaches ReplyPosted inside a single `process` call.
    The log shows provisioning skipped for the present thread, and the reply posted with the ReplyPending state the completed turn produced.
  */
  it.effect("posts a completed T3 reply", () => {
    const reply = answer("The bug is fixed.");

    return withProcessor(
      {
        t3Gateway: {
          getThreadStatus: () => Effect.succeed({ thread: "present" }),
          getTurnStatus: () => Effect.succeed({ turn: "completed", reply }),
        },
      },
      ({ processor, repository, calls }) =>
        Effect.gen(function* () {
          yield* processor.process(request, target);

          expect(calls.map((call) => `${call.service}.${call.method}`)).toEqual([
            "T3Gateway.planCoordinates",
            "T3Gateway.getThreadStatus",
            "NTBSAdapter.acknowledge",
            "T3Gateway.getTurnStatus",
            "NTBSAdapter.findPostedReply",
            "NTBSAdapter.postReply",
          ]);

          const replyPending = toReplyPending(threadCreated, reply, now);
          expect(calls.at(-1)?.args).toEqual([replyPending]);
          expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(
            toReplyPosted(replyPending, postedReplyUri, now),
          );
        }),
    );
  });

  /*
    Reply discovery guards against double posting.
    When the platform already shows the reply (a previous run posted it but crashed before persisting), the exchange is recorded as posted at the discovered URI and `postReply` is never called.
  */
  it.effect("records a reply already found on the platform without posting it again", () => {
    const reply = answer("Already delivered");
    const discoveredReplyUri = "test://reply/already-posted";

    return withProcessor(
      {
        adapter: {
          findPostedReply: () => Effect.succeed(discoveredReplyUri),
        },
      },
      ({ processor, repository, calls, awaitStoredTag }) =>
        Effect.gen(function* () {
          const replyPending = toReplyPending(threadCreated, reply, now);
          yield* repository.upsert(replyPending);

          const run = yield* processor.run.pipe(Effect.forkChild({ startImmediately: true }));
          const posted = yield* awaitStoredTag(request.sourceUri, "reply-posted");

          expect(calls.map((call) => `${call.service}.${call.method}`)).toEqual([
            "NTBSAdapter.findPostedReply",
          ]);
          expect(calls[0]?.args).toEqual([replyPending]);
          expect(posted).toEqual(toReplyPosted(replyPending, discoveredReplyUri, now));

          yield* Fiber.interrupt(run);
        }),
    );
  });

  /*
    `ReplyRejected` is the platform saying the reply can never land (the originating discussion is gone, say).
    Unlike an AdapterError, which leaves the exchange pending for a retry, a rejection is terminal: the exchange becomes Undeliverable with the platform's cause.
  */
  it.effect("records a definitively rejected reply as undeliverable", () => {
    const reply = answer("Reply that cannot be delivered");
    const rejectionCause = { message: "The originating discussion was deleted" };

    return withProcessor(
      {
        adapter: {
          postReply: () => new ReplyRejected({ cause: rejectionCause }),
        },
      },
      ({ processor, repository, calls, awaitStoredTag }) =>
        Effect.gen(function* () {
          const replyPending = toReplyPending(threadCreated, reply, now);
          yield* repository.upsert(replyPending);

          const run = yield* processor.run.pipe(Effect.forkChild({ startImmediately: true }));
          const undeliverable = yield* awaitStoredTag(request.sourceUri, "undeliverable");

          expect(calls.map((call) => `${call.service}.${call.method}`)).toEqual([
            "NTBSAdapter.findPostedReply",
            "NTBSAdapter.postReply",
          ]);
          expect(undeliverable).toEqual(toUndeliverable(replyPending, rejectionCause, now));

          yield* Fiber.interrupt(run);
        }),
    );
  });

  /*
    A `FatalError` from a T3 action means T3 will never accept the work, so retrying is pointless.
    The processor skips straight from the plan to a failure reply: no thread is created, so no acknowledgement and no turn; the user gets told why instead.
    The reply keeps the planned coordinates as its context, the stored exchange does not.
  */
  it.effect("delivers a failure reply when T3 rejects thread provisioning", () => {
    const rejection = new FatalError({
      reason: "T3 cannot provision this request",
      cause: { message: "The selected project no longer exists" },
      method: "provisionThread",
    });

    return withProcessor(
      {
        t3Gateway: {
          provisionThread: () => rejection,
        },
      },
      ({ processor, repository, calls }) =>
        Effect.gen(function* () {
          yield* processor.process(request, target);

          expect(calls.map((call) => `${call.service}.${call.method}`)).toEqual([
            "T3Gateway.planCoordinates",
            "T3Gateway.getThreadStatus",
            "T3Gateway.provisionThread",
            "NTBSAdapter.findPostedReply",
            "NTBSAdapter.postReply",
          ]);

          const replyPending = toRejected(planned, rejection, now);
          expect(replyPending.reply).toEqual({
            type: "failure",
            text: rejection.reason,
            cause: {
              type: "rejected",
              method: rejection.method,
              state: { tag: "work-planned", t3: defaultWorkCoordinates },
            },
          });
          expect(calls.at(-1)?.args).toEqual([replyPending]);
          expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(
            toReplyPosted(replyPending, postedReplyUri, now),
          );
        }),
    );
  });

  /*
    Recovery from ReplyPending, the one non-terminal state the other recovery tests never start from.
    A transient posting failure leaves the exchange pending; the next run repeats discovery and posting, and the second attempt lands.
  */
  it.effect("retries a transient reply-posting failure during later recovery", () => {
    const firstPostAttempted = Deferred.makeUnsafe<void>();
    const reply = answer("Reply after a transient posting failure");
    let postAttempts = 0;

    return withProcessor(
      {
        adapter: {
          postReply: () =>
            Effect.gen(function* () {
              postAttempts += 1;
              if (postAttempts === 1) {
                yield* Deferred.succeed(firstPostAttempted, undefined);
                return yield* new AdapterError({
                  reason: "Reply posting temporarily failed",
                  cause: "test failure",
                });
              }
              return postedReplyUri;
            }),
        },
      },
      ({ processor, repository, calls, awaitStoredTag }) =>
        Effect.gen(function* () {
          const replyPending = toReplyPending(threadCreated, reply, now);
          yield* repository.upsert(replyPending);

          const firstRun = yield* processor.run.pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(firstPostAttempted);
          yield* Effect.yieldNow;
          yield* Fiber.interrupt(firstRun);

          expect(calls.map((call) => `${call.service}.${call.method}`)).toEqual([
            "NTBSAdapter.findPostedReply",
            "NTBSAdapter.postReply",
          ]);
          expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(replyPending);

          const secondRun = yield* processor.run.pipe(Effect.forkChild({ startImmediately: true }));
          const posted = yield* awaitStoredTag(request.sourceUri, "reply-posted");

          expect(calls.map((call) => `${call.service}.${call.method}`)).toEqual([
            "NTBSAdapter.findPostedReply",
            "NTBSAdapter.postReply",
            "NTBSAdapter.findPostedReply",
            "NTBSAdapter.postReply",
          ]);
          expect(posted).toEqual(toReplyPosted(replyPending, postedReplyUri, now));

          yield* Fiber.interrupt(secondRun);
        }),
    );
  });
  /*
    `run` subscribes to thread activity before startup recovery, so a slow recovery does not delay live events.
    Recovery is held open on the first exchange's status read while a ping for a second exchange is delivered; the second reaches ReplyPosted with recovery still blocked.
  */
  it.effect("subscribes to thread activity before startup recovery finishes", () => {
    const recoveryStarted = Deferred.makeUnsafe<void>();
    const releaseRecovery = Deferred.makeUnsafe<void>();
    const reply = answer("Reply posted while startup recovery is blocked", secondWorkCoordinates);

    return withProcessor(
      {
        t3Gateway: {
          getTurnStatus: (state) =>
            state.sourceUri === request.sourceUri
              ? Effect.gen(function* () {
                  yield* Deferred.succeed(recoveryStarted, undefined);
                  yield* Deferred.await(releaseRecovery);
                  return { turn: "active" as const };
                })
              : Effect.succeed({ turn: "completed" as const, reply }),
        },
      },
      ({ processor, repository, calls, pingActivity, awaitStoredTag }) =>
        Effect.gen(function* () {
          yield* repository.upsert(threadCreated);

          const run = yield* processor.run.pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(recoveryStarted);

          // Stored only now, so recovery could not have picked it up: the ping is its only way forward.
          yield* repository.upsert(secondThreadCreated);
          yield* pingActivity(secondThreadId);
          const posted = yield* awaitStoredTag(secondRequest.sourceUri, "reply-posted");

          expect(calls.map((call) => `${call.service}.${call.method}`)).toEqual([
            "T3Gateway.getTurnStatus",
            "T3Gateway.getTurnStatus",
            "NTBSAdapter.findPostedReply",
            "NTBSAdapter.postReply",
          ]);
          expect(calls[0]?.args).toEqual([threadCreated]);
          expect(calls[1]?.args).toEqual([secondThreadCreated]);
          expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(threadCreated);
          expect(posted).toEqual(
            toReplyPosted(toReplyPending(secondThreadCreated, reply, now), postedReplyUri, now),
          );

          yield* Deferred.succeed(releaseRecovery, undefined);
          yield* Fiber.interrupt(run);
        }),
    );
  });

  /*
    An accepted request whose planning never succeeds is not retried forever.
    Once the record is older than its deadline the next run expires it instead of planning again: the user gets a failure reply, and a later sweep finds nothing left to do.
  */
  it.effect("expires an accepted request whose planning never succeeded", () =>
    withProcessor(
      {
        t3Gateway: {
          planCoordinates: () =>
            new RetryableError({
              reason: "Could not fetch origin",
              cause: "test failure",
              method: "planCoordinates",
            }),
        },
      },
      ({ processor, repository, calls, awaitStoredTag }) =>
        Effect.gen(function* () {
          const exit = yield* Effect.exit(processor.process(request, target));
          expect(exit._tag).toBe("Failure");
          expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(accepted);

          yield* TestClock.adjust("6 minutes");
          const expiredAt = yield* Clock.currentTimeMillis;

          const run = yield* processor.run.pipe(Effect.forkChild({ startImmediately: true }));
          const posted = yield* awaitStoredTag(request.sourceUri, "reply-posted");

          expect(calls.map((call) => `${call.service}.${call.method}`)).toEqual([
            "T3Gateway.planCoordinates",
            // Recovery expires the record instead of planning again.
            "NTBSAdapter.findPostedReply",
            "NTBSAdapter.postReply",
          ]);
          const replyPending = toExpired(accepted, expiredAt);
          expect(calls.at(-1)?.args).toEqual([replyPending]);
          expect(posted).toEqual(toReplyPosted(replyPending, postedReplyUri, expiredAt));

          yield* TestClock.adjust("1 minute");
          expect(calls.length).toBe(3);

          yield* Fiber.interrupt(run);
        }),
    ),
  );

  /*
    A turn T3 keeps reporting active is given up once ThreadCreated is older than its deadline.
    The failure reply keeps the coordinates, so later activity on that thread still finds the exchange, which is terminal and does nothing.
  */
  it.effect("expires a turn that never settles and ignores its later activity", () =>
    withProcessor(
      {
        t3Gateway: {
          getTurnStatus: () => Effect.succeed({ turn: "active" }),
        },
      },
      ({ processor, repository, calls, pingActivity, awaitStoredTag }) =>
        Effect.gen(function* () {
          yield* repository.upsert(threadCreated);

          yield* TestClock.adjust("61 minutes");
          const expiredAt = yield* Clock.currentTimeMillis;

          const run = yield* processor.run.pipe(Effect.forkChild({ startImmediately: true }));
          const posted = yield* awaitStoredTag(request.sourceUri, "reply-posted");

          expect(calls.map((call) => `${call.service}.${call.method}`)).toEqual([
            "T3Gateway.getTurnStatus",
            "NTBSAdapter.findPostedReply",
            "NTBSAdapter.postReply",
          ]);
          const replyPending = toExpired(threadCreated, expiredAt);
          expect(replyPending.reply).toEqual({
            type: "failure",
            text: "T3 did not answer in time.",
            cause: {
              type: "expired",
              state: { tag: "thread-created", t3: defaultWorkCoordinates },
            },
          });
          expect(posted).toEqual(toReplyPosted(replyPending, postedReplyUri, expiredAt));

          yield* pingActivity(defaultThreadId);
          yield* TestClock.adjust("1 minute");
          expect(calls.length).toBe(3);

          yield* Fiber.interrupt(run);
        }),
    ),
  );

  /*
    A reply the platform never accepts is given up once ReplyPending is older than its deadline: the exchange becomes Undeliverable without another posting attempt.
  */
  it.effect("gives up on a reply the platform never accepted", () =>
    withProcessor(
      {
        adapter: {
          postReply: () =>
            new AdapterError({ reason: "Reply posting failed", cause: "test failure" }),
        },
      },
      ({ processor, repository, calls, awaitStoredTag }) =>
        Effect.gen(function* () {
          const replyPending = toReplyPending(threadCreated, answer("Never delivered"), now);
          yield* repository.upsert(replyPending);

          yield* TestClock.adjust("61 minutes");
          const expiredAt = yield* Clock.currentTimeMillis;

          const run = yield* processor.run.pipe(Effect.forkChild({ startImmediately: true }));
          const undeliverable = yield* awaitStoredTag(request.sourceUri, "undeliverable");

          expect(calls.map((call) => `${call.service}.${call.method}`)).toEqual([
            "NTBSAdapter.findPostedReply",
          ]);
          expect(undeliverable).toEqual(
            toUndeliverable(
              replyPending,
              { message: "The platform did not accept the reply in time." },
              expiredAt,
            ),
          );

          yield* Fiber.interrupt(run);
        }),
    ),
  );

  /*
    A hung status read must not hold the exchange lock forever or start the action it was checking for.
    After the observe timeout the failed check becomes unknown, the decider waits, and a queued
    delivery of the same request can acquire the lock. Provisioning, a turn, and a second reply
    post stay unstarted.
    The timeout must not crash `run` either: the run fiber is the only thing that consumes thread
    activity, so after it we ping and require the exchange to be driven on to its reply. A run that
    died with the timeout would release the lock all the same and pass the earlier assertions, but
    it would never see the ping.
  */
  const settledReply = answer("Reply after the timeout");
  const hungReplyPending = toReplyPending(threadCreated, answer("Hung reply lookup"), now);

  it.effect.each([
    {
      observation: "T3Gateway.getThreadStatus",
      action: "T3Gateway.provisionThread",
      seed: planned,
      hang: (started: Deferred.Deferred<void>): ServiceInput => {
        let reads = 0;
        return {
          t3Gateway: {
            getThreadStatus: () => {
              reads += 1;
              return reads === 1
                ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))
                : Effect.succeed({ thread: "present" as const });
            },
            getTurnStatus: () =>
              Effect.succeed({ turn: "completed" as const, reply: settledReply }),
          },
        };
      },
      expectedCalls: [
        "T3Gateway.getThreadStatus",
        "T3Gateway.getThreadStatus",
        "NTBSAdapter.acknowledge",
        "T3Gateway.getTurnStatus",
        "NTBSAdapter.findPostedReply",
        "NTBSAdapter.postReply",
      ],
      expectedState: (at: number) =>
        toReplyPosted(
          toReplyPending(toThreadCreated(planned, at), settledReply, at),
          postedReplyUri,
          at,
        ),
    },
    {
      observation: "T3Gateway.getTurnStatus",
      action: "T3Gateway.startTurn",
      seed: threadCreated,
      hang: (started: Deferred.Deferred<void>): ServiceInput => {
        let reads = 0;
        return {
          t3Gateway: {
            getTurnStatus: () => {
              reads += 1;
              return reads === 1
                ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))
                : Effect.succeed({ turn: "completed" as const, reply: settledReply });
            },
          },
        };
      },
      expectedCalls: [
        "T3Gateway.getTurnStatus",
        "T3Gateway.getTurnStatus",
        "NTBSAdapter.findPostedReply",
        "NTBSAdapter.postReply",
      ],
      expectedState: (at: number) =>
        toReplyPosted(toReplyPending(threadCreated, settledReply, at), postedReplyUri, at),
    },
    {
      observation: "NTBSAdapter.findPostedReply",
      action: "NTBSAdapter.postReply",
      seed: hungReplyPending,
      hang: (started: Deferred.Deferred<void>): ServiceInput => {
        let reads = 0;
        return {
          adapter: {
            findPostedReply: () => {
              reads += 1;
              return reads === 1
                ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))
                : Effect.succeed(postedReplyUri);
            },
          },
        };
      },
      expectedCalls: ["NTBSAdapter.findPostedReply", "NTBSAdapter.findPostedReply"],
      expectedState: (at: number) => toReplyPosted(hungReplyPending, postedReplyUri, at),
    },
  ] as const)(
    "times out $observation, releases the lock, and does not call $action",
    ({ observation, seed, hang, expectedCalls, expectedState }) => {
      const started = Deferred.makeUnsafe<void>();

      return withProcessor(
        hang(started),
        ({ processor, repository, calls, pingActivity, awaitStoredTag }) =>
          Effect.gen(function* () {
            yield* repository.upsert(seed);

            const run = yield* processor.run.pipe(Effect.forkChild({ startImmediately: true }));
            yield* Deferred.await(started);

            const queued = yield* processor
              .process(request, target)
              .pipe(Effect.forkChild({ startImmediately: true }));
            yield* Effect.yieldNow;
            expect(queued.pollUnsafe()).toBeUndefined();

            yield* TestClock.adjust("10 seconds");
            yield* Fiber.join(queued);
            const resumedAt = yield* Clock.currentTimeMillis;

            // `run` is still alive: a crash would also have released the lock and let the queued
            // duplicate return, so the lock alone does not prove the timeout was survived.
            expect(run.pollUnsafe()).toBeUndefined();
            expect(calls.map((call) => `${call.service}.${call.method}`)).toEqual([observation]);
            expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(seed);

            // A later thread-activity ping proves `run` outlived the timeout: only a live run
            // consumes the ping and drives the exchange on from the state the timeout left.
            yield* pingActivity(defaultThreadId);
            yield* awaitStoredTag(request.sourceUri, "reply-posted");

            expect(calls.map((call) => `${call.service}.${call.method}`)).toEqual(expectedCalls);
            expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(
              expectedState(resumedAt),
            );

            yield* Fiber.interrupt(run);
          }),
      );
    },
  );

  /*
    A failed status check is only "wait" while the state still has time left. Once it is expired
    the failure must move the exchange to its terminal outcome instead: a failure reply posted for
    WorkPlanned and ThreadCreated, Undeliverable for ReplyPending. Whether the check fails at once
    or hangs, the outcome is the same; a failing or hung check must not strand the exchange past
    its deadline.
  */
  const neverCheckedReplyPending = toReplyPending(
    threadCreated,
    answer("A reply that was never checked"),
    now,
  );

  const expiredCheckScenarios = [
    {
      observation: "T3Gateway.getThreadStatus",
      seed: planned,
      fail: (): ServiceInput => ({
        t3Gateway: {
          getThreadStatus: () =>
            new RetryableError({
              reason: "Thread lookup failed",
              cause: "test failure",
              method: "getThreadStatus",
            }),
        },
      }),
      hang: (started: Deferred.Deferred<void>): ServiceInput => ({
        t3Gateway: {
          getThreadStatus: () =>
            Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
        },
      }),
      settledTag: "reply-posted" as const,
      expectedCalls: [
        "T3Gateway.getThreadStatus",
        "NTBSAdapter.findPostedReply",
        "NTBSAdapter.postReply",
      ],
      expectedState: (at: number) => toReplyPosted(toExpired(planned, at), postedReplyUri, at),
    },
    {
      observation: "T3Gateway.getTurnStatus",
      seed: threadCreated,
      fail: (): ServiceInput => ({
        t3Gateway: {
          getTurnStatus: () =>
            new RetryableError({
              reason: "Turn lookup failed",
              cause: "test failure",
              method: "getTurnStatus",
            }),
        },
      }),
      hang: (started: Deferred.Deferred<void>): ServiceInput => ({
        t3Gateway: {
          getTurnStatus: () =>
            Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
        },
      }),
      settledTag: "reply-posted" as const,
      expectedCalls: [
        "T3Gateway.getTurnStatus",
        "NTBSAdapter.findPostedReply",
        "NTBSAdapter.postReply",
      ],
      expectedState: (at: number) =>
        toReplyPosted(toExpired(threadCreated, at), postedReplyUri, at),
    },
    {
      observation: "NTBSAdapter.findPostedReply",
      seed: neverCheckedReplyPending,
      fail: (): ServiceInput => ({
        adapter: {
          findPostedReply: () =>
            new AdapterError({ reason: "Reply lookup failed", cause: "test failure" }),
        },
      }),
      hang: (started: Deferred.Deferred<void>): ServiceInput => ({
        adapter: {
          findPostedReply: () =>
            Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
        },
      }),
      settledTag: "undeliverable" as const,
      expectedCalls: ["NTBSAdapter.findPostedReply"],
      expectedState: (at: number) =>
        toUndeliverable(
          neverCheckedReplyPending,
          { message: "The platform did not accept the reply in time." },
          at,
        ),
    },
  ] as const;

  it.effect.each(expiredCheckScenarios)(
    "expires an exchange to its terminal outcome when $observation fails after expiry",
    ({ seed, fail, settledTag, expectedCalls, expectedState }) =>
      withProcessor(fail(), ({ processor, repository, calls, awaitStoredTag }) =>
        Effect.gen(function* () {
          yield* repository.upsert(seed);

          yield* TestClock.adjust("61 minutes");
          const expiredAt = yield* Clock.currentTimeMillis;

          const run = yield* processor.run.pipe(Effect.forkChild({ startImmediately: true }));
          yield* awaitStoredTag(request.sourceUri, settledTag);

          expect(calls.map((call) => `${call.service}.${call.method}`)).toEqual(expectedCalls);
          expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(
            expectedState(expiredAt),
          );

          yield* Fiber.interrupt(run);
        }),
      ),
  );

  /*
    The hung variant: the state is already expired when the check hangs, so the observation runs
    to the observe timeout and the failure becomes unknown. Expiry, not the hang, decides the
    outcome.
  */
  it.effect.each(expiredCheckScenarios)(
    "expires an exchange to its terminal outcome when $observation hangs after expiry",
    ({ seed, hang, settledTag, expectedCalls, expectedState }) => {
      const started = Deferred.makeUnsafe<void>();

      return withProcessor(hang(started), ({ processor, repository, calls, awaitStoredTag }) =>
        Effect.gen(function* () {
          yield* repository.upsert(seed);

          yield* TestClock.adjust("61 minutes");

          const run = yield* processor.run.pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(started);

          yield* TestClock.adjust("10 seconds");
          const expiredAt = yield* Clock.currentTimeMillis;

          yield* awaitStoredTag(request.sourceUri, settledTag);

          expect(calls.map((call) => `${call.service}.${call.method}`)).toEqual(expectedCalls);
          expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(
            expectedState(expiredAt),
          );

          yield* Fiber.interrupt(run);
        }),
      );
    },
  );

  /*
    Confirmed completion is recorded even after the state's deadline. A present thread is
    recorded, a completed turn yields its reply, and a reply already on the platform is recorded
    as posted instead of expiring or posting again.
  */
  const discoveredPostedReplyUri = "test://reply/discovered-after-expiry";
  const lateReplyPending = toReplyPending(
    threadCreated,
    answer("A reply the platform already accepted"),
    now,
  );

  it.effect.each([
    {
      observation: "T3Gateway.getThreadStatus",
      seed: planned,
      succeed: (): ServiceInput => ({
        t3Gateway: {
          getThreadStatus: () => Effect.succeed({ thread: "present" as const }),
          getTurnStatus: () => Effect.succeed({ turn: "completed" as const, reply: settledReply }),
        },
      }),
      expectedCalls: [
        "T3Gateway.getThreadStatus",
        "NTBSAdapter.acknowledge",
        "T3Gateway.getTurnStatus",
        "NTBSAdapter.findPostedReply",
        "NTBSAdapter.postReply",
      ],
      expectedState: (at: number) =>
        toReplyPosted(
          toReplyPending(toThreadCreated(planned, at), settledReply, at),
          postedReplyUri,
          at,
        ),
    },
    {
      observation: "T3Gateway.getTurnStatus",
      seed: threadCreated,
      succeed: (): ServiceInput => ({
        t3Gateway: {
          getTurnStatus: () => Effect.succeed({ turn: "completed" as const, reply: settledReply }),
        },
      }),
      expectedCalls: [
        "T3Gateway.getTurnStatus",
        "NTBSAdapter.findPostedReply",
        "NTBSAdapter.postReply",
      ],
      expectedState: (at: number) =>
        toReplyPosted(toReplyPending(threadCreated, settledReply, at), postedReplyUri, at),
    },
    {
      observation: "NTBSAdapter.findPostedReply",
      seed: lateReplyPending,
      succeed: (): ServiceInput => ({
        adapter: {
          findPostedReply: () => Effect.succeed(discoveredPostedReplyUri),
        },
      }),
      expectedCalls: ["NTBSAdapter.findPostedReply"],
      expectedState: (at: number) => toReplyPosted(lateReplyPending, discoveredPostedReplyUri, at),
    },
  ] as const)(
    "records the confirmed result of a $observation check that succeeds after expiry",
    ({ seed, succeed, expectedCalls, expectedState }) =>
      withProcessor(succeed(), ({ processor, repository, calls, awaitStoredTag }) =>
        Effect.gen(function* () {
          yield* repository.upsert(seed);

          yield* TestClock.adjust("61 minutes");
          const confirmedAt = yield* Clock.currentTimeMillis;

          const run = yield* processor.run.pipe(Effect.forkChild({ startImmediately: true }));
          yield* awaitStoredTag(request.sourceUri, "reply-posted");

          expect(calls.map((call) => `${call.service}.${call.method}`)).toEqual(expectedCalls);
          expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(
            expectedState(confirmedAt),
          );

          yield* Fiber.interrupt(run);
        }),
      ),
  );

  /*
    Planning has its own timeout, shorter than the state's deadline. A plan that hangs is
    abandoned at that timeout: nothing transitions, no coordinates are invented, and the record
    stays RequestAccepted for a later pass. That pass either plans for real if the deadline has
    not passed, or expires the record once it has.
  */
  it.effect.each([
    {
      outcome: "re-plans and finishes",
      laterAdvance: "1 minute",
      expectedCalls: [
        "T3Gateway.planCoordinates",
        "T3Gateway.planCoordinates",
        "T3Gateway.getThreadStatus",
        "NTBSAdapter.acknowledge",
        "T3Gateway.getTurnStatus",
        "NTBSAdapter.findPostedReply",
        "NTBSAdapter.postReply",
      ],
      expectedState: (at: number) =>
        toReplyPosted(
          toReplyPending(
            toThreadCreated(toWorkPlanned(accepted, defaultWorkCoordinates, at), at),
            settledReply,
            at,
          ),
          postedReplyUri,
          at,
        ),
    },
    {
      outcome: "expires",
      laterAdvance: "5 minutes",
      expectedCalls: [
        "T3Gateway.planCoordinates",
        "NTBSAdapter.findPostedReply",
        "NTBSAdapter.postReply",
      ],
      expectedState: (at: number) => toReplyPosted(toExpired(accepted, at), postedReplyUri, at),
    },
  ] as const)(
    "leaves RequestAccepted after a planning timeout, and a later pass $outcome",
    ({ laterAdvance, expectedCalls, expectedState }) => {
      const planStarted = Deferred.makeUnsafe<void>();
      let planCalls = 0;

      return withProcessor(
        {
          t3Gateway: {
            planCoordinates: () => {
              planCalls += 1;
              return planCalls === 1
                ? Deferred.succeed(planStarted, undefined).pipe(Effect.andThen(Effect.never))
                : Effect.succeed(defaultWorkCoordinates);
            },
            getThreadStatus: () => Effect.succeed({ thread: "present" }),
            getTurnStatus: () => Effect.succeed({ turn: "completed", reply: settledReply }),
          },
        },
        ({ processor, repository, calls, awaitStoredTag }) =>
          Effect.gen(function* () {
            const first = yield* processor
              .process(request, target)
              .pipe(Effect.forkChild({ startImmediately: true }));
            yield* Deferred.await(planStarted);

            // The planning timeout is one minute, well under the state's five. The attempt must
            // fail for that reason, not merely fail.
            yield* TestClock.adjust("1 minute");
            const exit = yield* Fiber.await(first);
            expect(Exit.isFailure(exit)).toBe(true);
            if (Exit.isFailure(exit)) {
              const defect = Cause.squash(exit.cause);
              expect(defect).toBeInstanceOf(NTBSProcessorError);
              if (defect instanceof NTBSProcessorError) {
                expect(defect.reason).toBe("Failed to plan the T3 work");
                expect(Cause.isTimeoutError(defect.cause)).toBe(true);
              }
            }

            expect(calls.map((call) => `${call.service}.${call.method}`)).toEqual([
              "T3Gateway.planCoordinates",
            ]);
            expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(accepted);

            yield* TestClock.adjust(laterAdvance);
            const at = yield* Clock.currentTimeMillis;

            const run = yield* processor.run.pipe(Effect.forkChild({ startImmediately: true }));
            yield* awaitStoredTag(request.sourceUri, "reply-posted");

            expect(calls.map((call) => `${call.service}.${call.method}`)).toEqual(expectedCalls);
            expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(expectedState(at));

            yield* Fiber.interrupt(run);
          }),
      );
    },
  );

  /*
    Provisioning has its own timeout too. A hung provision is abandoned at that timeout and the
    exchange stays WorkPlanned, with no second provision attempted; the next pass observes before
    acting. A thread the timed-out provision had in fact already created (the dispatch committed,
    the call just never returned) is then discovered and recorded rather than provisioned again.
    The worktree itself is untouched here: compensation lives inside the gateway, and only the
    gateway's own test can see it.
  */
  it.effect(
    "leaves WorkPlanned after a provisioning timeout and later discovers a created thread",
    () => {
      const provisionStarted = Deferred.makeUnsafe<void>();
      let threadStatusReads = 0;

      return withProcessor(
        {
          t3Gateway: {
            getThreadStatus: () => {
              threadStatusReads += 1;
              return Effect.succeed(
                threadStatusReads === 1
                  ? { thread: "missing" as const }
                  : { thread: "present" as const },
              );
            },
            provisionThread: () =>
              Deferred.succeed(provisionStarted, undefined).pipe(Effect.andThen(Effect.never)),
            getTurnStatus: () =>
              Effect.succeed({ turn: "completed" as const, reply: settledReply }),
          },
        },
        ({ processor, repository, calls, awaitStoredTag }) =>
          Effect.gen(function* () {
            const first = yield* processor
              .process(request, target)
              .pipe(Effect.forkChild({ startImmediately: true }));
            yield* Deferred.await(provisionStarted);

            // Provisioning has five minutes, less than the state's fifteen.
            yield* TestClock.adjust("5 minutes");
            const exit = yield* Fiber.await(first);
            expect(Exit.isFailure(exit)).toBe(true);
            if (Exit.isFailure(exit)) {
              const defect = Cause.squash(exit.cause);
              expect(defect).toBeInstanceOf(NTBSProcessorError);
              if (defect instanceof NTBSProcessorError) {
                expect(defect.reason).toBe("Failed to provision the T3 thread");
                expect(Cause.isTimeoutError(defect.cause)).toBe(true);
              }
            }

            // The plan survived the timeout and only the one provision was attempted.
            expect(calls.map((call) => `${call.service}.${call.method}`)).toEqual([
              "T3Gateway.planCoordinates",
              "T3Gateway.getThreadStatus",
              "T3Gateway.provisionThread",
            ]);
            expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(planned);

            const at = yield* Clock.currentTimeMillis;

            const run = yield* processor.run.pipe(Effect.forkChild({ startImmediately: true }));
            yield* awaitStoredTag(request.sourceUri, "reply-posted");

            // The second observation found the thread present, so provisioning was not repeated.
            expect(calls.map((call) => `${call.service}.${call.method}`)).toEqual([
              "T3Gateway.planCoordinates",
              "T3Gateway.getThreadStatus",
              "T3Gateway.provisionThread",
              "T3Gateway.getThreadStatus",
              "NTBSAdapter.acknowledge",
              "T3Gateway.getTurnStatus",
              "NTBSAdapter.findPostedReply",
              "NTBSAdapter.postReply",
            ]);
            expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(
              toReplyPosted(
                toReplyPending(toThreadCreated(planned, at), settledReply, at),
                postedReplyUri,
                at,
              ),
            );

            yield* Fiber.interrupt(run);
          }),
      );
    },
  );

  /*
    Turn start has its own timeout too. A hung start is abandoned at that timeout, the exchange
    stays ThreadCreated, and no second start is attempted. The next pass observes first, so a turn
    the timed-out start had in fact already begun (the dispatch committed, the call just never
    returned) is discovered rather than started twice.
  */
  it.effect("leaves ThreadCreated after a turn-start timeout and later discovers the turn", () => {
    const startStarted = Deferred.makeUnsafe<void>();
    let turnStatusReads = 0;

    return withProcessor(
      {
        t3Gateway: {
          getThreadStatus: () => Effect.succeed({ thread: "present" }),
          getTurnStatus: () => {
            turnStatusReads += 1;
            return Effect.succeed(
              turnStatusReads === 1
                ? { turn: "missing" as const }
                : { turn: "completed" as const, reply: settledReply },
            );
          },
          startTurn: () =>
            Deferred.succeed(startStarted, undefined).pipe(Effect.andThen(Effect.never)),
        },
      },
      ({ processor, repository, calls, awaitStoredTag }) =>
        Effect.gen(function* () {
          const first = yield* processor
            .process(request, target)
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(startStarted);

          // Turn start has thirty seconds, well under the state's hour.
          yield* TestClock.adjust("30 seconds");
          const exit = yield* Fiber.await(first);
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const defect = Cause.squash(exit.cause);
            expect(defect).toBeInstanceOf(NTBSProcessorError);
            if (defect instanceof NTBSProcessorError) {
              expect(defect.reason).toBe("Failed to start the T3 turn");
              expect(Cause.isTimeoutError(defect.cause)).toBe(true);
            }
          }

          expect(calls.map((call) => `${call.service}.${call.method}`)).toEqual([
            "T3Gateway.planCoordinates",
            "T3Gateway.getThreadStatus",
            "NTBSAdapter.acknowledge",
            "T3Gateway.getTurnStatus",
            "T3Gateway.startTurn",
          ]);
          expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(threadCreated);

          const at = yield* Clock.currentTimeMillis;

          const run = yield* processor.run.pipe(Effect.forkChild({ startImmediately: true }));
          yield* awaitStoredTag(request.sourceUri, "reply-posted");

          // The second observation found the turn, so it was not started a second time.
          expect(calls.map((call) => `${call.service}.${call.method}`)).toEqual([
            "T3Gateway.planCoordinates",
            "T3Gateway.getThreadStatus",
            "NTBSAdapter.acknowledge",
            "T3Gateway.getTurnStatus",
            "T3Gateway.startTurn",
            "T3Gateway.getTurnStatus",
            "NTBSAdapter.findPostedReply",
            "NTBSAdapter.postReply",
          ]);
          expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(
            toReplyPosted(toReplyPending(threadCreated, settledReply, at), postedReplyUri, at),
          );

          yield* Fiber.interrupt(run);
        }),
    );
  });

  /*
    Posting has its own timeout too. A hung post is abandoned at that timeout, the exchange stays
    ReplyPending, and no second post is attempted. The next pass observes first, so a reply the
    timed-out post had in fact already delivered (the platform accepted it, the call just never
    returned) is found on the platform and recorded instead of posted again.
  */
  it.effect("leaves ReplyPending after a reply-post timeout and later discovers the reply", () => {
    const postStarted = Deferred.makeUnsafe<void>();
    const discoveredReplyUri = "test://reply/posted-before-timeout";
    let findReads = 0;

    return withProcessor(
      {
        t3Gateway: {
          getThreadStatus: () => Effect.succeed({ thread: "present" }),
          getTurnStatus: () => Effect.succeed({ turn: "completed", reply: settledReply }),
        },
        adapter: {
          findPostedReply: () => {
            findReads += 1;
            return Effect.succeed(findReads === 1 ? null : discoveredReplyUri);
          },
          postReply: () =>
            Deferred.succeed(postStarted, undefined).pipe(Effect.andThen(Effect.never)),
        },
      },
      ({ processor, repository, calls, awaitStoredTag }) =>
        Effect.gen(function* () {
          const first = yield* processor
            .process(request, target)
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(postStarted);

          // Posting has thirty seconds, well under the state's hour.
          yield* TestClock.adjust("30 seconds");
          const exit = yield* Fiber.await(first);
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const defect = Cause.squash(exit.cause);
            expect(defect).toBeInstanceOf(NTBSProcessorError);
            if (defect instanceof NTBSProcessorError) {
              expect(defect.reason).toBe("Failed to post the platform reply");
              expect(Cause.isTimeoutError(defect.cause)).toBe(true);
            }
          }

          expect(calls.map((call) => `${call.service}.${call.method}`)).toEqual([
            "T3Gateway.planCoordinates",
            "T3Gateway.getThreadStatus",
            "NTBSAdapter.acknowledge",
            "T3Gateway.getTurnStatus",
            "NTBSAdapter.findPostedReply",
            "NTBSAdapter.postReply",
          ]);
          const replyPending = toReplyPending(threadCreated, settledReply, now);
          expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(replyPending);

          const at = yield* Clock.currentTimeMillis;

          const run = yield* processor.run.pipe(Effect.forkChild({ startImmediately: true }));
          yield* awaitStoredTag(request.sourceUri, "reply-posted");

          // The second lookup found the reply, so it was not posted a second time.
          expect(calls.map((call) => `${call.service}.${call.method}`)).toEqual([
            "T3Gateway.planCoordinates",
            "T3Gateway.getThreadStatus",
            "NTBSAdapter.acknowledge",
            "T3Gateway.getTurnStatus",
            "NTBSAdapter.findPostedReply",
            "NTBSAdapter.postReply",
            "NTBSAdapter.findPostedReply",
          ]);
          expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(
            toReplyPosted(replyPending, discoveredReplyUri, at),
          );

          yield* Fiber.interrupt(run);
        }),
    );
  });

  /*
    The acknowledgement is best-effort and not part of the durable exchange. A hung one is cut
    off at its own timeout and swallowed, never undoing the ThreadCreated state that was already
    persisted before it was attempted. The pipeline simply carries on to the turn.
  */
  it.effect("keeps ThreadCreated when the acknowledgement times out", () => {
    const acknowledgeStarted = Deferred.makeUnsafe<void>();

    return withProcessor(
      {
        t3Gateway: {
          getThreadStatus: () => Effect.succeed({ thread: "present" }),
        },
        adapter: {
          acknowledge: () =>
            Deferred.succeed(acknowledgeStarted, undefined).pipe(Effect.andThen(Effect.never)),
        },
      },
      ({ processor, repository, calls }) =>
        Effect.gen(function* () {
          const pump = yield* processor
            .process(request, target)
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(acknowledgeStarted);

          // Persisted before the acknowledgement was even attempted.
          expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(threadCreated);

          yield* TestClock.adjust("10 seconds");
          yield* Fiber.join(pump);

          // The timeout was swallowed and the pipeline continued as if the acknowledgement failed.
          expect(calls.map((call) => `${call.service}.${call.method}`)).toEqual([
            "T3Gateway.planCoordinates",
            "T3Gateway.getThreadStatus",
            "NTBSAdapter.acknowledge",
            "T3Gateway.getTurnStatus",
            "T3Gateway.startTurn",
          ]);
          expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(threadCreated);
        }),
    );
  });

  /*
    An action may not outlive the deadline of the state it acts on. `act` gives the underlying
    effect `min(its own limit, time left on the state)`, so a state already close to its deadline
    cannot be held open for the full length of an action whose own limit is longer.
  */
  it.effect("gives an action no more than the time remaining before its deadline", () => {
    const startTurnStarted = Deferred.makeUnsafe<void>();
    const startTurnInterrupted = Deferred.makeUnsafe<void>();

    return withProcessor(
      {
        t3Gateway: {
          startTurn: () =>
            Deferred.succeed(startTurnStarted, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() => Deferred.succeed(startTurnInterrupted, undefined)),
            ),
        },
      },
      ({ processor, repository, calls }) =>
        Effect.gen(function* () {
          yield* repository.upsert(threadCreated);

          // Ten seconds left before ThreadCreated expires, well under startTurn's thirty.
          yield* TestClock.adjust("3590 seconds");

          const run = yield* processor.run.pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(startTurnStarted);

          // One second short of the deadline: the action is still running, uncut.
          yield* TestClock.adjust("9 seconds");
          yield* Effect.yieldNow;
          expect(Deferred.isDoneUnsafe(startTurnInterrupted)).toBe(false);

          // At the deadline it is cut off, exactly as the state expires.
          yield* TestClock.adjust("1 second");
          yield* Effect.yieldNow;
          expect(Deferred.isDoneUnsafe(startTurnInterrupted)).toBe(true);

          expect(calls.map((call) => `${call.service}.${call.method}`)).toEqual([
            "T3Gateway.getTurnStatus",
            "T3Gateway.startTurn",
          ]);
          expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(threadCreated);

          yield* Fiber.interrupt(run);
        }),
    );
  });

  /*
    A timeout is not an outcome. It leaves the exchange exactly where it was, writing no failure
    reply and cleaning up nothing. The next observation decides what actually happened.
  */
  it.effect("leaves the outcome to the next observation after an action timeout", () => {
    const startTurnStarted = Deferred.makeUnsafe<void>();
    const startTurnInterrupted = Deferred.makeUnsafe<void>();

    return withProcessor(
      {
        t3Gateway: {
          startTurn: () =>
            Deferred.succeed(startTurnStarted, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() => Deferred.succeed(startTurnInterrupted, undefined)),
            ),
        },
      },
      ({ processor, repository, calls, pingActivity, awaitStoredTag }) =>
        Effect.gen(function* () {
          yield* repository.upsert(threadCreated);

          // Ten seconds left, so the turn-start timeout lands exactly on the deadline.
          yield* TestClock.adjust("3590 seconds");

          const run = yield* processor.run.pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(startTurnStarted);
          yield* TestClock.adjust("10 seconds");
          yield* Effect.yieldNow;

          // The timeout wrote nothing: still the same non-terminal record, no reply.
          expect(Deferred.isDoneUnsafe(startTurnInterrupted)).toBe(true);
          expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(threadCreated);

          // The next observation decides: the turn is still missing and the deadline has passed,
          // so the exchange expires to its failure reply.
          yield* pingActivity(defaultThreadId);
          yield* awaitStoredTag(request.sourceUri, "reply-posted");

          const at = yield* Clock.currentTimeMillis;
          expect(calls.map((call) => `${call.service}.${call.method}`)).toEqual([
            "T3Gateway.getTurnStatus",
            "T3Gateway.startTurn",
            "T3Gateway.getTurnStatus",
            "NTBSAdapter.findPostedReply",
            "NTBSAdapter.postReply",
          ]);
          expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(
            toReplyPosted(toExpired(threadCreated, at), postedReplyUri, at),
          );

          yield* Fiber.interrupt(run);
        }),
    );
  });

  /* An expired request skips planning and proceeds to its failure reply. */
  it.effect("does not start an action for a state that is already expired", () => {
    return withProcessor({}, ({ processor, repository, calls, awaitStoredTag }) =>
      Effect.gen(function* () {
        yield* repository.upsert(accepted);

        yield* TestClock.adjust("5 minutes");

        const run = yield* processor.run.pipe(Effect.forkChild({ startImmediately: true }));
        yield* awaitStoredTag(request.sourceUri, "reply-posted");

        const at = yield* Clock.currentTimeMillis;
        // Planning never ran: the exchange expired to its failure reply instead.
        expect(calls.map((call) => `${call.service}.${call.method}`)).toEqual([
          "NTBSAdapter.findPostedReply",
          "NTBSAdapter.postReply",
        ]);
        expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(
          toReplyPosted(toExpired(accepted, at), postedReplyUri, at),
        );

        yield* Fiber.interrupt(run);
      }),
    );
  });

  /*
    The sweeper is the backstop for a timeout nothing else wakes. After the timed-out attempt
    leaves the exchange untouched, the next sweep re-drives it and a fresh observation finishes it.
  */
  it.effect("re-drives a timed-out exchange from the sweeper", () => {
    const startTurnStarted = Deferred.makeUnsafe<void>();
    const reply = answer("Reply after the sweep");
    let turnStatusReads = 0;

    return withProcessor(
      {
        t3Gateway: {
          getTurnStatus: () => {
            turnStatusReads += 1;
            return Effect.succeed(
              turnStatusReads === 1
                ? { turn: "missing" as const }
                : { turn: "completed" as const, reply },
            );
          },
          startTurn: () =>
            Deferred.succeed(startTurnStarted, undefined).pipe(Effect.andThen(Effect.never)),
        },
      },
      ({ processor, repository, calls, awaitStoredTag }) =>
        Effect.gen(function* () {
          yield* repository.upsert(threadCreated);

          const run = yield* processor.run.pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(startTurnStarted);

          // The attempt times out with the record untouched; nothing else wakes it.
          yield* TestClock.adjust("30 seconds");
          yield* Effect.yieldNow;
          expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(threadCreated);

          // One sweep interval after recovery finished, the sweeper picks it up again.
          yield* TestClock.adjust("1 minute");
          yield* awaitStoredTag(request.sourceUri, "reply-posted");

          const at = yield* Clock.currentTimeMillis;
          expect(calls.map((call) => `${call.service}.${call.method}`)).toEqual([
            "T3Gateway.getTurnStatus",
            "T3Gateway.startTurn",
            "T3Gateway.getTurnStatus",
            "NTBSAdapter.findPostedReply",
            "NTBSAdapter.postReply",
          ]);
          expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(
            toReplyPosted(toReplyPending(threadCreated, reply, at), postedReplyUri, at),
          );

          yield* Fiber.interrupt(run);
        }),
    );
  });

  /*
    Thread activity wakes a timed-out exchange too. The ping arrives after the timed-out attempt,
    re-runs the observation, and the confirmed result finishes the exchange.
  */
  it.effect("re-drives a timed-out exchange from a thread-activity event", () => {
    const startTurnStarted = Deferred.makeUnsafe<void>();
    const reply = answer("Reply after the activity ping");
    let turnStatusReads = 0;

    return withProcessor(
      {
        t3Gateway: {
          getTurnStatus: () => {
            turnStatusReads += 1;
            return Effect.succeed(
              turnStatusReads === 1
                ? { turn: "missing" as const }
                : { turn: "completed" as const, reply },
            );
          },
          startTurn: () =>
            Deferred.succeed(startTurnStarted, undefined).pipe(Effect.andThen(Effect.never)),
        },
      },
      ({ processor, repository, calls, pingActivity, awaitStoredTag }) =>
        Effect.gen(function* () {
          yield* repository.upsert(threadCreated);

          const run = yield* processor.run.pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(startTurnStarted);
          yield* TestClock.adjust("30 seconds");
          yield* Effect.yieldNow;
          expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(threadCreated);

          yield* pingActivity(defaultThreadId);
          yield* awaitStoredTag(request.sourceUri, "reply-posted");

          const at = yield* Clock.currentTimeMillis;
          expect(calls.map((call) => `${call.service}.${call.method}`)).toEqual([
            "T3Gateway.getTurnStatus",
            "T3Gateway.startTurn",
            "T3Gateway.getTurnStatus",
            "NTBSAdapter.findPostedReply",
            "NTBSAdapter.postReply",
          ]);
          expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(
            toReplyPosted(toReplyPending(threadCreated, reply, at), postedReplyUri, at),
          );

          yield* Fiber.interrupt(run);
        }),
    );
  });

  /*
    A delivery queued behind a timed-out one is not stranded: the timeout releases the source lock
    like any other exit, and the queued delivery then finds the recorded request and returns.
  */
  it.effect("lets a queued delivery proceed once the first attempt times out", () => {
    const planStarted = Deferred.makeUnsafe<void>();

    return withProcessor(
      {
        t3Gateway: {
          planCoordinates: () =>
            Deferred.succeed(planStarted, undefined).pipe(Effect.andThen(Effect.never)),
        },
      },
      ({ processor, repository, calls }) =>
        Effect.gen(function* () {
          const first = yield* processor
            .process(request, target)
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(planStarted);

          const second = yield* processor
            .process(request, target)
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Effect.yieldNow;

          // Parked behind the first delivery's lock.
          expect(second.pollUnsafe()).toBeUndefined();

          // Planning's timeout is a minute, well inside the state's five.
          yield* TestClock.adjust("1 minute");
          expect((yield* Fiber.await(first))._tag).toBe("Failure");
          yield* Fiber.join(second);

          // The queued delivery found the record and planned nothing.
          expect(calls.map((call) => `${call.service}.${call.method}`)).toEqual([
            "T3Gateway.planCoordinates",
          ]);
          expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(accepted);
        }),
    );
  });

  /*
    A timeout is contained to its own exchange. The run keeps going after one: a second exchange
    stored only after the first has timed out is still swept and reaches its reply.
  */
  it.effect("does not let one timed-out exchange stop the others", () => {
    const startTurnStarted = Deferred.makeUnsafe<void>();
    const reply = answer("Reply from the untroubled exchange", secondWorkCoordinates);
    let startTurnCalls = 0;

    return withProcessor(
      {
        t3Gateway: {
          getTurnStatus: (state) =>
            state.sourceUri === secondRequest.sourceUri
              ? Effect.succeed({ turn: "completed" as const, reply })
              : Effect.succeed({ turn: "missing" as const }),
          // The stuck exchange hangs on its first turn start; later attempts are fine.
          startTurn: (state) => {
            if (state.sourceUri !== request.sourceUri) {
              return Effect.void;
            }
            startTurnCalls += 1;
            return startTurnCalls === 1
              ? Deferred.succeed(startTurnStarted, undefined).pipe(Effect.andThen(Effect.never))
              : Effect.void;
          },
        },
      },
      ({ processor, repository, awaitStoredTag }) =>
        Effect.gen(function* () {
          yield* repository.upsert(threadCreated);

          const run = yield* processor.run.pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(startTurnStarted);

          // The stuck exchange times out during startup recovery, leaving the record untouched.
          yield* TestClock.adjust("30 seconds");
          yield* Effect.yieldNow;
          expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(threadCreated);

          // Stored only now, so the sweeper is the only thing that can reach it. That it arrives
          // at its reply proves the run survived the other exchange's timeout.
          yield* repository.upsert(secondThreadCreated);
          yield* TestClock.adjust("1 minute");
          yield* awaitStoredTag(secondRequest.sourceUri, "reply-posted");

          expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(threadCreated);

          yield* Fiber.interrupt(run);
        }),
    );
  });
});
