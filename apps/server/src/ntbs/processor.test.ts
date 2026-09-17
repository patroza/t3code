import { describe, expect, it } from "@effect/vitest";
import { Clock, Deferred, Effect, Fiber, Layer, Queue, Stream } from "effect";
import { TestClock } from "effect/testing";
import {
  ExchangeRepository,
  ExchangeRepositoryError,
  inMemoryExchangeRepository,
} from "./ExchangeRepository.ts";
import { makeNTBSProcessor, type NTBSProcessor } from "./processor.ts";
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
  /**
   * Overrides for the repository: the properties to replace, or a builder that receives the real in-memory repository so an override can gate a call and then delegate it. Everything not overridden stays the real in-memory repository.
   */
  readonly repository?:
    | Partial<ExchangeRepository>
    | ((base: ExchangeRepository) => Partial<ExchangeRepository>);
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
  /** How many times the processor asked the repository to resolve a thread id, the lookup a busy retry loop would repeat. */
  readonly findByThreadIdCalls: () => number;
  /**
   * Waits until the shared call log holds at least `count` entries. The mocks are synchronous, so the log is how the background pass's progress can be observed from the test.
   */
  readonly awaitCalls: (count: number) => Effect.Effect<void>;
  /**
   * Yields until neither the service-call log nor the repository's thread lookups have changed for `SETTLE_TICKS` consecutive turns. Use it before asserting that something did *not* happen: a single `yieldNow` can be outrun by a wrongly scheduled call, which would let the assertion pass vacuously.
   */
  readonly settle: () => Effect.Effect<void>;
  /** Waits until the processor resolved threads at least `count` times. A recovered pass that keeps re-resolving a thread shows up here. */
  readonly awaitThreadLookups: (count: number) => Effect.Effect<void>;
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
 * How many scheduler turns the harness waits below tolerate before failing with a diagnostic. A healthy wait resolves in a handful of turns; a stuck one names itself here instead of ending as the bare vitest timeout.
 */
const AWAIT_SPINS = 10_000;

/**
 * How many consecutive quiet scheduler turns `settle` requires before it trusts that nothing else is going on.
 *
 * Every mock here is synchronous, so anything a regression adds lands within a turn or two; a window this wide cannot be crossed by a call that is merely late, while a single yield can be.
 *
 * What it does *not* prove: that a pass finished. Work parked on a Deferred or a timer looks exactly as quiet, so an assertion made under `settle` still misses anything that would resume after that park. When the claim is that something completed, wait for an observable consequence of the next step instead (the exchange lock only lets a later pass run once the previous one released it).
 */
const SETTLE_TICKS = 50;

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

    let findByThreadIdCalls = 0;

    /*
      The repository is the real in-memory one, with overrides applied on top and `findByThreadId` counted after them: a worker re-resolving a thread over and over shows up here, even while it is not reaching `getTurnStatus` and even when the lookup itself is what fails.
    */
    const repositoryLayer = Layer.effect(
      ExchangeRepository,
      Effect.map(ExchangeRepository, (base) => {
        const overrides =
          typeof servicesInput.repository === "function"
            ? servicesInput.repository(base)
            : servicesInput.repository;
        const repository = { ...base, ...overrides };

        return {
          ...repository,
          findByThreadId: (threadId: ThreadId) =>
            Effect.suspend(() => {
              findByThreadIdCalls += 1;
              return repository.findByThreadId(threadId);
            }),
        };
      }),
    ).pipe(Layer.provide(inMemoryExchangeRepository));

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
      repositoryLayer,
    );

    return yield* Effect.gen(function* () {
      const processor = yield* makeNTBSProcessor;
      const repository = yield* ExchangeRepository;

      return yield* test({
        processor,
        repository,
        calls,
        findByThreadIdCalls: () => findByThreadIdCalls,
        awaitCalls: (count) => {
          const arrived = () => calls.length >= count;

          return Effect.gen(function* () {
            let spins = 0;

            while (!arrived()) {
              if (spins === AWAIT_SPINS) {
                return yield* Effect.die(
                  new Error(
                    `awaitCalls(${count}) spun ${spins} times with ${calls.length} recorded calls`,
                  ),
                );
              }
              spins += 1;
              yield* Effect.yieldNow;
            }
          });
        },
        awaitThreadLookups: (count) => {
          const arrived = () => findByThreadIdCalls >= count;

          return Effect.gen(function* () {
            let spins = 0;

            while (!arrived()) {
              if (spins === AWAIT_SPINS) {
                return yield* Effect.die(
                  new Error(
                    `awaitThreadLookups(${count}) spun ${spins} times with ${findByThreadIdCalls} lookups`,
                  ),
                );
              }
              spins += 1;
              yield* Effect.yieldNow;
            }
          });
        },
        settle: () =>
          Effect.gen(function* () {
            let lastCalls = calls.length;
            let lastLookups = findByThreadIdCalls;
            let quiet = 0;
            let spins = 0;

            while (quiet < SETTLE_TICKS) {
              if (spins === AWAIT_SPINS) {
                return yield* Effect.die(
                  new Error(
                    `settle() spun ${spins} times while the log kept changing (${calls.length} calls, ${findByThreadIdCalls} lookups)`,
                  ),
                );
              }
              spins += 1;
              yield* Effect.yieldNow;

              if (calls.length === lastCalls && findByThreadIdCalls === lastLookups) {
                quiet += 1;
              } else {
                quiet = 0;
                lastCalls = calls.length;
                lastLookups = findByThreadIdCalls;
              }
            }
          }),
        pingActivity: (threadId) => Queue.offer(activity, threadId).pipe(Effect.asVoid),
        awaitStoredTag: (sourceUri, tag) =>
          Effect.gen(function* () {
            let spins = 0;

            while (true) {
              const state = yield* repository.findBySourceUri(sourceUri);

              if (state !== null && state.tag === tag) {
                return state;
              }
              if (spins === AWAIT_SPINS) {
                return yield* Effect.die(
                  new Error(
                    `awaitStoredTag(${sourceUri}, ${tag}) spun ${spins} times, last seen ${state?.tag ?? "no record"}`,
                  ),
                );
              }
              spins += 1;
              yield* Effect.yieldNow;
            }
          }),
      });
    }).pipe(Effect.provide(layer));
  });

