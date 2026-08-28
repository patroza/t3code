import { describe, expect, it } from "@effect/vitest";
import { MessageId, ProjectId, ThreadId } from "@t3tools/contracts";
import { Deferred, Effect, Fiber, Layer, Stream } from "effect";
import { AdapterError, NTBSAdapter, ReplyRejected } from "./adapter.ts";
import { ExchangeRepository, inMemoryExchangeRepository } from "./ExchangeRepository.ts";
import {
  makeRequestClaimed,
  toReplyPending,
  toReplyPosted,
  toThreadCreated,
  toUndeliverable,
  type Exchange,
  type ReplyPending,
  type ReplyPosted,
  type Request,
  type WorkCoordinates,
  type ThreadCreated,
} from "./exchange.ts";
import { makeNTBSProcessor, type NTBSProcessor, type T3Target } from "./processor.ts";
import { T3Gateway, RetryableError, FatalError } from "./t3gateway.ts";

/*
Every test in this module is about setting up the dependencies, and seeing what happens as we call `run` and `process` on the processor.
 */

const withTestProcessor = <A, E>(
  services: {
    readonly t3: Partial<T3Gateway>;
    readonly adapter: Partial<NTBSAdapter>;
  },
  test: (context: {
    readonly processor: NTBSProcessor;
    readonly repository: ExchangeRepository;
  }) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const processor = yield* makeNTBSProcessor;
    const repository = yield* ExchangeRepository;

    return yield* test({ processor, repository });
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(T3Gateway)({
          threadActivity: Stream.never,
          ...services.t3,
        }),
        Layer.mock(NTBSAdapter)(services.adapter),
        inMemoryExchangeRepository,
      ),
    ),
  );

const projectId = ProjectId.make("project-1");

const request: Request = {
  sourceUri: "test://request/1",
  snapshot: "Please fix the bug",
  attachments: [],
};

const target: T3Target = {
  projectId,
  startBranchName: "fork/dev",
};

const coordinates: WorkCoordinates = {
  projectId,
  startBranchName: "fork/dev",
  startCommitSha: "start-commit-sha",
  threadId: ThreadId.make("thread-1"),
  userMessageId: MessageId.make("message-1"),
  worktreeBranchName: "ntbs/thread-1",
};

const secondRequest: Request = {
  ...request,
  sourceUri: "test://request/2",
};

const secondCoordinates: WorkCoordinates = {
  ...coordinates,
  startCommitSha: "second-start-commit-sha",
  threadId: ThreadId.make("thread-2"),
  userMessageId: MessageId.make("message-2"),
  worktreeBranchName: "ntbs/thread-2",
};

const waitForStoredState = <State extends Exchange>(
  repository: ExchangeRepository,
  sourceUri: string,
  isExpected: (state: Exchange) => state is State,
) =>
  Effect.gen(function* () {
    while (true) {
      const state = yield* repository.findBySourceUri(sourceUri);

      if (state !== null && isExpected(state)) {
        return state;
      }

      yield* Effect.yieldNow;
    }
  });