describe("NTBSProcessor", () => {
  /*
    Recording is all `process` does: the record is where NTBS accepts responsibility, and the background processor takes the exchange from there.
    A wake waits in the queue until a run drains it; this test covers that delayed start, not a wake that never arrives.
  */
  it.effect(
    "returns once the request is recorded, leaving the work to the background processor",
    () =>
      withProcessor({}, ({ processor, repository, calls, awaitCalls }) =>
        Effect.gen(function* () {
          yield* processor.process(request, target);

          expect(calls).toEqual([]);
          expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(accepted);

          // No run is draining the wake yet; the queue holds it until one starts.
          const run = yield* processor.run.pipe(Effect.forkChild({ startImmediately: true }));
          yield* awaitCalls(6);

          expect(calls.map((call) => `${call.service}.${call.method}`)).toEqual([
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
      ),
  );

  /*
    Harness smoke test: the happy-path defaults drive a fresh request to ThreadCreated with a started turn, and the shared log shows the full cross-service pipeline in order.
    The pipeline runs in the background, so the test waits on the shared log before asserting it.
  */
  it.effect("records a fresh request and starts its turn on the default behaviors", () =>
    withProcessor({}, ({ processor, repository, calls, awaitCalls }) =>
      Effect.gen(function* () {
        const run = yield* processor.run.pipe(Effect.forkChild({ startImmediately: true }));
        yield* processor.process(request, target);
        yield* awaitCalls(6);

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

        yield* Fiber.interrupt(run);
      }),
    ),
  );

  /*
    `process` is idempotent per sourceUri: a redelivery finds the recorded exchange and returns without touching T3 or the adapter.
    The smoke test above pins the exact pipeline, so here we check the log length twice: once after the background pass ran the request to prove it actually did the work, once after the second delivery to prove it added nothing — the log is append-only, so an unchanged length means zero service calls.
  */
  it.effect("starts a new request and ignores its sequential redelivery", () =>
    withProcessor({}, ({ processor, repository, calls, awaitCalls, settle }) =>
      Effect.gen(function* () {
        const run = yield* processor.run.pipe(Effect.forkChild({ startImmediately: true }));
        yield* processor.process(request, target);
        yield* awaitCalls(6);

        // The five T3 pipeline steps plus the acknowledgement.
        expect(calls.length).toBe(6);

        yield* processor.process(request, target);
        yield* settle();

        expect(calls.length).toBe(6);

        // And the stored exchange is still the one the first delivery produced.
        expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(threadCreated);

        yield* Fiber.interrupt(run);
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
      ({ processor, repository, calls, awaitCalls }) =>
        Effect.gen(function* () {
          const run = yield* processor.run.pipe(Effect.forkChild({ startImmediately: true }));
          yield* processor.process(request, target);
          yield* awaitCalls(6);

          expect(calls.map((call) => `${call.service}.${call.method}`)).toEqual([
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
      ({ processor, repository, calls, pingActivity, settle }) =>
        Effect.gen(function* () {
          yield* repository.upsert(threadCreated);

          const run = yield* processor.run.pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(recoveryStatusRead);
          yield* settle();

          expect(calls.map((call) => `${call.service}.${call.method}`)).toEqual([
            "T3Gateway.getTurnStatus",
          ]);

          yield* pingActivity(defaultThreadId);
          yield* Deferred.await(activityStatusRead);
          yield* settle();

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
    Activity pings are handled per exchange: one exchange waiting on a slow T3 read must not hold up another exchange's ping.

    Both stored exchanges are ThreadCreated, so handling a ping is one `getTurnStatus` read. A's read signals and then waits until the clock advances; B's read records and returns at once. If the processor handled one ping at a time, A's completion would be recorded before B was read, so the order of the recorded events is the assertion.
  */
  it.effect("reads another exchange while one exchange's observation is still pending", () => {
    const events: string[] = [];
    const aRead = Deferred.makeUnsafe<void>();
    const bRead = Deferred.makeUnsafe<void>();
    const recovered = Deferred.makeUnsafe<void>();
    let recoveryReads = 0;
    let slow = false;

    return withProcessor(
      {
        t3Gateway: {
          getTurnStatus: (state) =>
            Effect.gen(function* () {
              if (!slow) {
                recoveryReads += 1;
                if (recoveryReads === 2) {
                  yield* Deferred.succeed(recovered, undefined);
                }
              } else if (state.t3.threadId === defaultThreadId) {
                events.push("a:start");
                yield* Deferred.succeed(aRead, undefined);
                yield* Effect.sleep("1 second");
                events.push("a:end");
              } else {
                events.push("b:read");
                yield* Deferred.succeed(bRead, undefined);
              }
              return { turn: "active" as const };
            }),
        },
      },
      ({ processor, repository, pingActivity }) =>
        Effect.gen(function* () {
          yield* repository.upsert(threadCreated);
          yield* repository.upsert(secondThreadCreated);

          const run = yield* processor.run.pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(recovered);
          yield* Effect.yieldNow;

          slow = true;
          yield* pingActivity(defaultThreadId);
          yield* Deferred.await(aRead);
          yield* pingActivity(secondThreadId);

          // Advancing the clock lets A finish in both cases; the recorded order shows whether B was read before that.
          const bReadWait = yield* Deferred.await(bRead).pipe(
            Effect.forkChild({ startImmediately: true }),
          );
          yield* TestClock.adjust("1 second");
          yield* Fiber.join(bReadWait);

          expect(events).toEqual(["a:start", "b:read", "a:end"]);

          yield* Fiber.interrupt(run);
        }),
    );
  });

  /*
    A burst of pings for one exchange is a demand to look again once, not one read per ping.

    A's first read waits until the clock advances. While it waits, the burst arrives and B's ping is read too — B is not waiting for A. The test then advances the clock and waits for A's repeated check itself before counting, because B finishing proves nothing about what A still has queued. Reading once per ping would record 51 reads; here it records A's waiting read plus that one check.
  */
  it.effect("collapses a burst of pings for one exchange into a single extra observation", () => {
    const aRead = Deferred.makeUnsafe<void>();
    const bRead = Deferred.makeUnsafe<void>();
    const checkedAgain = Deferred.makeUnsafe<void>();
    const recovered = Deferred.makeUnsafe<void>();
    const burst = 50;
    let recoveryReads = 0;
    let reads = 0;
    let slow = false;

    return withProcessor(
      {
        t3Gateway: {
          getTurnStatus: (state) =>
            Effect.gen(function* () {
              if (!slow) {
                recoveryReads += 1;
                if (recoveryReads === 2) {
                  yield* Deferred.succeed(recovered, undefined);
                }
              } else if (state.t3.threadId === defaultThreadId) {
                reads += 1;
                if (reads === 1) {
                  yield* Deferred.succeed(aRead, undefined);
                  yield* Effect.sleep("1 second");
                } else if (reads === 2) {
                  yield* Deferred.succeed(checkedAgain, undefined);
                }
              } else {
                yield* Deferred.succeed(bRead, undefined);
              }
              return { turn: "active" as const };
            }),
        },
      },
      ({ processor, repository, pingActivity, settle }) =>
        Effect.gen(function* () {
          yield* repository.upsert(threadCreated);
          yield* repository.upsert(secondThreadCreated);

          const run = yield* processor.run.pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(recovered);
          yield* Effect.yieldNow;

          slow = true;
          reads = 0;
          yield* pingActivity(defaultThreadId);
          yield* Deferred.await(aRead);
          yield* Effect.forEach(
            Array.from({ length: burst }),
            () => pingActivity(defaultThreadId),
            {
              discard: true,
            },
          );

          yield* pingActivity(secondThreadId);
          // B's read completes while the clock has not advanced, so it happens while A is still waiting on its first read.
          yield* Deferred.await(bRead);

          yield* TestClock.adjust("1 second");
          yield* Deferred.await(checkedAgain);
          yield* settle();

          expect(reads).toBe(2);

          yield* Fiber.interrupt(run);
        }),
    );
  });

  /*
    A burst of pings while the reply is being posted asks for one more look, not a second delivery: the follow-up pass reloads the posted record and stops, so `postReply` runs exactly once.
  */
  it.effect("does not post the reply again for pings arriving while it posts", () => {
    const reply = answer("Reply under a burst of pings");
    const postStarted = Deferred.makeUnsafe<void>();
    const releasePost = Deferred.makeUnsafe<void>();
    const burst = 50;
    let posts = 0;

    return withProcessor(
      {
        t3Gateway: {
          getTurnStatus: () => Effect.succeed({ turn: "completed" as const, reply }),
        },
        adapter: {
          postReply: () =>
            Effect.gen(function* () {
              posts += 1;
              yield* Deferred.succeed(postStarted, undefined);
              yield* Deferred.await(releasePost);
              return postedReplyUri;
            }),
        },
      },
      ({
        processor,
        repository,
        calls,
        pingActivity,
        awaitStoredTag,
        awaitThreadLookups,
        settle,
      }) =>
        Effect.gen(function* () {
          yield* repository.upsert(threadCreated);

          const run = yield* processor.run.pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(postStarted);

          // One ping starts a worker, which has to wait for the posting pass; the burst behind it collapses into one queued re-check.
          yield* pingActivity(defaultThreadId);
          yield* awaitThreadLookups(1);

          yield* Effect.forEach(
            Array.from({ length: burst }),
            () => pingActivity(defaultThreadId),
            { discard: true },
          );
          yield* settle();

          yield* Deferred.succeed(releasePost, undefined);
          yield* awaitStoredTag(request.sourceUri, "reply-posted");

          // The queued re-check runs its own pass and resolves the thread again: it reloads the posted exchange and stops, without another post.
          yield* awaitThreadLookups(2);
          yield* settle();

          expect(posts).toBe(1);
          expect(calls.map((call) => `${call.service}.${call.method}`)).toEqual([
            "T3Gateway.getTurnStatus",
            "NTBSAdapter.findPostedReply",
            "NTBSAdapter.postReply",
          ]);

          yield* Fiber.interrupt(run);
        }),
    );
  });

  /*
    T3 refusing the target for good (a project repository with no origin remote, say) is found out at planning, before anything from T3 exists.
    The request was already recorded, so the rejection becomes a failure reply like any other and is posted; the stored record never carries T3 coordinates.
  */
  it.effect("posts a failure reply when T3 rejects the request at planning", () => {
    const rejection = new FatalError({
      reason: "Remote 'origin' does not exist",
      cause: null,
      method: "gitWorkflowService.remoteExists",
    });

    return withProcessor(
      {
        t3Gateway: {
          planCoordinates: () => rejection,
        },
      },
      ({ processor, repository, calls, awaitCalls }) =>
        Effect.gen(function* () {
          const run = yield* processor.run.pipe(Effect.forkChild({ startImmediately: true }));
          yield* processor.process(request, target);
          yield* awaitCalls(3);

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

          yield* Fiber.interrupt(run);
        }),
    );
  });

  /*
    A transient planning failure happens after the request was recorded, so the record survives it: the pass fails, the exchange stays RequestAccepted.
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
        ({ processor, repository, calls, awaitCalls, settle }) =>
          Effect.gen(function* () {
            // Started first so that the sweep, not startup recovery, is what re-plans.
            const run = yield* processor.run.pipe(Effect.forkChild({ startImmediately: true }));
            yield* processor.process(request, target);
            yield* awaitCalls(1);

            expect(calls.map((call) => `${call.service}.${call.method}`)).toEqual([
              "T3Gateway.planCoordinates",
            ]);
            expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(accepted);

            // Redelivery after acceptance does no planning.
            yield* processor.process(request, target);
            yield* settle();
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
    A transient provisioning failure leaves the exchange at WorkPlanned; the pass fails, the record survives.
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
      ({ processor, repository, calls, awaitCalls }) =>
        Effect.gen(function* () {
          const firstRun = yield* processor.run.pipe(Effect.forkChild({ startImmediately: true }));
          yield* processor.process(request, target);
          yield* awaitCalls(3);

          expect(calls.map((call) => `${call.service}.${call.method}`)).toEqual([
            "T3Gateway.planCoordinates",
            "T3Gateway.getThreadStatus",
            "T3Gateway.provisionThread",
          ]);
          expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(planned);

          yield* Fiber.interrupt(firstRun);

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
    A transient turn-start failure happens after ThreadCreated was persisted, so the exchange stays there and the pass fails.
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
      ({ processor, repository, calls, awaitCalls }) =>
        Effect.gen(function* () {
          const firstRun = yield* processor.run.pipe(Effect.forkChild({ startImmediately: true }));
          yield* processor.process(request, target);
          yield* awaitCalls(6);

          expect(calls.map((call) => `${call.service}.${call.method}`)).toEqual([
            "T3Gateway.planCoordinates",
            "T3Gateway.getThreadStatus",
            "T3Gateway.provisionThread",
            "NTBSAdapter.acknowledge",
            "T3Gateway.getTurnStatus",
            "T3Gateway.startTurn",
          ]);
          expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(threadCreated);

          yield* Fiber.interrupt(firstRun);

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
    A fatal turn-start rejection is the dead end of the planning rejection one step later: the thread exists, so the rejection becomes a failure reply on the recorded exchange and the pass carries it to delivery.
  */
  it.effect("turns a fatal turn start into a failure reply", () => {
    const rejection = new FatalError({
      reason: "T3 rejected the turn start",
      cause: null,
      method: "orchestrationEngine.dispatch",
    });
    const postStarted = Deferred.makeUnsafe<void>();
    const releasePost = Deferred.makeUnsafe<void>();

    return withProcessor(
      {
        t3Gateway: {
          startTurn: () => rejection,
        },
        adapter: {
          postReply: () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(postStarted, undefined);
              yield* Deferred.await(releasePost);
              return postedReplyUri;
            }),
        },
      },
      ({ processor, repository, calls, awaitStoredTag }) =>
        Effect.gen(function* () {
          const run = yield* processor.run.pipe(Effect.forkChild({ startImmediately: true }));
          yield* processor.process(request, target);
          // The post is held open so the record the fatal start produced can be read before the reply goes out.
          yield* Deferred.await(postStarted);

          const replyPending = toRejected(threadCreated, rejection, now);
          expect(replyPending.reply).toEqual({
            type: "failure",
            text: rejection.reason,
            cause: {
              type: "rejected",
              method: rejection.method,
              state: { tag: "thread-created", t3: threadCreated.t3 },
            },
          });
          expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(replyPending);
          expect(calls.map((call) => `${call.service}.${call.method}`)).toEqual([
            "T3Gateway.planCoordinates",
            "T3Gateway.getThreadStatus",
            "T3Gateway.provisionThread",
            "NTBSAdapter.acknowledge",
            "T3Gateway.getTurnStatus",
            "T3Gateway.startTurn",
            "NTBSAdapter.findPostedReply",
            "NTBSAdapter.postReply",
          ]);

          yield* Deferred.succeed(releasePost, undefined);
          yield* awaitStoredTag(request.sourceUri, "reply-posted");

          expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(
            toReplyPosted(replyPending, postedReplyUri, now),
          );

          yield* Fiber.interrupt(run);
        }),
    );
  });

  /*
    Failing to load the exchanges is not fatal to `run`: startup recovery logs it, and the sweeper — which reads the same list — retries a minute later and drives the stored exchange on.
  */
  it.effect("recovers from a failed recovery load on the next sweep", () => {
    const recoveryFailed = Deferred.makeUnsafe<void>();
    const reply = answer("Reply after a failed recovery load");
    let loads = 0;

    return withProcessor(
      {
        t3Gateway: {
          getTurnStatus: () => Effect.succeed({ turn: "completed" as const, reply }),
        },
        repository: {
          findNonTerminalExchanges: Effect.gen(function* () {
            loads += 1;
            if (loads === 1) {
              yield* Deferred.succeed(recoveryFailed, undefined);
              return yield* new ExchangeRepositoryError({
                reason: "The repository is unavailable",
                cause: "test failure",
              });
            }
            return [threadCreated];
          }),
        },
      },
      ({ processor, repository, calls, awaitStoredTag, settle }) =>
        Effect.gen(function* () {
          yield* repository.upsert(threadCreated);

          const run = yield* processor.run.pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(recoveryFailed);
          yield* settle();

          // The failed load ended recovery before it could read or write anything about the exchange.
          expect(calls).toEqual([]);
          expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(threadCreated);

          yield* TestClock.adjust("1 minute");
          yield* awaitStoredTag(request.sourceUri, "reply-posted");

          expect(loads).toBe(2);
          expect(calls.map((call) => `${call.service}.${call.method}`)).toEqual([
            "T3Gateway.getTurnStatus",
            "NTBSAdapter.findPostedReply",
            "NTBSAdapter.postReply",
          ]);

          yield* Fiber.interrupt(run);
        }),
    );
  });

  /*
    A failing thread lookup fails only that pass, logged and dropped like any other: the exchange keeps the record it had, and the next ping resolves the thread and runs it on — even the ping that arrives while the failing pass is still in flight.
  */
  it.effect("survives a failed lookup for thread activity", () => {
    const recoveryTurnStarted = Deferred.makeUnsafe<void>();
    const lookupParked = Deferred.makeUnsafe<void>();
    const releaseLookup = Deferred.makeUnsafe<void>();
    const reply = answer("Reply after a failed lookup");
    let lookups = 0;
    let turnStatusReads = 0;

    return withProcessor(
      {
        t3Gateway: {
          getTurnStatus: () =>
            Effect.sync(() => {
              turnStatusReads += 1;
              return turnStatusReads === 1
                ? { turn: "missing" as const }
                : { turn: "completed" as const, reply };
            }),
          startTurn: () => Deferred.succeed(recoveryTurnStarted, undefined),
        },
        repository: {
          findByThreadId: (threadId: ThreadId) =>
            Effect.gen(function* () {
              lookups += 1;
              if (lookups === 1) {
                // Held open long enough that the next ping arrives while the pass is failing.
                yield* Deferred.succeed(lookupParked, undefined);
                yield* Deferred.await(releaseLookup);
                return yield* new ExchangeRepositoryError({
                  reason: "The repository is unavailable",
                  cause: "test failure",
                });
              }
              return threadId === defaultThreadId ? threadCreated : null;
            }),
        },
      },
      ({
        processor,
        repository,
        calls,
        pingActivity,
        awaitStoredTag,
        findByThreadIdCalls,
        settle,
      }) =>
        Effect.gen(function* () {
          yield* repository.upsert(threadCreated);

          const run = yield* processor.run.pipe(Effect.forkChild({ startImmediately: true }));
          // Recovery has read the turn and started it; the exchange settles at ThreadCreated for the pings that follow.
          yield* Deferred.await(recoveryTurnStarted);
          yield* settle();

          yield* pingActivity(defaultThreadId);
          yield* Deferred.await(lookupParked);

          // The failing lookup never reached the exchange; the ping that arrives while it fails must not be lost with it.
          expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(threadCreated);
          yield* pingActivity(defaultThreadId);
          // Let the activity subscription pick up the ping while the lookup is still parked, so its re-check is queued against a failing pass.
          yield* settle();

          yield* Deferred.succeed(releaseLookup, undefined);
          yield* awaitStoredTag(request.sourceUri, "reply-posted");

          expect(findByThreadIdCalls()).toBe(2);
          expect(calls.map((call) => `${call.service}.${call.method}`)).toEqual([
            "T3Gateway.getTurnStatus",
            "T3Gateway.startTurn",
            "T3Gateway.getTurnStatus",
            "NTBSAdapter.findPostedReply",
            "NTBSAdapter.postReply",
          ]);

          yield* Fiber.interrupt(run);
        }),
    );
  });

  /*
    `upsert` guards the thread index as well, and a plan already carries its thread: a second request planned onto a thread the first exchange owns cannot record that plan.
    The pass fails at the record, the second exchange stays at its accepted request, and the first keeps the thread it reached.
  */
  it.effect(
    "fails the pass when a second request plans onto a thread that already belongs to one",
    () => {
      const secondAccepted = makeRequestAccepted(secondRequest, target, now);

      return withProcessor({}, ({ processor, repository, calls, awaitCalls, settle }) =>
        Effect.gen(function* () {
          const run = yield* processor.run.pipe(Effect.forkChild({ startImmediately: true }));

          yield* processor.process(request, target);
          yield* awaitCalls(6);
          expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(threadCreated);

          // The second request plans onto the same thread the first one already owns.
          yield* processor.process(secondRequest, target);
          yield* awaitCalls(7);
          yield* settle();

          expect(calls.map((call) => `${call.service}.${call.method}`)).toEqual([
            "T3Gateway.planCoordinates",
            "T3Gateway.getThreadStatus",
            "T3Gateway.provisionThread",
            "NTBSAdapter.acknowledge",
            "T3Gateway.getTurnStatus",
            "T3Gateway.startTurn",
            "T3Gateway.planCoordinates",
          ]);
          expect(yield* repository.findBySourceUri(secondRequest.sourceUri)).toEqual(
            secondAccepted,
          );
          expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(threadCreated);

          yield* Fiber.interrupt(run);
        }),
      );
    },
  );

  /*
    Only the first delivery of a sourceUri records it; a redelivery reads the record without taking the exchange lock.
    The background pass is held inside planCoordinates, so the lock is busy while the exchange is mid-pipeline; the redelivery still returns immediately, and once released the log shows a single pipeline.
  */
  it.effect("returns a redelivery without waiting for the exchange lock", () => {
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
      ({ processor, repository, calls, awaitCalls }) =>
        Effect.gen(function* () {
          const run = yield* processor.run.pipe(Effect.forkChild({ startImmediately: true }));

          const first = yield* processor
            .process(request, target)
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(firstPlanStarted);

          // The record exists, so the redelivery completes while the lock is still held by the parked pass.
          const second = yield* processor
            .process(request, target)
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Fiber.join(second);

          expect(calls.map((call) => `${call.service}.${call.method}`)).toEqual([
            "T3Gateway.planCoordinates",
          ]);
          expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(accepted);

          yield* Deferred.succeed(releaseFirstPlan, undefined);
          yield* Fiber.join(first);
          yield* awaitCalls(6);

          expect(calls.map((call) => `${call.service}.${call.method}`)).toEqual([
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
    A delivery can read an empty repository and still find a record when it re-checks under the lock, because another delivery recorded it in between.
    The first read is held open so the recording lands while it is in flight, which is the race itself; the redelivery then returns without recording anything.
  */
  it.effect("returns a delivery whose first read raced the recording", () => {
    const firstReadParked = Deferred.makeUnsafe<void>();
    const releaseFirstRead = Deferred.makeUnsafe<void>();
    let reads = 0;

    return withProcessor(
      {
        repository: (base) => ({
          findBySourceUri: (sourceUri) =>
            Effect.gen(function* () {
              reads += 1;

              if (reads === 1) {
                // The first check read the empty repository; the gate holds it open until another delivery records the exchange.
                yield* Deferred.succeed(firstReadParked, undefined);
                yield* Deferred.await(releaseFirstRead);
                return null;
              }

              return yield* base.findBySourceUri(sourceUri);
            }),
        }),
      },
      ({ processor, repository }) =>
        Effect.gen(function* () {
          const delivery = yield* processor.process(request, target).pipe(Effect.forkChild);
          yield* Deferred.await(firstReadParked);

          yield* repository.upsert(threadCreated);
          yield* Deferred.succeed(releaseFirstRead, undefined);
          yield* Fiber.join(delivery);

          // The re-check found the recorded exchange: one record, and the redelivery persisted nothing.
          expect(reads).toBe(2);
          expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(threadCreated);
        }),
    );
  });

  /*
    A redelivery does not couple to the pass it meets.
    The pass fails inside planCoordinates after the request was recorded, so the redelivery finds the record and returns without planning again; recovery, not the redelivery, finishes the pipeline.
  */
  it.effect("ignores a redelivery of an accepted request whose planning failed", () => {
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
          const run = yield* processor.run.pipe(Effect.forkChild({ startImmediately: true }));

          const first = yield* processor
            .process(request, target)
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(firstPlanStarted);

          // The redelivery completes while the lock is still held by the parked pass.
          const second = yield* processor
            .process(request, target)
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Fiber.join(second);

          expect(calls.map((call) => `${call.service}.${call.method}`)).toEqual([
            "T3Gateway.planCoordinates",
          ]);
          expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(accepted);

          yield* Deferred.succeed(releaseFirstPlan, undefined);
          yield* Fiber.join(first);

          // The redelivery found the record and added nothing to the log, and the failed pass is the background processor's problem, not the deliveries'.
          expect(calls.map((call) => `${call.service}.${call.method}`)).toEqual([
            "T3Gateway.planCoordinates",
          ]);
          expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(accepted);

          yield* Fiber.interrupt(run);

          const recovery = yield* processor.run.pipe(Effect.forkChild({ startImmediately: true }));
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

          yield* Fiber.interrupt(recovery);
        }),
    );
  });

  /*
    The same, one step later: the pass fails inside getThreadStatus, after the plan was persisted.
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
          const run = yield* processor.run.pipe(Effect.forkChild({ startImmediately: true }));

          const first = yield* processor
            .process(request, target)
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(threadStatusStarted);

          expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(planned);

          const second = yield* processor
            .process(request, target)
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Fiber.join(second);

          // The redelivery did not wait on the locked pass.
          expect(calls.map((call) => `${call.service}.${call.method}`)).toEqual([
            "T3Gateway.planCoordinates",
            "T3Gateway.getThreadStatus",
          ]);

          yield* Deferred.succeed(releaseThreadStatus, undefined);
          // A failed observation becomes an unknown context: leave the persisted
          // plan in place and let recovery decide whether to retry or expire it.
          yield* Fiber.join(first);

          // The redelivery found the plan and added nothing to the log.
          expect(calls.map((call) => `${call.service}.${call.method}`)).toEqual([
            "T3Gateway.planCoordinates",
            "T3Gateway.getThreadStatus",
          ]);
          expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(planned);

          yield* Fiber.interrupt(run);

          const recovery = yield* processor.run.pipe(Effect.forkChild({ startImmediately: true }));
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

          yield* Fiber.interrupt(recovery);
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
      ({ processor, repository, calls, awaitCalls }) =>
        Effect.gen(function* () {
          const run = yield* processor.run.pipe(Effect.forkChild({ startImmediately: true }));

          yield* processor.process(request, target);
          yield* Deferred.await(firstPlanStarted);

          yield* processor.process(secondRequest, target);
          yield* awaitCalls(7);

          // The second request completed while the first is still held in planCoordinates.
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
          yield* awaitCalls(12);

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

          yield* Fiber.interrupt(run);
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
    A redelivery does not disturb an in-flight activity pass.
    While the ping's status read is held open, the redelivery reads the stored exchange and returns without calls; the pass then completes and posts the reply.
  */
  it.effect("returns a redelivery while thread activity is mid-pass", () => {
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
          // The redelivery returns while the activity pass still holds the exchange lock.
          yield* Fiber.join(redelivery);

          expect(calls.map((call) => `${call.service}.${call.method}`)).toEqual([
            "T3Gateway.getTurnStatus",
            "T3Gateway.getTurnStatus",
          ]);
          expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(threadCreated);

          yield* Deferred.succeed(releaseActivityStatus, undefined);
          const posted = yield* awaitStoredTag(request.sourceUri, "reply-posted");

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
    The happy path end to end: a fresh request whose thread already exists and whose turn completes immediately reaches ReplyPosted in one background pass.
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
      ({ processor, repository, calls, awaitCalls }) =>
        Effect.gen(function* () {
          const run = yield* processor.run.pipe(Effect.forkChild({ startImmediately: true }));
          yield* processor.process(request, target);
          yield* awaitCalls(6);

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

          yield* Fiber.interrupt(run);
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
      ({ processor, repository, calls, awaitCalls }) =>
        Effect.gen(function* () {
          const run = yield* processor.run.pipe(Effect.forkChild({ startImmediately: true }));
          yield* processor.process(request, target);
          yield* awaitCalls(5);

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

          yield* Fiber.interrupt(run);
        }),
    );
  });

  /*
    Recovery from ReplyPending, the one non-terminal state the other recovery tests never start from.
    A transient posting failure leaves the exchange pending; the next run repeats discovery and posting, and the second attempt lands.
  */
  it.effect("retries a transient reply-posting failure during later recovery", () => {
    const firstPostAttempted = Deferred.makeUnsafe<void>();
    const retryReachedPost = Deferred.makeUnsafe<void>();
    const releaseRetry = Deferred.makeUnsafe<void>();
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
              if (postAttempts === 2) {
                yield* Deferred.succeed(retryReachedPost, undefined);
                yield* Deferred.await(releaseRetry);
              }
              return postedReplyUri;
            }),
        },
      },
      ({ processor, repository, calls, pingActivity, awaitStoredTag }) =>
        Effect.gen(function* () {
          const replyPending = toReplyPending(threadCreated, reply, now);
          yield* repository.upsert(replyPending);

          const firstRun = yield* processor.run.pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(firstPostAttempted);

          /*
            The failed pass leaves no trace of its own, so quiet is not evidence that it ended: the retry below is the evidence.
            A ping's pass cannot reach `postReply` while the failed one still owns the exchange — `resumeExchange` waits for it — so `retryReachedPost` proves the failure was fully handled, not merely silent.
          */
          yield* pingActivity(defaultThreadId);
          yield* Deferred.await(retryReachedPost);

          // The retry is the only extra attempt, and the record is untouched: the failure was kept, nothing terminal was written.
          expect(postAttempts).toBe(2);
          expect(calls.map((call) => `${call.service}.${call.method}`)).toEqual([
            "NTBSAdapter.findPostedReply",
            "NTBSAdapter.postReply",
            "NTBSAdapter.findPostedReply",
            "NTBSAdapter.postReply",
          ]);
          expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(replyPending);

          // A crash while the retry is in flight leaves the record retryable still: startup recovery picks it up and posts.
          yield* Fiber.interrupt(firstRun);

          const secondRun = yield* processor.run.pipe(Effect.forkChild({ startImmediately: true }));
          const posted = yield* awaitStoredTag(request.sourceUri, "reply-posted");

          expect(postAttempts).toBe(3);
          expect(posted).toEqual(toReplyPosted(replyPending, postedReplyUri, now));
          expect(calls.map((call) => `${call.service}.${call.method}`)).toEqual([
            "NTBSAdapter.findPostedReply",
            "NTBSAdapter.postReply",
            "NTBSAdapter.findPostedReply",
            "NTBSAdapter.postReply",
            "NTBSAdapter.findPostedReply",
            "NTBSAdapter.postReply",
          ]);

          yield* Fiber.interrupt(secondRun);
        }),
    );
  });

  /*
    Reply discovery can fail transiently too: an unobserved platform posts nothing, and the retry after the failed pass discovers again before delivering.
  */
  it.effect("repeats reply discovery after a transient failure", () => {
    const reply = answer("Reply after a failed discovery");
    const replyPending = toReplyPending(threadCreated, reply, now);
    const discoveryFailed = Deferred.makeUnsafe<void>();
    let discoveries = 0;

    return withProcessor(
      {
        adapter: {
          findPostedReply: () =>
            Effect.gen(function* () {
              discoveries += 1;
              if (discoveries === 1) {
                yield* Deferred.succeed(discoveryFailed, undefined);
                return yield* new AdapterError({
                  reason: "The platform is unavailable",
                  cause: "test failure",
                });
              }
              return null;
            }),
        },
      },
      ({ processor, repository, calls, pingActivity, awaitStoredTag, settle }) =>
        Effect.gen(function* () {
          yield* repository.upsert(replyPending);

          const run = yield* processor.run.pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(discoveryFailed);
          yield* settle();

          // The failed discovery posts nothing; the record still waits for its reply.
          expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(replyPending);
          expect(calls.map((call) => `${call.service}.${call.method}`)).toEqual([
            "NTBSAdapter.findPostedReply",
          ]);

          yield* pingActivity(defaultThreadId);
          yield* awaitStoredTag(request.sourceUri, "reply-posted");

          expect(discoveries).toBe(2);
          expect(calls.map((call) => `${call.service}.${call.method}`)).toEqual([
            "NTBSAdapter.findPostedReply",
            "NTBSAdapter.findPostedReply",
            "NTBSAdapter.postReply",
          ]);

          yield* Fiber.interrupt(run);
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
      ({ processor, repository, calls, awaitCalls, awaitStoredTag }) =>
        Effect.gen(function* () {
          const firstRun = yield* processor.run.pipe(Effect.forkChild({ startImmediately: true }));
          yield* processor.process(request, target);
          yield* awaitCalls(1);
          expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(accepted);
          yield* Fiber.interrupt(firstRun);

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
    After the observe timeout the failed check becomes unknown, the decider waits, and the next pass
    can take the lock. Provisioning, a turn, and a second reply post stay unstarted.
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
      hang: (started: Deferred.Deferred<void>, cutOff: Deferred.Deferred<void>): ServiceInput => {
        let reads = 0;
        return {
          t3Gateway: {
            getThreadStatus: () => {
              reads += 1;
              return reads === 1
                ? Deferred.succeed(started, undefined).pipe(
                    Effect.andThen(Effect.never),
                    Effect.onInterrupt(() => Deferred.succeed(cutOff, undefined)),
                  )
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
      hang: (started: Deferred.Deferred<void>, cutOff: Deferred.Deferred<void>): ServiceInput => {
        let reads = 0;
        return {
          t3Gateway: {
            getTurnStatus: () => {
              reads += 1;
              return reads === 1
                ? Deferred.succeed(started, undefined).pipe(
                    Effect.andThen(Effect.never),
                    Effect.onInterrupt(() => Deferred.succeed(cutOff, undefined)),
                  )
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
      hang: (started: Deferred.Deferred<void>, cutOff: Deferred.Deferred<void>): ServiceInput => {
        let reads = 0;
        return {
          adapter: {
            findPostedReply: () => {
              reads += 1;
              return reads === 1
                ? Deferred.succeed(started, undefined).pipe(
                    Effect.andThen(Effect.never),
                    Effect.onInterrupt(() => Deferred.succeed(cutOff, undefined)),
                  )
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
      const cutOff = Deferred.makeUnsafe<void>();

      return withProcessor(
        hang(started, cutOff),
        ({ processor, repository, calls, pingActivity, awaitStoredTag }) =>
          Effect.gen(function* () {
            yield* repository.upsert(seed);

            const run = yield* processor.run.pipe(Effect.forkChild({ startImmediately: true }));
            yield* Deferred.await(started);

            yield* TestClock.adjust("10 seconds");
            // The cancelled read proves the observe timeout cut the call off.
            yield* Deferred.await(cutOff);
            const resumedAt = yield* Clock.currentTimeMillis;

            // A crash would also have released the lock, so liveness needs its own check.
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
    The pass failure itself belongs to the background processor and is logged, not returned.
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
      expectedState: (acceptedState: typeof accepted, at: number) =>
        toReplyPosted(
          toReplyPending(
            toThreadCreated(toWorkPlanned(acceptedState, defaultWorkCoordinates, at), at),
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
      expectedState: (acceptedState: typeof accepted, at: number) =>
        toReplyPosted(toExpired(acceptedState, at), postedReplyUri, at),
    },
  ] as const)(
    "leaves RequestAccepted after a planning timeout, and a later pass $outcome",
    ({ laterAdvance, expectedCalls, expectedState }) => {
      const planStarted = Deferred.makeUnsafe<void>();
      const planCutOff = Deferred.makeUnsafe<void>();
      let planCalls = 0;

      return withProcessor(
        {
          t3Gateway: {
            planCoordinates: () => {
              planCalls += 1;
              return planCalls === 1
                ? Deferred.succeed(planStarted, undefined).pipe(
                    Effect.andThen(Effect.never),
                    Effect.onInterrupt(() => Deferred.succeed(planCutOff, undefined)),
                  )
                : Effect.succeed(defaultWorkCoordinates);
            },
            getThreadStatus: () => Effect.succeed({ thread: "present" }),
            getTurnStatus: () => Effect.succeed({ turn: "completed", reply: settledReply }),
          },
        },
        ({ processor, repository, calls, awaitStoredTag }) =>
          Effect.gen(function* () {
            const firstRun = yield* processor.run.pipe(
              Effect.forkChild({ startImmediately: true }),
            );

            // Staggered off the sweep boundary so the plan timeout and a sweep cannot fall on the same clock tick.
            yield* TestClock.adjust("10 seconds");
            const acceptedAt = yield* Clock.currentTimeMillis;
            const acceptedState = makeRequestAccepted(request, target, acceptedAt);
            yield* processor.process(request, target);
            yield* Deferred.await(planStarted);

            // The planning timeout is one minute, well under the state's five; the hung pass is abandoned without a transition.
            yield* TestClock.adjust("1 minute");
            // The cancelled signal proves the timeout cut the call off, before the run is interrupted.
            yield* Deferred.await(planCutOff);

            expect(calls.map((call) => `${call.service}.${call.method}`)).toEqual([
              "T3Gateway.planCoordinates",
            ]);
            expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(acceptedState);

            yield* Fiber.interrupt(firstRun);

            yield* TestClock.adjust(laterAdvance);
            const at = yield* Clock.currentTimeMillis;

            const run = yield* processor.run.pipe(Effect.forkChild({ startImmediately: true }));
            yield* awaitStoredTag(request.sourceUri, "reply-posted");

            expect(calls.map((call) => `${call.service}.${call.method}`)).toEqual(expectedCalls);
            expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(
              expectedState(acceptedState, at),
            );

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
      const provisionCutOff = Deferred.makeUnsafe<void>();
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
              Deferred.succeed(provisionStarted, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.onInterrupt(() => Deferred.succeed(provisionCutOff, undefined)),
              ),
            getTurnStatus: () =>
              Effect.succeed({ turn: "completed" as const, reply: settledReply }),
          },
        },
        ({ processor, repository, calls, awaitStoredTag }) =>
          Effect.gen(function* () {
            const firstRun = yield* processor.run.pipe(
              Effect.forkChild({ startImmediately: true }),
            );

            // Staggered off the sweep boundary so the provisioning timeout and a sweep cannot fall on the same clock tick.
            yield* TestClock.adjust("10 seconds");
            const acceptedAt = yield* Clock.currentTimeMillis;
            const acceptedState = makeRequestAccepted(request, target, acceptedAt);
            const plannedState = toWorkPlanned(acceptedState, defaultWorkCoordinates, acceptedAt);
            yield* processor.process(request, target);
            yield* Deferred.await(provisionStarted);

            // Provisioning has five minutes, less than the state's fifteen.
            yield* TestClock.adjust("5 minutes");
            // The cancelled signal proves the timeout cut the call off, before the run is interrupted.
            yield* Deferred.await(provisionCutOff);

            // The plan survived the timeout and only the one provision was attempted.
            expect(calls.map((call) => `${call.service}.${call.method}`)).toEqual([
              "T3Gateway.planCoordinates",
              "T3Gateway.getThreadStatus",
              "T3Gateway.provisionThread",
            ]);
            expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(plannedState);

            const at = yield* Clock.currentTimeMillis;
            yield* Fiber.interrupt(firstRun);

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
                toReplyPending(toThreadCreated(plannedState, at), settledReply, at),
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
    const startCutOff = Deferred.makeUnsafe<void>();
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
            Deferred.succeed(startStarted, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() => Deferred.succeed(startCutOff, undefined)),
            ),
        },
      },
      ({ processor, repository, calls, awaitStoredTag }) =>
        Effect.gen(function* () {
          const firstRun = yield* processor.run.pipe(Effect.forkChild({ startImmediately: true }));
          yield* processor.process(request, target);
          yield* Deferred.await(startStarted);

          // Turn start has thirty seconds, well under the state's hour.
          yield* TestClock.adjust("30 seconds");
          // The cancelled signal proves the timeout cut the call off, before the run is interrupted.
          yield* Deferred.await(startCutOff);

          expect(calls.map((call) => `${call.service}.${call.method}`)).toEqual([
            "T3Gateway.planCoordinates",
            "T3Gateway.getThreadStatus",
            "NTBSAdapter.acknowledge",
            "T3Gateway.getTurnStatus",
            "T3Gateway.startTurn",
          ]);
          expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(threadCreated);

          const at = yield* Clock.currentTimeMillis;
          yield* Fiber.interrupt(firstRun);

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
    const postCutOff = Deferred.makeUnsafe<void>();
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
            Deferred.succeed(postStarted, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() => Deferred.succeed(postCutOff, undefined)),
            ),
        },
      },
      ({ processor, repository, calls, awaitStoredTag }) =>
        Effect.gen(function* () {
          const firstRun = yield* processor.run.pipe(Effect.forkChild({ startImmediately: true }));
          yield* processor.process(request, target);
          yield* Deferred.await(postStarted);

          // Posting has thirty seconds, well under the state's hour.
          yield* TestClock.adjust("30 seconds");
          // The cancelled signal proves the timeout cut the call off, before the run is interrupted.
          yield* Deferred.await(postCutOff);

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
          yield* Fiber.interrupt(firstRun);

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
      ({ processor, repository, calls, awaitCalls }) =>
        Effect.gen(function* () {
          const run = yield* processor.run.pipe(Effect.forkChild({ startImmediately: true }));
          yield* processor.process(request, target);
          yield* Deferred.await(acknowledgeStarted);

          // Persisted before the acknowledgement was even attempted.
          expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(threadCreated);

          yield* TestClock.adjust("10 seconds");
          yield* awaitCalls(5);

          // The timeout was swallowed and the pipeline continued as if the acknowledgement failed.
          expect(calls.map((call) => `${call.service}.${call.method}`)).toEqual([
            "T3Gateway.planCoordinates",
            "T3Gateway.getThreadStatus",
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
      ({ processor, repository, calls, settle }) =>
        Effect.gen(function* () {
          yield* repository.upsert(threadCreated);

          // Ten seconds left before ThreadCreated expires, well under startTurn's thirty.
          yield* TestClock.adjust("3590 seconds");

          const run = yield* processor.run.pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(startTurnStarted);

          // One second short of the deadline: the action is still running, uncut.
          yield* TestClock.adjust("9 seconds");
          yield* settle();
          expect(Deferred.isDoneUnsafe(startTurnInterrupted)).toBe(false);

          // At the deadline it is cut off, exactly as the state expires.
          yield* TestClock.adjust("1 second");
          yield* settle();
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
      ({ processor, repository, calls, pingActivity, awaitStoredTag, settle }) =>
        Effect.gen(function* () {
          yield* repository.upsert(threadCreated);

          // Ten seconds left, so the turn-start timeout lands exactly on the deadline.
          yield* TestClock.adjust("3590 seconds");

          const run = yield* processor.run.pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(startTurnStarted);
          yield* TestClock.adjust("10 seconds");
          yield* settle();

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
    A run interrupted while a worker is mid-pass must not leave its thread marked as busy: the run that replaces it has to process that thread's events again, not swallow them.
  */
  it.effect("processes a thread again after a run is interrupted mid-pass", () => {
    const firstRecovery = Deferred.makeUnsafe<void>();
    const parked = Deferred.makeUnsafe<void>();
    const secondRecovery = Deferred.makeUnsafe<void>();
    const reprocessed = Deferred.makeUnsafe<void>();
    let reads = 0;

    return withProcessor(
      {
        t3Gateway: {
          getTurnStatus: () =>
            Effect.gen(function* () {
              reads += 1;

              if (reads === 1) {
                yield* Deferred.succeed(firstRecovery, undefined);
              } else if (reads === 2) {
                yield* Deferred.succeed(parked, undefined);
                yield* Effect.sleep("1 hour");
              } else if (reads === 3) {
                yield* Deferred.succeed(secondRecovery, undefined);
              } else if (reads === 4) {
                yield* Deferred.succeed(reprocessed, undefined);
              }

              return { turn: "active" as const };
            }),
        },
      },
      ({ processor, repository, pingActivity }) =>
        Effect.gen(function* () {
          yield* repository.upsert(threadCreated);

          // First run: recovery reads (1), then a ping's pass parks mid-read (2).
          const firstRun = yield* processor.run.pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(firstRecovery);
          yield* Effect.yieldNow;

          yield* pingActivity(defaultThreadId);
          yield* Deferred.await(parked);

          yield* Fiber.interrupt(firstRun);

          // Second run: recovery reads (3), and the same ping has to be processed again (4).
          const secondRun = yield* processor.run.pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(secondRecovery);
          yield* Effect.yieldNow;

          yield* pingActivity(defaultThreadId);
          yield* Deferred.await(reprocessed);

          expect(reads).toBe(4);

          yield* Fiber.interrupt(secondRun);
        }),
    );
  });

  /*
    Activity that arrives for an exchange while recovery is reading it has to be read again after that pass: the event arrived during the pass, so folding it in would miss it.
  */
  it.effect("waits for an in-flight recovery pass before checking the same exchange", () => {
    const recoveryRead = Deferred.makeUnsafe<void>();
    const release = Deferred.makeUnsafe<void>();
    const checkedAgain = Deferred.makeUnsafe<void>();
    let reads = 0;

    return withProcessor(
      {
        t3Gateway: {
          getTurnStatus: () =>
            Effect.gen(function* () {
              reads += 1;

              if (reads === 1) {
                yield* Deferred.succeed(recoveryRead, undefined);
                yield* Deferred.await(release);
              } else if (reads === 2) {
                yield* Deferred.succeed(checkedAgain, undefined);
              }

              return { turn: "active" as const };
            }),
        },
      },
      ({ processor, repository, pingActivity, findByThreadIdCalls, settle }) =>
        Effect.gen(function* () {
          yield* repository.upsert(threadCreated);

          const run = yield* processor.run.pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(recoveryRead);

          yield* pingActivity(defaultThreadId);
          yield* settle();

          // Recovery is still reading: no further read can have happened, and the waiting pass must not be re-resolving the thread in a retry loop.
          expect(reads).toBe(1);
          expect(findByThreadIdCalls()).toBe(1);

          yield* Deferred.succeed(release, undefined);
          yield* Deferred.await(checkedAgain);

          expect(reads).toBe(2);
          expect(findByThreadIdCalls()).toBe(1);

          yield* Fiber.interrupt(run);
        }),
    );
  });

  /*
    Activity that arrives for an exchange while the sweeper is reading it has to be read again after that pass, exactly as behind startup recovery: the sweeper drives the exchange through the same pass, so folding the ping into a pass that already observed the state would miss its event.
  */
  it.effect("waits for an in-flight sweep pass before checking the same exchange", () => {
    const release = Deferred.makeUnsafe<void>();
    const checkedAgain = Deferred.makeUnsafe<void>();
    let reads = 0;

    return withProcessor(
      {
        t3Gateway: {
          getTurnStatus: () =>
            Effect.gen(function* () {
              reads += 1;

              if (reads === 2) {
                yield* Deferred.await(release);
              } else if (reads === 3) {
                yield* Deferred.succeed(checkedAgain, undefined);
              }

              return { turn: "active" as const };
            }),
        },
      },
      ({ processor, repository, pingActivity, findByThreadIdCalls, settle }) =>
        Effect.gen(function* () {
          yield* repository.upsert(threadCreated);

          const run = yield* processor.run.pipe(Effect.forkChild({ startImmediately: true }));

          const sweepTookOver = () => reads >= 2;
          // Read 1 is startup recovery. The sweeper's delay starts once that pass ends, so keep advancing until the sweep takes read 2 and parks there.
          while (!sweepTookOver()) {
            yield* TestClock.adjust("1 minute");
            yield* Effect.yieldNow;
          }

          yield* pingActivity(defaultThreadId);
          yield* settle();

          // The sweep still owns the exchange: the ping waits without re-resolving the thread.
          expect(reads).toBe(2);
          expect(findByThreadIdCalls()).toBe(1);

          yield* Deferred.succeed(release, undefined);
          yield* Deferred.await(checkedAgain);

          expect(reads).toBe(3);
          expect(findByThreadIdCalls()).toBe(1);

          yield* Fiber.interrupt(run);
        }),
    );
  });

  /*
    A sweep that reaches an exchange whose activity pass is in flight skips it and moves on: waiting for that pass would let one busy exchange stall every later exchange, and every later sweep.
  */
  it.effect("skips an exchange whose pass is in flight when sweeping", () => {
    const recovered = Deferred.makeUnsafe<void>();
    const parked = Deferred.makeUnsafe<void>();
    const release = Deferred.makeUnsafe<void>();
    const otherThreadSweptAgain = Deferred.makeUnsafe<void>();
    let threadStatusReads = 0;
    let provisions = 0;
    let otherThreadReads = 0;

    return withProcessor(
      {
        t3Gateway: {
          getThreadStatus: () =>
            Effect.gen(function* () {
              threadStatusReads += 1;

              if (threadStatusReads === 1) {
                yield* Deferred.succeed(recovered, undefined);
                // Startup recovery leaves the planned exchange alone; the ping's pass then provisions it.
                return { thread: "unknown" as const };
              }

              return { thread: "missing" as const };
            }),
          getTurnStatus: () =>
            Effect.gen(function* () {
              otherThreadReads += 1;

              if (otherThreadReads === 3) {
                yield* Deferred.succeed(otherThreadSweptAgain, undefined);
              }

              return { turn: "active" as const };
            }),
          provisionThread: () =>
            Effect.gen(function* () {
              provisions += 1;
              yield* Deferred.succeed(parked, undefined);
              // Long enough that the pass is still in flight when the sweeps run.
              yield* Deferred.await(release);
            }),
        },
      },
      ({ processor, repository, pingActivity, findByThreadIdCalls }) =>
        Effect.gen(function* () {
          yield* repository.upsert(planned);
          yield* repository.upsert(secondThreadCreated);

          const run = yield* processor.run.pipe(Effect.forkChild({ startImmediately: true }));

          // Startup recovery reads the planned exchange first; the ping's pass then parks inside provisioning, owning the exchange across several sweep intervals.
          yield* Deferred.await(recovered);
          yield* pingActivity(defaultThreadId);
          yield* Deferred.await(parked);

          const otherThreadWasSwept = () => otherThreadReads >= 2;
          // The sweep's delay starts once recovery ends; each adjustment polls the sweep on.
          while (!otherThreadWasSwept()) {
            yield* TestClock.adjust("1 minute");
            yield* Effect.yieldNow;
          }

          // The other exchange was swept while the parked one was skipped, not waited on.
          expect(threadStatusReads).toBe(2);
          expect(provisions).toBe(1);

          yield* TestClock.adjust("1 minute");
          yield* Deferred.await(otherThreadSweptAgain);

          expect(threadStatusReads).toBe(2);
          expect(provisions).toBe(1);
          expect(findByThreadIdCalls()).toBe(1);

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
      ({ processor, repository, calls, awaitStoredTag, settle }) =>
        Effect.gen(function* () {
          yield* repository.upsert(threadCreated);

          const run = yield* processor.run.pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(startTurnStarted);

          // The attempt times out with the record untouched; nothing else wakes it.
          yield* TestClock.adjust("30 seconds");
          yield* settle();
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
      ({ processor, repository, calls, pingActivity, awaitStoredTag, settle }) =>
        Effect.gen(function* () {
          yield* repository.upsert(threadCreated);

          const run = yield* processor.run.pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(startTurnStarted);
          yield* TestClock.adjust("30 seconds");
          yield* settle();
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
    A redelivery is not stranded by a pass that times out: it reads the recorded request and returns immediately, and the abandoned pass leaves the record untouched.
  */
  it.effect("returns a redelivery while the first pass is still hung", () => {
    const planStarted = Deferred.makeUnsafe<void>();
    const planCutOff = Deferred.makeUnsafe<void>();

    return withProcessor(
      {
        t3Gateway: {
          planCoordinates: () =>
            Deferred.succeed(planStarted, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() => Deferred.succeed(planCutOff, undefined)),
            ),
        },
      },
      ({ processor, repository, calls }) =>
        Effect.gen(function* () {
          const run = yield* processor.run.pipe(Effect.forkChild({ startImmediately: true }));

          // Staggered off the sweep boundary so the plan timeout and a sweep cannot fall on the same clock tick.
          yield* TestClock.adjust("10 seconds");
          const acceptedAt = yield* Clock.currentTimeMillis;
          yield* processor.process(request, target);
          yield* Deferred.await(planStarted);

          // The record exists; the redelivery returns without waiting on the hung pass.
          const second = yield* processor
            .process(request, target)
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Fiber.join(second);

          // Planning's timeout is a minute, well inside the state's five.
          yield* TestClock.adjust("1 minute");
          // The cancelled read proves the timeout cut the pass off.
          yield* Deferred.await(planCutOff);

          // The redelivery found the record and planned nothing; the abandoned pass left it untouched.
          expect(calls.map((call) => `${call.service}.${call.method}`)).toEqual([
            "T3Gateway.planCoordinates",
          ]);
          expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(
            makeRequestAccepted(request, target, acceptedAt),
          );

          yield* Fiber.interrupt(run);
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
      ({ processor, repository, awaitStoredTag, settle }) =>
        Effect.gen(function* () {
          yield* repository.upsert(threadCreated);

          const run = yield* processor.run.pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(startTurnStarted);

          // The stuck exchange times out during startup recovery, leaving the record untouched.
          yield* TestClock.adjust("30 seconds");
          yield* settle();
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