describe("NTBSProcessor", () => {
  describe("process", () => {
    it.effect("starts a new request and ignores its sequential redelivery", () => {
      const t3Calls: Array<string> = [];
      const acknowledgements: Array<ThreadCreated> = [];

      return withTestProcessor(
        {
          t3: {
            planCoordinates: () =>
              Effect.sync(() => {
                t3Calls.push("planCoordinates");
                return coordinates;
              }),
            getThreadStatus: () =>
              Effect.sync(() => {
                t3Calls.push("getThreadStatus");
                return { thread: "missing" as const };
              }),
            provisionThread: () =>
              Effect.sync(() => {
                t3Calls.push("provisionThread");
              }),
            getTurnStatus: () =>
              Effect.sync(() => {
                t3Calls.push("getTurnStatus");
                return { turn: "missing" as const };
              }),
            startTurn: () =>
              Effect.sync(() => {
                t3Calls.push("startTurn");
              }),
          },
          adapter: {
            acknowledge: (state) =>
              Effect.sync(() => {
                acknowledgements.push(state);
              }),
          },
        },
        ({ processor, repository }) =>
          Effect.gen(function* () {
            yield* processor.process(request, target);
            yield* processor.process(request, target);

            const expected = toThreadCreated(makeRequestClaimed(request, coordinates));

            expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(expected);
            expect(acknowledgements).toEqual([expected]);
            expect(t3Calls).toEqual([
              "planCoordinates",
              "getThreadStatus",
              "provisionThread",
              "getTurnStatus",
              "startTurn",
            ]);
          }),
      );
    });

    it.effect("continues after a best-effort acknowledgement fails", () => {
      let acknowledgementCalls = 0;
      let startTurnCalls = 0;

      return withTestProcessor(
        {
          t3: {
            planCoordinates: () => Effect.succeed(coordinates),
            getThreadStatus: () => Effect.succeed({ thread: "present" }),
            getTurnStatus: () => Effect.succeed({ turn: "missing" }),
            startTurn: () =>
              Effect.sync(() => {
                startTurnCalls += 1;
              }),
          },
          adapter: {
            acknowledge: () =>
              Effect.gen(function* () {
                acknowledgementCalls += 1;
                return yield* new AdapterError({
                  reason: "The acknowledgement could not be posted",
                  cause: "test failure",
                });
              }),
          },
        },
        ({ processor, repository }) =>
          Effect.gen(function* () {
            yield* processor.process(request, target);

            expect(acknowledgementCalls).toBe(1);
            expect(startTurnCalls).toBe(1);
            expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(
              toThreadCreated(makeRequestClaimed(request, coordinates)),
            );
          }),
      );
    });

    it.effect("leaves an exchange unchanged while its turn is active", () => {
      let startTurnCalls = 0;
      let findReplyCalls = 0;
      let postReplyCalls = 0;

      return withTestProcessor(
        {
          t3: {
            planCoordinates: () => Effect.succeed(coordinates),
            getThreadStatus: () => Effect.succeed({ thread: "present" }),
            getTurnStatus: () => Effect.succeed({ turn: "active" }),
            startTurn: () =>
              Effect.sync(() => {
                startTurnCalls += 1;
              }),
          },
          adapter: {
            acknowledge: () => Effect.void,
            findPostedReply: () =>
              Effect.sync(() => {
                findReplyCalls += 1;
                return null;
              }),
            postReply: () =>
              Effect.sync(() => {
                postReplyCalls += 1;
                return "test://reply/unexpected";
              }),
          },
        },
        ({ processor, repository }) =>
          Effect.gen(function* () {
            yield* processor.process(request, target);

            expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(
              toThreadCreated(makeRequestClaimed(request, coordinates)),
            );
            expect(startTurnCalls).toBe(0);
            expect(findReplyCalls).toBe(0);
            expect(postReplyCalls).toBe(0);
          }),
      );
    });

    it.effect("retries a transient provisioning failure during later recovery", () => {
      const recoveredTurnStarted = Deferred.makeUnsafe<void>();
      let provisionCalls = 0;

      return withTestProcessor(
        {
          t3: {
            planCoordinates: () => Effect.succeed(coordinates),
            getThreadStatus: () => Effect.succeed({ thread: "missing" }),
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
            getTurnStatus: () => Effect.succeed({ turn: "missing" }),
            startTurn: () => Deferred.succeed(recoveredTurnStarted, undefined),
          },
          adapter: {
            acknowledge: () => Effect.void,
          },
        },
        ({ processor, repository }) =>
          Effect.gen(function* () {
            expect((yield* Effect.exit(processor.process(request, target)))._tag).toBe("Failure");

            const claimed = makeRequestClaimed(request, coordinates);
            expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(claimed);

            const run = yield* processor.run.pipe(Effect.forkChild({ startImmediately: true }));

            yield* Deferred.await(recoveredTurnStarted);

            expect(provisionCalls).toBe(2);
            expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(
              toThreadCreated(claimed),
            );

            yield* Fiber.interrupt(run);
          }),
      );
    });

    it.effect("retries a transient turn-start failure during later recovery", () => {
      const recoveredTurnStarted = Deferred.makeUnsafe<void>();
      let startTurnCalls = 0;

      return withTestProcessor(
        {
          t3: {
            planCoordinates: () => Effect.succeed(coordinates),
            getThreadStatus: () => Effect.succeed({ thread: "present" }),
            getTurnStatus: () => Effect.succeed({ turn: "missing" }),
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

                yield* Deferred.succeed(recoveredTurnStarted, undefined);
              }),
          },
          adapter: {
            acknowledge: () => Effect.void,
          },
        },
        ({ processor, repository }) =>
          Effect.gen(function* () {
            expect((yield* Effect.exit(processor.process(request, target)))._tag).toBe("Failure");

            const threadCreated = toThreadCreated(makeRequestClaimed(request, coordinates));
            expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(threadCreated);

            const run = yield* processor.run.pipe(Effect.forkChild({ startImmediately: true }));

            yield* Deferred.await(recoveredTurnStarted);

            expect(startTurnCalls).toBe(2);
            expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(threadCreated);

            yield* Fiber.interrupt(run);
          }),
      );
    });
  });

  describe("source serialization", () => {
    it.effect("serializes concurrent deliveries of the same request", () => {
      const firstPlanStarted = Deferred.makeUnsafe<void>();
      const releaseFirstPlan = Deferred.makeUnsafe<void>();
      const t3Calls: Array<string> = [];
      const acknowledgements: Array<ThreadCreated> = [];
      let planCalls = 0;

      return withTestProcessor(
        {
          t3: {
            planCoordinates: () =>
              Effect.gen(function* () {
                planCalls += 1;
                t3Calls.push("planCoordinates");

                if (planCalls === 1) {
                  yield* Deferred.succeed(firstPlanStarted, undefined);
                  yield* Deferred.await(releaseFirstPlan);
                }

                return coordinates;
              }),
            getThreadStatus: () =>
              Effect.sync(() => {
                t3Calls.push("getThreadStatus");
                return { thread: "missing" as const };
              }),
            provisionThread: () =>
              Effect.sync(() => {
                t3Calls.push("provisionThread");
              }),
            getTurnStatus: () =>
              Effect.sync(() => {
                t3Calls.push("getTurnStatus");
                return { turn: "missing" as const };
              }),
            startTurn: () =>
              Effect.sync(() => {
                t3Calls.push("startTurn");
              }),
          },
          adapter: {
            acknowledge: (state) =>
              Effect.sync(() => {
                acknowledgements.push(state);
              }),
          },
        },
        ({ processor, repository }) =>
          Effect.gen(function* () {
            const first = yield* processor
              .process(request, target)
              .pipe(Effect.forkChild({ startImmediately: true }));

            // The first request now holds the source lock inside planCoordinates.
            yield* Deferred.await(firstPlanStarted);

            const second = yield* processor
              .process(request, target)
              .pipe(Effect.forkChild({ startImmediately: true }));

            expect(planCalls).toBe(1);
            expect(second.pollUnsafe()).toBeUndefined();
            expect(yield* repository.findBySourceUri(request.sourceUri)).toBeNull();

            yield* Deferred.succeed(releaseFirstPlan, undefined);
            yield* Fiber.join(first);
            yield* Fiber.join(second);

            const expected = toThreadCreated(makeRequestClaimed(request, coordinates));

            expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(expected);
            expect(acknowledgements).toEqual([expected]);
            expect(t3Calls).toEqual([
              "planCoordinates",
              "getThreadStatus",
              "provisionThread",
              "getTurnStatus",
              "startTurn",
            ]);
          }),
      );
    });

    it.effect("lets a queued delivery claim after the first fails before persistence", () => {
      const firstPlanStarted = Deferred.makeUnsafe<void>();
      const releaseFirstPlan = Deferred.makeUnsafe<void>();
      const acknowledgements: Array<ThreadCreated> = [];
      let planCalls = 0;
      let provisionCalls = 0;
      let startTurnCalls = 0;

      return withTestProcessor(
        {
          t3: {
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

                return coordinates;
              }),
            getThreadStatus: () => Effect.succeed({ thread: "missing" }),
            provisionThread: () =>
              Effect.sync(() => {
                provisionCalls += 1;
              }),
            getTurnStatus: () => Effect.succeed({ turn: "missing" }),
            startTurn: () =>
              Effect.sync(() => {
                startTurnCalls += 1;
              }),
          },
          adapter: {
            acknowledge: (state) =>
              Effect.sync(() => {
                acknowledgements.push(state);
              }),
          },
        },
        ({ processor, repository }) =>
          Effect.gen(function* () {
            const first = yield* processor
              .process(request, target)
              .pipe(Effect.forkChild({ startImmediately: true }));

            yield* Deferred.await(firstPlanStarted);

            const second = yield* processor
              .process(request, target)
              .pipe(Effect.forkChild({ startImmediately: true }));

            expect(planCalls).toBe(1);
            expect(second.pollUnsafe()).toBeUndefined();
            expect(yield* repository.findBySourceUri(request.sourceUri)).toBeNull();

            yield* Deferred.succeed(releaseFirstPlan, undefined);

            expect((yield* Fiber.await(first))._tag).toBe("Failure");
            yield* Fiber.join(second);

            const expected = toThreadCreated(makeRequestClaimed(request, coordinates));

            expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(expected);
            expect(acknowledgements).toEqual([expected]);
            expect(planCalls).toBe(2);
            expect(provisionCalls).toBe(1);
            expect(startTurnCalls).toBe(1);
          }),
      );
    });

    it.effect("retains a failed claim for later recovery and ignores its queued redelivery", () => {
      const threadStatusStarted = Deferred.makeUnsafe<void>();
      const releaseThreadStatus = Deferred.makeUnsafe<void>();
      const recoveredTurnStarted = Deferred.makeUnsafe<void>();
      let planCalls = 0;
      let threadStatusCalls = 0;
      let provisionCalls = 0;
      let startTurnCalls = 0;

      return withTestProcessor(
        {
          t3: {
            planCoordinates: () =>
              Effect.sync(() => {
                planCalls += 1;
                return coordinates;
              }),
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
            provisionThread: () =>
              Effect.sync(() => {
                provisionCalls += 1;
              }),
            getTurnStatus: () => Effect.succeed({ turn: "missing" }),
            startTurn: () =>
              Effect.gen(function* () {
                startTurnCalls += 1;
                yield* Deferred.succeed(recoveredTurnStarted, undefined);
              }),
          },
          adapter: {
            acknowledge: () => Effect.void,
          },
        },
        ({ processor, repository }) =>
          Effect.gen(function* () {
            const first = yield* processor
              .process(request, target)
              .pipe(Effect.forkChild({ startImmediately: true }));

            yield* Deferred.await(threadStatusStarted);

            const claimed = makeRequestClaimed(request, coordinates);
            expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(claimed);

            const second = yield* processor
              .process(request, target)
              .pipe(Effect.forkChild({ startImmediately: true }));

            expect(second.pollUnsafe()).toBeUndefined();
            expect(planCalls).toBe(1);
            expect(threadStatusCalls).toBe(1);

            yield* Deferred.succeed(releaseThreadStatus, undefined);

            expect((yield* Fiber.await(first))._tag).toBe("Failure");
            yield* Fiber.join(second);

            expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(claimed);
            expect(planCalls).toBe(1);
            expect(threadStatusCalls).toBe(1);

            const run = yield* processor.run.pipe(Effect.forkChild({ startImmediately: true }));

            yield* Deferred.await(recoveredTurnStarted);

            expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(
              toThreadCreated(claimed),
            );
            expect(planCalls).toBe(1);
            expect(threadStatusCalls).toBe(2);
            expect(provisionCalls).toBe(1);
            expect(startTurnCalls).toBe(1);

            yield* Fiber.interrupt(run);
          }),
      );
    });

    it.effect("releases the source lock when its holder is interrupted", () => {
      const firstPlanStarted = Deferred.makeUnsafe<void>();
      const keepFirstPlanBlocked = Deferred.makeUnsafe<void>();
      const acknowledgements: Array<ThreadCreated> = [];
      let planCalls = 0;
      let provisionCalls = 0;
      let startTurnCalls = 0;

      return withTestProcessor(
        {
          t3: {
            planCoordinates: () =>
              Effect.gen(function* () {
                planCalls += 1;

                if (planCalls === 1) {
                  yield* Deferred.succeed(firstPlanStarted, undefined);
                  yield* Deferred.await(keepFirstPlanBlocked);
                }

                return coordinates;
              }),
            getThreadStatus: () => Effect.succeed({ thread: "missing" }),
            provisionThread: () =>
              Effect.sync(() => {
                provisionCalls += 1;
              }),
            getTurnStatus: () => Effect.succeed({ turn: "missing" }),
            startTurn: () =>
              Effect.sync(() => {
                startTurnCalls += 1;
              }),
          },
          adapter: {
            acknowledge: (state) =>
              Effect.sync(() => {
                acknowledgements.push(state);
              }),
          },
        },
        ({ processor, repository }) =>
          Effect.gen(function* () {
            const first = yield* processor
              .process(request, target)
              .pipe(Effect.forkChild({ startImmediately: true }));

            yield* Deferred.await(firstPlanStarted);

            const second = yield* processor
              .process(request, target)
              .pipe(Effect.forkChild({ startImmediately: true }));

            expect(planCalls).toBe(1);
            expect(second.pollUnsafe()).toBeUndefined();
            expect(yield* repository.findBySourceUri(request.sourceUri)).toBeNull();

            yield* Fiber.interrupt(first);
            expect((yield* Fiber.await(first))._tag).toBe("Failure");
            yield* Fiber.join(second);

            const expected = toThreadCreated(makeRequestClaimed(request, coordinates));

            expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(expected);
            expect(acknowledgements).toEqual([expected]);
            expect(planCalls).toBe(2);
            expect(provisionCalls).toBe(1);
            expect(startTurnCalls).toBe(1);
          }),
      );
    });

    it.effect("interrupting a queued delivery preserves the lock for later deliveries", () => {
      const firstPlanStarted = Deferred.makeUnsafe<void>();
      const releaseFirstPlan = Deferred.makeUnsafe<void>();
      const t3Calls: Array<string> = [];
      const acknowledgements: Array<ThreadCreated> = [];
      let planCalls = 0;

      return withTestProcessor(
        {
          t3: {
            planCoordinates: () =>
              Effect.gen(function* () {
                planCalls += 1;
                t3Calls.push("planCoordinates");

                if (planCalls === 1) {
                  yield* Deferred.succeed(firstPlanStarted, undefined);
                  yield* Deferred.await(releaseFirstPlan);
                }

                return coordinates;
              }),
            getThreadStatus: () =>
              Effect.sync(() => {
                t3Calls.push("getThreadStatus");
                return { thread: "missing" as const };
              }),
            provisionThread: () =>
              Effect.sync(() => {
                t3Calls.push("provisionThread");
              }),
            getTurnStatus: () =>
              Effect.sync(() => {
                t3Calls.push("getTurnStatus");
                return { turn: "missing" as const };
              }),
            startTurn: () =>
              Effect.sync(() => {
                t3Calls.push("startTurn");
              }),
          },
          adapter: {
            acknowledge: (state) =>
              Effect.sync(() => {
                acknowledgements.push(state);
              }),
          },
        },
        ({ processor, repository }) =>
          Effect.gen(function* () {
            const first = yield* processor
              .process(request, target)
              .pipe(Effect.forkChild({ startImmediately: true }));

            yield* Deferred.await(firstPlanStarted);

            const interruptedWaiter = yield* processor
              .process(request, target)
              .pipe(Effect.forkChild({ startImmediately: true }));

            expect(planCalls).toBe(1);
            expect(interruptedWaiter.pollUnsafe()).toBeUndefined();

            yield* Fiber.interrupt(interruptedWaiter);
            expect((yield* Fiber.await(interruptedWaiter))._tag).toBe("Failure");
            expect(first.pollUnsafe()).toBeUndefined();
            expect(yield* repository.findBySourceUri(request.sourceUri)).toBeNull();

            const later = yield* processor
              .process(request, target)
              .pipe(Effect.forkChild({ startImmediately: true }));

            expect(planCalls).toBe(1);
            expect(later.pollUnsafe()).toBeUndefined();

            yield* Deferred.succeed(releaseFirstPlan, undefined);
            yield* Fiber.join(first);
            yield* Fiber.join(later);

            const expected = toThreadCreated(makeRequestClaimed(request, coordinates));

            expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(expected);
            expect(acknowledgements).toEqual([expected]);
            expect(t3Calls).toEqual([
              "planCoordinates",
              "getThreadStatus",
              "provisionThread",
              "getTurnStatus",
              "startTurn",
            ]);
          }),
      );
    });

    it.effect("allows different requests to proceed concurrently", () => {
      const firstPlanStarted = Deferred.makeUnsafe<void>();
      const releaseFirstPlan = Deferred.makeUnsafe<void>();
      const secondPlanStarted = Deferred.makeUnsafe<void>();
      const acknowledgements: Array<ThreadCreated> = [];
      let planCalls = 0;
      let provisionCalls = 0;
      let startTurnCalls = 0;

      return withTestProcessor(
        {
          t3: {
            planCoordinates: () =>
              Effect.gen(function* () {
                planCalls += 1;

                if (planCalls === 1) {
                  yield* Deferred.succeed(firstPlanStarted, undefined);
                  yield* Deferred.await(releaseFirstPlan);
                  return coordinates;
                }

                yield* Deferred.succeed(secondPlanStarted, undefined);
                return secondCoordinates;
              }),
            getThreadStatus: () => Effect.succeed({ thread: "missing" }),
            provisionThread: () =>
              Effect.sync(() => {
                provisionCalls += 1;
              }),
            getTurnStatus: () => Effect.succeed({ turn: "missing" }),
            startTurn: () =>
              Effect.sync(() => {
                startTurnCalls += 1;
              }),
          },
          adapter: {
            acknowledge: (state) =>
              Effect.sync(() => {
                acknowledgements.push(state);
              }),
          },
        },
        ({ processor, repository }) =>
          Effect.gen(function* () {
            const first = yield* processor
              .process(request, target)
              .pipe(Effect.forkChild({ startImmediately: true }));

            yield* Deferred.await(firstPlanStarted);

            const second = yield* processor
              .process(secondRequest, target)
              .pipe(Effect.forkChild({ startImmediately: true }));

            expect(yield* Deferred.isDone(secondPlanStarted)).toBe(true);
            yield* Fiber.join(second);

            const expectedSecond = toThreadCreated(
              makeRequestClaimed(secondRequest, secondCoordinates),
            );

            expect(first.pollUnsafe()).toBeUndefined();
            expect(yield* repository.findBySourceUri(request.sourceUri)).toBeNull();
            expect(yield* repository.findBySourceUri(secondRequest.sourceUri)).toEqual(
              expectedSecond,
            );
            expect(acknowledgements).toEqual([expectedSecond]);
            expect(planCalls).toBe(2);
            expect(provisionCalls).toBe(1);
            expect(startTurnCalls).toBe(1);

            yield* Deferred.succeed(releaseFirstPlan, undefined);
            yield* Fiber.join(first);

            const expectedFirst = toThreadCreated(makeRequestClaimed(request, coordinates));

            expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(expectedFirst);
            expect(acknowledgements).toEqual([expectedSecond, expectedFirst]);
            expect(planCalls).toBe(2);
            expect(provisionCalls).toBe(2);
            expect(startTurnCalls).toBe(2);
          }),
      );
    });
  });

  describe("run", () => {
    it.effect("resumes non-terminal exchanges when run starts", () => {
      const replyPosted = Deferred.makeUnsafe<void>();
      const reply = {
        type: "answer" as const,
        text: "Recovered reply",
      };
      const replySourceUri = "test://reply/recovered";
      const postedReplies: Array<ReplyPending> = [];

      return withTestProcessor(
        {
          t3: {
            getTurnStatus: () =>
              Effect.succeed({
                turn: "completed",
                reply,
              }),
          },
          adapter: {
            findPostedReply: () => Effect.succeed(null),
            postReply: (state) =>
              Effect.gen(function* () {
                postedReplies.push(state);
                yield* Deferred.succeed(replyPosted, undefined);
                return replySourceUri;
              }),
          },
        },
        ({ processor, repository }) =>
          Effect.gen(function* () {
            const threadCreated = toThreadCreated(makeRequestClaimed(request, coordinates));
            yield* repository.upsert(threadCreated);

            const run = yield* processor.run.pipe(Effect.forkChild({ startImmediately: true }));

            yield* Deferred.await(replyPosted);

            const replyPending = toReplyPending(threadCreated, reply);
            const expected = toReplyPosted(replyPending, replySourceUri);

            expect(postedReplies).toEqual([replyPending]);
            expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(expected);

            yield* Fiber.interrupt(run);
          }),
      );
    });

    it.effect("routes thread activity only for stored exchanges", () => {
      const unknownActivity = Deferred.makeUnsafe<ThreadId>();
      const storedActivity = Deferred.makeUnsafe<ThreadId>();
      const replyPosted = Deferred.makeUnsafe<void>();
      const reply = {
        type: "answer" as const,
        text: "Reply after thread activity",
      };
      const replySourceUri = "test://reply/activity";
      const observedThreads: Array<ThreadId> = [];

      return withTestProcessor(
        {
          t3: {
            threadActivity: Stream.concat(
              Stream.fromEffect(Deferred.await(unknownActivity)),
              Stream.fromEffect(Deferred.await(storedActivity)),
            ),
            getTurnStatus: (state) =>
              Effect.sync(() => {
                observedThreads.push(state.t3.threadId);
                return {
                  turn: "completed" as const,
                  reply,
                };
              }),
          },
          adapter: {
            findPostedReply: () => Effect.succeed(null),
            postReply: () =>
              Effect.gen(function* () {
                yield* Deferred.succeed(replyPosted, undefined);
                return replySourceUri;
              }),
          },
        },
        ({ processor, repository }) =>
          Effect.gen(function* () {
            const run = yield* processor.run.pipe(Effect.forkChild({ startImmediately: true }));

            // Startup recovery has already observed the empty repository.
            const threadCreated = toThreadCreated(makeRequestClaimed(request, coordinates));
            yield* repository.upsert(threadCreated);

            yield* Deferred.succeed(unknownActivity, ThreadId.make("unknown-thread"));
            yield* Deferred.succeed(storedActivity, coordinates.threadId);
            yield* Deferred.await(replyPosted);

            const expected = toReplyPosted(toReplyPending(threadCreated, reply), replySourceUri);

            expect(observedThreads).toEqual([coordinates.threadId]);
            expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(expected);

            yield* Fiber.interrupt(run);
          }),
      );
    });

    it.effect("serializes thread activity with a redelivered request", () => {
      const threadActivity = Deferred.makeUnsafe<ThreadId>();
      const turnStatusStarted = Deferred.makeUnsafe<void>();
      const releaseTurnStatus = Deferred.makeUnsafe<void>();
      const replyPosted = Deferred.makeUnsafe<void>();
      const reply = {
        type: "answer" as const,
        text: "Reply from thread activity",
      };
      const replySourceUri = "test://reply/activity-race";
      const postedReplies: Array<ReplyPending> = [];

      return withTestProcessor(
        {
          t3: {
            threadActivity: Stream.fromEffect(Deferred.await(threadActivity)),
            getTurnStatus: () =>
              Effect.gen(function* () {
                yield* Deferred.succeed(turnStatusStarted, undefined);
                yield* Deferred.await(releaseTurnStatus);
                return {
                  turn: "completed" as const,
                  reply,
                };
              }),
          },
          adapter: {
            findPostedReply: () => Effect.succeed(null),
            postReply: (state) =>
              Effect.gen(function* () {
                postedReplies.push(state);
                yield* Deferred.succeed(replyPosted, undefined);
                return replySourceUri;
              }),
          },
        },
        ({ processor, repository }) =>
          Effect.gen(function* () {
            const run = yield* processor.run.pipe(Effect.forkChild({ startImmediately: true }));

            const threadCreated = toThreadCreated(makeRequestClaimed(request, coordinates));
            yield* repository.upsert(threadCreated);
            yield* Deferred.succeed(threadActivity, coordinates.threadId);
            yield* Deferred.await(turnStatusStarted);

            const redelivery = yield* processor
              .process(request, target)
              .pipe(Effect.forkChild({ startImmediately: true }));

            expect(redelivery.pollUnsafe()).toBeUndefined();
            expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(threadCreated);

            yield* Deferred.succeed(releaseTurnStatus, undefined);
            yield* Deferred.await(replyPosted);
            yield* Fiber.join(redelivery);

            const replyPending = toReplyPending(threadCreated, reply);
            const expected = toReplyPosted(replyPending, replySourceUri);

            expect(postedReplies).toEqual([replyPending]);
            expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(expected);

            yield* Fiber.interrupt(run);
          }),
      );
    });

    it.effect("serializes startup recovery with a redelivered request", () => {
      const turnStatusStarted = Deferred.makeUnsafe<void>();
      const releaseTurnStatus = Deferred.makeUnsafe<void>();
      const replyPosted = Deferred.makeUnsafe<void>();
      const reply = {
        type: "answer" as const,
        text: "Reply from startup recovery",
      };
      const replySourceUri = "test://reply/recovery-race";
      const postedReplies: Array<ReplyPending> = [];

      return withTestProcessor(
        {
          t3: {
            getTurnStatus: () =>
              Effect.gen(function* () {
                yield* Deferred.succeed(turnStatusStarted, undefined);
                yield* Deferred.await(releaseTurnStatus);
                return {
                  turn: "completed" as const,
                  reply,
                };
              }),
          },
          adapter: {
            findPostedReply: () => Effect.succeed(null),
            postReply: (state) =>
              Effect.gen(function* () {
                postedReplies.push(state);
                yield* Deferred.succeed(replyPosted, undefined);
                return replySourceUri;
              }),
          },
        },
        ({ processor, repository }) =>
          Effect.gen(function* () {
            const threadCreated = toThreadCreated(makeRequestClaimed(request, coordinates));
            yield* repository.upsert(threadCreated);

            const run = yield* processor.run.pipe(Effect.forkChild({ startImmediately: true }));

            yield* Deferred.await(turnStatusStarted);

            const redelivery = yield* processor
              .process(request, target)
              .pipe(Effect.forkChild({ startImmediately: true }));

            expect(redelivery.pollUnsafe()).toBeUndefined();
            expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(threadCreated);

            yield* Deferred.succeed(releaseTurnStatus, undefined);
            yield* Deferred.await(replyPosted);
            yield* Fiber.join(redelivery);

            const replyPending = toReplyPending(threadCreated, reply);
            const expected = toReplyPosted(replyPending, replySourceUri);

            expect(postedReplies).toEqual([replyPending]);
            expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(expected);

            yield* Fiber.interrupt(run);
          }),
      );
    });

    it.effect("retries a transient turn-status failure on later thread activity", () => {
      const firstStatusFinished = Deferred.makeUnsafe<void>();
      const threadActivity = Deferred.makeUnsafe<ThreadId>();
      const reply = {
        type: "answer" as const,
        text: "Reply after retrying turn status",
      };
      const replySourceUri = "test://reply/turn-status-retry";
      let statusCalls = 0;

      return withTestProcessor(
        {
          t3: {
            threadActivity: Stream.fromEffect(Deferred.await(threadActivity)),
            getTurnStatus: () => {
              statusCalls += 1;

              return statusCalls === 1
                ? Effect.fail(
                    new RetryableError({
                      reason: "Turn status temporarily unavailable",
                      cause: "test failure",
                      method: "getTurnStatus",
                    }),
                  ).pipe(Effect.ensuring(Deferred.succeed(firstStatusFinished, undefined)))
                : Effect.succeed({ turn: "completed" as const, reply });
            },
          },
          adapter: {
            findPostedReply: () => Effect.succeed(null),
            postReply: () => Effect.succeed(replySourceUri),
          },
        },
        ({ processor, repository }) =>
          Effect.gen(function* () {
            const threadCreated = toThreadCreated(makeRequestClaimed(request, coordinates));
            yield* repository.upsert(threadCreated);

            const run = yield* processor.run.pipe(Effect.forkChild({ startImmediately: true }));

            yield* Deferred.await(firstStatusFinished);
            yield* Deferred.succeed(threadActivity, coordinates.threadId);

            const posted = yield* waitForStoredState(
              repository,
              request.sourceUri,
              (state): state is ReplyPosted => state.tag === "reply-posted",
            );

            expect(statusCalls).toBe(2);
            expect(posted).toEqual(
              toReplyPosted(toReplyPending(threadCreated, reply), replySourceUri),
            );

            yield* Fiber.interrupt(run);
          }),
      );
    });

    it.effect("continues startup recovery after one exchange fails", () => {
      const reply = {
        type: "answer" as const,
        text: "Reply recovered after another exchange failed",
      };
      const replySourceUri = "test://reply/recovery-continued";
      let failingSourceUri = "";
      let successfulSourceUri = "";
      const postedSources: Array<string> = [];

      return withTestProcessor(
        {
          t3: {},
          adapter: {
            findPostedReply: (state) =>
              state.sourceUri === failingSourceUri
                ? Effect.fail(
                    new AdapterError({
                      reason: "Recovery failed for this exchange",
                      cause: "test failure",
                    }),
                  )
                : Effect.succeed(null),
            postReply: (state) =>
              Effect.sync(() => {
                postedSources.push(state.sourceUri);
                return replySourceUri;
              }),
          },
        },
        ({ processor, repository }) =>
          Effect.gen(function* () {
            const firstPending = toReplyPending(
              toThreadCreated(makeRequestClaimed(request, coordinates)),
              reply,
            );
            const secondPending = toReplyPending(
              toThreadCreated(makeRequestClaimed(secondRequest, secondCoordinates)),
              reply,
            );
            yield* repository.upsert(firstPending);
            yield* repository.upsert(secondPending);

            const recoveryOrder = yield* repository.findNonTerminalExchanges;
            failingSourceUri = recoveryOrder[0]!.sourceUri;
            successfulSourceUri = recoveryOrder[1]!.sourceUri;

            const run = yield* processor.run.pipe(Effect.forkChild({ startImmediately: true }));
            const posted = yield* waitForStoredState(
              repository,
              successfulSourceUri,
              (state): state is ReplyPosted => state.tag === "reply-posted",
            );
            const expectedFailing =
              failingSourceUri === firstPending.sourceUri ? firstPending : secondPending;
            const expectedSuccessful =
              successfulSourceUri === firstPending.sourceUri ? firstPending : secondPending;

            expect(yield* repository.findBySourceUri(failingSourceUri)).toEqual(expectedFailing);
            expect(posted).toEqual(toReplyPosted(expectedSuccessful, replySourceUri));
            expect(postedSources).toEqual([successfulSourceUri]);

            yield* Fiber.interrupt(run);
          }),
      );
    });

    it.effect("continues processing thread activity after one event fails", () => {
      const startupStatusRead = Deferred.makeUnsafe<void>();
      const firstActivity = Deferred.makeUnsafe<ThreadId>();
      const firstActivityFinished = Deferred.makeUnsafe<void>();
      const secondActivity = Deferred.makeUnsafe<ThreadId>();
      const reply = {
        type: "answer" as const,
        text: "Reply from the later activity event",
      };
      const replySourceUri = "test://reply/later-activity";
      let firstExchangeStatusCalls = 0;
      let secondExchangeStatusCalls = 0;

      return withTestProcessor(
        {
          t3: {
            threadActivity: Stream.concat(
              Stream.fromEffect(Deferred.await(firstActivity)),
              Stream.fromEffect(Deferred.await(secondActivity)),
            ),
            getTurnStatus: (state) => {
              if (state.sourceUri === request.sourceUri) {
                firstExchangeStatusCalls += 1;

                if (firstExchangeStatusCalls === 1) {
                  return Deferred.succeed(startupStatusRead, undefined).pipe(
                    Effect.as({ turn: "active" as const }),
                  );
                }

                return Effect.fail(
                  new RetryableError({
                    reason: "This activity event could not be processed",
                    cause: "test failure",
                    method: "getTurnStatus",
                  }),
                ).pipe(Effect.ensuring(Deferred.succeed(firstActivityFinished, undefined)));
              }

              secondExchangeStatusCalls += 1;
              return Effect.succeed({ turn: "completed" as const, reply });
            },
          },
          adapter: {
            findPostedReply: () => Effect.succeed(null),
            postReply: () => Effect.succeed(replySourceUri),
          },
        },
        ({ processor, repository }) =>
          Effect.gen(function* () {
            const firstThreadCreated = toThreadCreated(makeRequestClaimed(request, coordinates));
            yield* repository.upsert(firstThreadCreated);

            const run = yield* processor.run.pipe(Effect.forkChild({ startImmediately: true }));

            yield* Deferred.await(startupStatusRead);

            const secondThreadCreated = toThreadCreated(
              makeRequestClaimed(secondRequest, secondCoordinates),
            );
            yield* repository.upsert(secondThreadCreated);
            yield* Deferred.succeed(firstActivity, coordinates.threadId);
            yield* Deferred.await(firstActivityFinished);
            yield* Deferred.succeed(secondActivity, secondCoordinates.threadId);

            const posted = yield* waitForStoredState(
              repository,
              secondRequest.sourceUri,
              (state): state is ReplyPosted => state.tag === "reply-posted",
            );

            expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(
              firstThreadCreated,
            );
            expect(firstExchangeStatusCalls).toBe(2);
            expect(secondExchangeStatusCalls).toBe(1);
            expect(posted).toEqual(
              toReplyPosted(toReplyPending(secondThreadCreated, reply), replySourceUri),
            );

            yield* Fiber.interrupt(run);
          }),
      );
    });

    it.effect("subscribes to thread activity before startup recovery finishes", () => {
      const recoveryStarted = Deferred.makeUnsafe<void>();
      const releaseRecovery = Deferred.makeUnsafe<void>();
      const threadActivity = Deferred.makeUnsafe<ThreadId>();
      const reply = {
        type: "answer" as const,
        text: "Reply posted while startup recovery is blocked",
      };
      const replySourceUri = "test://reply/during-recovery";

      return withTestProcessor(
        {
          t3: {
            threadActivity: Stream.fromEffect(Deferred.await(threadActivity)),
            getTurnStatus: (state) =>
              state.sourceUri === request.sourceUri
                ? Effect.gen(function* () {
                    yield* Deferred.succeed(recoveryStarted, undefined);
                    yield* Deferred.await(releaseRecovery);
                    return { turn: "active" as const };
                  })
                : Effect.succeed({ turn: "completed" as const, reply }),
          },
          adapter: {
            findPostedReply: () => Effect.succeed(null),
            postReply: () => Effect.succeed(replySourceUri),
          },
        },
        ({ processor, repository }) =>
          Effect.gen(function* () {
            const recovering = toThreadCreated(makeRequestClaimed(request, coordinates));
            yield* repository.upsert(recovering);

            const run = yield* processor.run.pipe(Effect.forkChild({ startImmediately: true }));
            yield* Deferred.await(recoveryStarted);

            const activeDuringRecovery = toThreadCreated(
              makeRequestClaimed(secondRequest, secondCoordinates),
            );
            yield* repository.upsert(activeDuringRecovery);
            yield* Deferred.succeed(threadActivity, secondCoordinates.threadId);

            const posted = yield* waitForStoredState(
              repository,
              secondRequest.sourceUri,
              (state): state is ReplyPosted => state.tag === "reply-posted",
            );

            expect(yield* Deferred.isDone(releaseRecovery)).toBe(false);
            expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(recovering);
            expect(posted).toEqual(
              toReplyPosted(toReplyPending(activeDuringRecovery, reply), replySourceUri),
            );

            yield* Deferred.succeed(releaseRecovery, undefined);
            yield* Fiber.interrupt(run);
          }),
      );
    });

    it.effect("posts once when startup recovery races with thread activity", () => {
      const threadActivity = Deferred.makeUnsafe<ThreadId>();
      const activityHandled = Deferred.makeUnsafe<void>();
      const turnStatusStarted = Deferred.makeUnsafe<void>();
      const releaseTurnStatus = Deferred.makeUnsafe<void>();
      const secondTurnStatusStarted = Deferred.makeUnsafe<void>();
      const reply = {
        type: "answer" as const,
        text: "Reply from the recovery and activity race",
      };
      const replySourceUri = "test://reply/recovery-activity-race";
      let turnStatusCalls = 0;
      let postCalls = 0;

      return withTestProcessor(
        {
          t3: {
            threadActivity: Stream.concat(
              Stream.fromEffect(Deferred.await(threadActivity)),
              Stream.fromEffect(
                Deferred.succeed(activityHandled, undefined).pipe(
                  Effect.as(ThreadId.make("activity-handled")),
                ),
              ),
            ),
            getTurnStatus: () =>
              Effect.gen(function* () {
                turnStatusCalls += 1;

                if (turnStatusCalls === 1) {
                  yield* Deferred.succeed(turnStatusStarted, undefined);
                  yield* Deferred.await(releaseTurnStatus);
                } else {
                  yield* Deferred.succeed(secondTurnStatusStarted, undefined);
                }

                return { turn: "completed" as const, reply };
              }),
          },
          adapter: {
            findPostedReply: () => Effect.succeed(null),
            postReply: () =>
              Effect.sync(() => {
                postCalls += 1;
                return replySourceUri;
              }),
          },
        },
        ({ processor, repository }) =>
          Effect.gen(function* () {
            const threadCreated = toThreadCreated(makeRequestClaimed(request, coordinates));
            yield* repository.upsert(threadCreated);

            const run = yield* processor.run.pipe(Effect.forkChild({ startImmediately: true }));
            yield* Deferred.await(turnStatusStarted);
            yield* Deferred.succeed(threadActivity, coordinates.threadId);
            yield* Effect.yieldNow;

            expect(yield* Deferred.isDone(secondTurnStatusStarted)).toBe(false);

            yield* Deferred.succeed(releaseTurnStatus, undefined);
            yield* Deferred.await(activityHandled);

            const posted = yield* waitForStoredState(
              repository,
              request.sourceUri,
              (state): state is ReplyPosted => state.tag === "reply-posted",
            );

            expect(turnStatusCalls).toBe(1);
            expect(postCalls).toBe(1);
            expect(posted).toEqual(
              toReplyPosted(toReplyPending(threadCreated, reply), replySourceUri),
            );

            yield* Fiber.interrupt(run);
          }),
      );
    });
  });

  describe("reply delivery", () => {
    it.effect("retries a transient reply-posting failure during later recovery", () => {
      const firstPostFinished = Deferred.makeUnsafe<void>();
      const reply = {
        type: "answer" as const,
        text: "Reply after a transient posting failure",
      };
      const replySourceUri = "test://reply/retried-post";
      let postCalls = 0;

      return withTestProcessor(
        {
          t3: {},
          adapter: {
            findPostedReply: () => Effect.succeed(null),
            postReply: () => {
              postCalls += 1;

              return postCalls === 1
                ? Effect.fail(
                    new AdapterError({
                      reason: "Reply posting temporarily failed",
                      cause: "test failure",
                    }),
                  ).pipe(Effect.ensuring(Deferred.succeed(firstPostFinished, undefined)))
                : Effect.succeed(replySourceUri);
            },
          },
        },
        ({ processor, repository }) =>
          Effect.gen(function* () {
            const pending = toReplyPending(
              toThreadCreated(makeRequestClaimed(request, coordinates)),
              reply,
            );
            yield* repository.upsert(pending);

            const firstRun = yield* processor.run.pipe(
              Effect.forkChild({ startImmediately: true }),
            );

            yield* Deferred.await(firstPostFinished);
            yield* Fiber.interrupt(firstRun);

            expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(pending);

            const secondRun = yield* processor.run.pipe(
              Effect.forkChild({ startImmediately: true }),
            );
            const posted = yield* waitForStoredState(
              repository,
              request.sourceUri,
              (state): state is ReplyPosted => state.tag === "reply-posted",
            );

            expect(postCalls).toBe(2);
            expect(posted).toEqual(toReplyPosted(pending, replySourceUri));

            yield* Fiber.interrupt(secondRun);
          }),
      );
    });

    it.effect("retries reply discovery before posting during later recovery", () => {
      const firstDiscoveryFinished = Deferred.makeUnsafe<void>();
      const reply = {
        type: "answer" as const,
        text: "Reply after a transient discovery failure",
      };
      const replySourceUri = "test://reply/retried-discovery";
      let findCalls = 0;
      let postCalls = 0;

      return withTestProcessor(
        {
          t3: {},
          adapter: {
            findPostedReply: () => {
              findCalls += 1;

              return findCalls === 1
                ? Effect.fail(
                    new AdapterError({
                      reason: "Reply discovery temporarily failed",
                      cause: "test failure",
                    }),
                  ).pipe(Effect.ensuring(Deferred.succeed(firstDiscoveryFinished, undefined)))
                : Effect.succeed(null);
            },
            postReply: () =>
              Effect.sync(() => {
                postCalls += 1;
                return replySourceUri;
              }),
          },
        },
        ({ processor, repository }) =>
          Effect.gen(function* () {
            const pending = toReplyPending(
              toThreadCreated(makeRequestClaimed(request, coordinates)),
              reply,
            );
            yield* repository.upsert(pending);

            const firstRun = yield* processor.run.pipe(
              Effect.forkChild({ startImmediately: true }),
            );

            yield* Deferred.await(firstDiscoveryFinished);
            yield* Fiber.interrupt(firstRun);

            expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(pending);
            expect(postCalls).toBe(0);

            const secondRun = yield* processor.run.pipe(
              Effect.forkChild({ startImmediately: true }),
            );
            const posted = yield* waitForStoredState(
              repository,
              request.sourceUri,
              (state): state is ReplyPosted => state.tag === "reply-posted",
            );

            expect(findCalls).toBe(2);
            expect(postCalls).toBe(1);
            expect(posted).toEqual(toReplyPosted(pending, replySourceUri));

            yield* Fiber.interrupt(secondRun);
          }),
      );
    });

    it.effect("records a reply already found on the platform without posting it again", () => {
      const reply = {
        type: "answer" as const,
        text: "Already delivered",
      };
      const discoveredReplySourceUri = "test://reply/already-posted";
      const findCalls: Array<ReplyPending> = [];
      let postCalls = 0;

      return withTestProcessor(
        {
          t3: {},
          adapter: {
            findPostedReply: (state) =>
              Effect.sync(() => {
                findCalls.push(state);
                return discoveredReplySourceUri;
              }),
            postReply: () =>
              Effect.sync(() => {
                postCalls += 1;
                return "test://reply/unexpected";
              }),
          },
        },
        ({ processor, repository }) =>
          Effect.gen(function* () {
            const threadCreated = toThreadCreated(makeRequestClaimed(request, coordinates));
            const replyPending = toReplyPending(threadCreated, reply);
            yield* repository.upsert(replyPending);

            const run = yield* processor.run.pipe(Effect.forkChild({ startImmediately: true }));

            const expected = toReplyPosted(replyPending, discoveredReplySourceUri);

            expect(findCalls).toEqual([replyPending]);
            expect(postCalls).toBe(0);
            expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(expected);

            yield* Fiber.interrupt(run);
          }),
      );
    });

    it.effect("records a definitively rejected reply as undeliverable", () => {
      const reply = {
        type: "answer" as const,
        text: "Reply that cannot be delivered",
      };
      const rejectionCause = {
        message: "The originating discussion was deleted",
      };
      const postCalls: Array<ReplyPending> = [];

      return withTestProcessor(
        {
          t3: {},
          adapter: {
            findPostedReply: () => Effect.succeed(null),
            postReply: (state) =>
              Effect.gen(function* () {
                postCalls.push(state);
                return yield* new ReplyRejected({ cause: rejectionCause });
              }),
          },
        },
        ({ processor, repository }) =>
          Effect.gen(function* () {
            const threadCreated = toThreadCreated(makeRequestClaimed(request, coordinates));
            const replyPending = toReplyPending(threadCreated, reply);
            yield* repository.upsert(replyPending);

            const run = yield* processor.run.pipe(Effect.forkChild({ startImmediately: true }));

            const expected = toUndeliverable(replyPending, rejectionCause);

            expect(postCalls).toEqual([replyPending]);
            expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(expected);

            yield* Fiber.interrupt(run);
          }),
      );
    });

    it.effect("delivers a failure reply when T3 rejects thread provisioning", () => {
      const rejectionReason = "T3 cannot provision this request";
      const rejectionCause = {
        message: "The selected project no longer exists",
      };
      const replySourceUri = "test://reply/provisioning-failure";
      const postedReplies: Array<ReplyPending> = [];
      let provisionCalls = 0;
      let acknowledgementCalls = 0;

      return withTestProcessor(
        {
          t3: {
            planCoordinates: () => Effect.succeed(coordinates),
            getThreadStatus: () => Effect.succeed({ thread: "missing" }),
            provisionThread: () =>
              Effect.gen(function* () {
                provisionCalls += 1;
                return yield* new FatalError({
                  reason: rejectionReason,
                  cause: rejectionCause,
                  method: "provisionThread",
                });
              }),
          },
          adapter: {
            acknowledge: () =>
              Effect.sync(() => {
                acknowledgementCalls += 1;
              }),
            findPostedReply: () => Effect.succeed(null),
            postReply: (state) =>
              Effect.sync(() => {
                postedReplies.push(state);
                return replySourceUri;
              }),
          },
        },
        ({ processor, repository }) =>
          Effect.gen(function* () {
            yield* processor.process(request, target);

            const claimed = makeRequestClaimed(request, coordinates);
            const failureReply = {
              type: "failure" as const,
              text: rejectionReason,
              cause: rejectionCause,
              method: "startTurn",
            };
            const replyPending = toReplyPending(claimed, failureReply);
            const expected = toReplyPosted(replyPending, replySourceUri);

            expect(provisionCalls).toBe(1);
            expect(acknowledgementCalls).toBe(0);
            expect(postedReplies).toEqual([replyPending]);
            expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(expected);
          }),
      );
    });

    it.effect("delivers a failure reply when T3 rejects turn start", () => {
      const rejectionReason = "T3 cannot start the turn";
      const rejectionCause = {
        message: "The configured provider is unavailable",
      };
      const replySourceUri = "test://reply/turn-start-failure";
      const acknowledgements: Array<ThreadCreated> = [];
      const postedReplies: Array<ReplyPending> = [];
      let startTurnCalls = 0;

      return withTestProcessor(
        {
          t3: {
            planCoordinates: () => Effect.succeed(coordinates),
            getThreadStatus: () => Effect.succeed({ thread: "present" }),
            getTurnStatus: () => Effect.succeed({ turn: "missing" }),
            startTurn: () =>
              Effect.gen(function* () {
                startTurnCalls += 1;
                return yield* new FatalError({
                  reason: rejectionReason,
                  cause: rejectionCause,
                  method: "startTurn",
                });
              }),
          },
          adapter: {
            acknowledge: (state) =>
              Effect.sync(() => {
                acknowledgements.push(state);
              }),
            findPostedReply: () => Effect.succeed(null),
            postReply: (state) =>
              Effect.sync(() => {
                postedReplies.push(state);
                return replySourceUri;
              }),
          },
        },
        ({ processor, repository }) =>
          Effect.gen(function* () {
            yield* processor.process(request, target);

            const threadCreated = toThreadCreated(makeRequestClaimed(request, coordinates));
            const failureReply = {
              type: "failure" as const,
              text: rejectionReason,
              cause: rejectionCause,
            };
            const replyPending = toReplyPending(threadCreated, failureReply);
            const expected = toReplyPosted(replyPending, replySourceUri);

            expect(startTurnCalls).toBe(1);
            expect(acknowledgements).toEqual([threadCreated]);
            expect(postedReplies).toEqual([replyPending]);
            expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(expected);
          }),
      );
    });

    it.effect("posts a completed T3 reply", () => {
      const reply = {
        type: "answer" as const,
        text: "The bug is fixed.",
      };
      const replySourceUri = "test://reply/1";
      const postedReplies: Array<ReplyPending> = [];

      return withTestProcessor(
        {
          t3: {
            planCoordinates: () => Effect.succeed(coordinates),
            getThreadStatus: () => Effect.succeed({ thread: "present" }),
            getTurnStatus: () =>
              Effect.succeed({
                turn: "completed",
                reply,
              }),
          },
          adapter: {
            acknowledge: () => Effect.void,
            findPostedReply: () => Effect.succeed(null),
            postReply: (state) =>
              Effect.sync(() => {
                postedReplies.push(state);
                return replySourceUri;
              }),
          },
        },
        ({ processor, repository }) =>
          Effect.gen(function* () {
            yield* processor.process(request, target);

            const threadCreated = toThreadCreated(makeRequestClaimed(request, coordinates));
            const replyPending = toReplyPending(threadCreated, reply);
            const expected = toReplyPosted(replyPending, replySourceUri);

            expect(postedReplies).toEqual([replyPending]);
            expect(yield* repository.findBySourceUri(request.sourceUri)).toEqual(expected);
          }),
      );
    });
  });
});
