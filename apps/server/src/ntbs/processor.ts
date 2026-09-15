import { type ThreadId } from "@t3tools/contracts";
import * as NTBS from "./exchange.ts";
import { Cause, Clock, Context, Data, Duration, Effect, Result, Semaphore, Stream } from "effect";
import { NTBSAdapter } from "./adapter.ts";
import { T3Gateway } from "./t3gateway.ts";
import { ExchangeRepository } from "./ExchangeRepository.ts";

/*
The processor is the executor and orchestrator of non-turn-based surfaces: it applies the business rules and connects T3 to the external platform. It does so through three services:

- the adapter: communication with the external platform
- the T3 gateway: communication and dispatching of T3 internals
- the exchange repository: durable link between the two, stores the exchange state

It exposes two public APIs:
1. `process` takes an incoming message and starts the work for it.
2. `run` subscribes to T3 activity and resumes the exchanges a previous run left unfinished.

`run` also owns an internal sweeper: a periodic pass that re-drives every non-terminal exchange, the same thing startup recovery does but on an interval.
Thread activity is the primary wake signal, but it is a fire-and-forget ping: without the sweeper one missed event would leave an exchange stuck until the next restart.
Sweeping is cheap and safe because the cycle observes before acting: re-driving an exchange whose context has not moved just answers "wait" and stops.

Both drive an exchange through the same cycle, repeated until it reaches a terminal state:

load the stored state
-> read live context from the service that owns it
-> decide what to do given state and context
-> execute the decision
-> build the resulting state transition and persist it

The cycle is replay safe: it observes before acting, so a crash or a redelivered message re-runs it without starting a second thread or posting a second reply.
*/

export class NTBSProcessorError extends Data.TaggedError("NTBSProcessorError")<{
  reason: string;
  cause: unknown;
}> {}

const SWEEP_INTERVAL = "1 minute";

/*
  The following timeouts limit how long the NTBS processor waits for specific external events.

  E.g. the processor cannot hang forever waiting the response of a database query or for T3 to start a turn.

  With those we can make the user experience and business logic more linear and a stuck dependency cannot block the processing of an exchange forever.

  E.g. if `yield someReadOperation` remains stuck, without timeouts the processing would fall in a limbo forever with the processor holding the exchange's lock forever.
*/
const OBSERVE_TIMEOUT = Duration.toMillis(Duration.seconds(10));
const PLAN_COORDINATES_TIMEOUT = Duration.toMillis(Duration.minutes(1));
const PROVISION_THREAD_TIMEOUT = Duration.toMillis(Duration.minutes(5));
const START_TURN_TIMEOUT = Duration.toMillis(Duration.seconds(30));
const POST_REPLY_TIMEOUT = Duration.toMillis(Duration.seconds(30));
const ACKNOWLEDGE_TIMEOUT = Duration.toMillis(Duration.seconds(10));

/**
 * TODO: Evaluate whether we can turn both observe and act below in one generic `attempt` helper.
 * Also evaluate whether we need `Result` at all.
 */

/**
 * Checks external state without letting an unanswered check hold the exchange lock forever.
 * The caller decides what to do with the failed observation.
 */
const observeWithTimeout = Effect.fn("NTBSProcessor.observeWithTimeout")(function* <A, E, R>(
  state: NTBS.NonTerminalExchange,
  effect: Effect.Effect<A, E, R>,
) {
  const now = yield* Clock.currentTimeMillis;
  const remaining = NTBS.expiresAt(state) - now;
  const timeout = remaining > 0 ? Math.min(OBSERVE_TIMEOUT, remaining) : OBSERVE_TIMEOUT;
  return yield* effect.pipe(Effect.timeout(timeout), Effect.result);
});

/**
 * Action equivalent of observeWithTimeout with one major difference: while observe allows for one additional execution after expiry, `act` does not retry.
 * */
const act = Effect.fn("NTBSProcessor.act")(function* <A, E, R>(
  state: NTBS.NonTerminalExchange,
  effect: Effect.Effect<A, E, R>,
  limit: number,
) {
  const now = yield* Clock.currentTimeMillis;
  const remaining = NTBS.expiresAt(state) - now;
  if (remaining <= 0) {
    return yield* new Cause.TimeoutError();
  }

  // A timeout cannot trigger a cleanup.
  // It is not possible to undo queueing a command or the act of posting a platform response. The next attempt after a timeout should first re-observe the situation again.
  return yield* effect.pipe(Effect.timeout(Math.min(limit, remaining)));
});

export interface NTBSProcessor {
  /**
   * Handles a request coming from an external platform.
   *
   * Does no filtering: the caller decides whether a request deserves T3 work, and everything passed here starts it.
   *
   * Returns once the request is recorded, not once it is answered: the reply is posted later, when T3 reports the turn finished.
   * Fails with a typed error only when the repository does. Anything that fails after the record dies; `run` retries the recorded exchange.
   *
   * Idempotent per `sourceUri`: a redelivery of an already-recorded request is a no-op, whatever state that exchange has reached. Concurrent deliveries of the same request are serialized, so only the first records it.
   */
  readonly process: (
    request: NTBS.Request,
    t3Target: NTBS.T3Target,
  ) => Effect.Effect<void, NTBSProcessorError>;

  /**
   * The main loop of the processor.
   * Subscribes to T3 activity, then resumes every non-terminal exchange. Subscribing first means nothing is missed while recovery runs. After that, an exchange moves when its T3 thread does, with a periodic sweep re-driving every non-terminal exchange as the backstop for missed activity pings.
   *
   * Expected failures are logged without stopping subsequent activity or sweeps.
   */
  readonly run: Effect.Effect<void>;
}

export const makeNTBSProcessorTag = (key: string) => Context.Service<NTBSProcessor>(key);

type TransitionResult =
  | {
      readonly type: "transitioned";
      readonly state: NTBS.Exchange;
    }
  | {
      readonly type: "unchanged";
    };

type NTBSProcessorRequirements =
  /*
    Communicates with the external platform. Which platform is decided by the context the processor is built in.
  */
  | NTBSAdapter
  /*
    Creates worktrees and threads, starts turns, reports their progress, and provides the stream of T3 thread activity.
  */
  | T3Gateway
  /*
    Stores and loads the exchange state, including the exchanges a previous run left unfinished.
  */
  | ExchangeRepository;

type ExchangeLock = {
  readonly semaphore: Semaphore.Semaphore;
  callers: number;
};

/**
 * Builds a processor for the adapter found in the context.
 *
 * Build one per platform, each with its own adapter provided.
 *
 * TODO: Consider collapsing to a single runtime processor with one routing adapter that reads the platform from the sourceUri scheme (jira://, discord://) and delegates to the platform adapter.
 * The current one-per-platform design has an unenforced assumption: `findNonTerminalExchanges` returns every stored exchange with no platform filter, so processors sharing a repository would re-drive each other's exchanges through the wrong adapter during recovery and sweeps.
 * A single processor also means one lock map, one activity subscription, one sweeper, and retires `makeNTBSProcessorTag`.
 */
export const makeNTBSProcessor: Effect.Effect<NTBSProcessor, never, NTBSProcessorRequirements> =
  Effect.gen(function* () {
    const adapter = yield* NTBSAdapter;
    const t3 = yield* T3Gateway;
    const repo = yield* ExchangeRepository;

    const orFail = (reason: string) =>
      Effect.mapError((cause: unknown) => new NTBSProcessorError({ reason, cause }));

    const transitionedTo = (state: NTBS.Exchange): TransitionResult => ({
      type: "transitioned",
      state,
    });

    const unchanged: TransitionResult = { type: "unchanged" };

    const persist = <State extends NTBS.Exchange>(state: State) =>
      repo.upsert(state).pipe(orFail("Failed to persist the exchange state"), Effect.as(state));

    const expire = Effect.fn("NTBSProcessor.expire")(function* (
      state: NTBS.NonTerminalExchange,
      now: number,
    ) {
      const next = yield* persist(
        state.tag === "reply-pending"
          ? NTBS.toUndeliverable(
              state,
              { message: "The platform did not accept the reply in time." },
              now,
            )
          : NTBS.toExpired(state, now),
      );
      return transitionedTo(next);
    });

    /**
     * Serializes concurrent work on the same sourceUri, protecting the check-then-act record in `process` (findBySourceUri -> persist).
     * The lock is in-process memory: single-writer is an assumption on the deployment, not something the code or the database enforces.
     * Two processors on the same database would each pass the "no exchange yet" check, both record, and the upsert would silently overwrite the first record instead of failing.
     * TODO: If we ever run more than one processor, this needs remote locking or a record that can lose (e.g. a unique insert on sourceUri that rejects the second writer).
     */
    const exchangeLocks = new Map<string, ExchangeLock>();

    const withExchangeLock = <A, E, R>(sourceUri: string, effect: Effect.Effect<A, E, R>) =>
      Effect.suspend(() => {
        let lock = exchangeLocks.get(sourceUri);

        if (lock === undefined) {
          lock = {
            semaphore: Semaphore.makeUnsafe(1),
            callers: 0,
          };
          exchangeLocks.set(sourceUri, lock);
        }

        lock.callers += 1;

        return lock.semaphore.withPermit(effect).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              lock.callers -= 1;
              if (lock.callers === 0 && exchangeLocks.get(sourceUri) === lock) {
                exchangeLocks.delete(sourceUri);
              }
            }),
          ),
        );
      });

    const processRequestAccepted = Effect.fn("NTBSProcessor.processRequestAccepted")(function* (
      state: NTBS.RequestAccepted,
    ) {
      const now = yield* Clock.currentTimeMillis;
      const decision = NTBS.fromRequestAccepted(state, now);

      switch (decision.type) {
        case "expire": {
          return yield* expire(state, now);
        }

        case "plan": {
          // Planning creates nothing in T3, so there is nothing to observe first: plan, then record the outcome.
          const outcome = yield* act(
            state,
            t3.planCoordinates(state.target.projectId, state.target.startBranchName),
            PLAN_COORDINATES_TIMEOUT,
          ).pipe(Effect.result);
          const completedAt = yield* Clock.currentTimeMillis;
          if (Result.isFailure(outcome)) {
            if (outcome.failure._tag !== "FatalError") {
              return yield* new NTBSProcessorError({
                reason: "Failed to plan the T3 work",
                cause: outcome.failure,
              });
            }
            const next = yield* persist(NTBS.toRejected(state, outcome.failure, completedAt));
            return transitionedTo(next);
          }
          const next = yield* persist(NTBS.toWorkPlanned(state, outcome.success, completedAt));
          return transitionedTo(next);
        }
      }
    });

    const processWorkPlanned = Effect.fn("NTBSProcessor.processWorkPlanned")(function* (
      state: NTBS.WorkPlanned,
    ) {
      const observation = yield* observeWithTimeout(state, t3.getThreadStatus(state));
      const now = yield* Clock.currentTimeMillis;
      const context: NTBS.WorkPlannedContext = Result.isFailure(observation)
        ? { thread: "unknown" }
        : observation.success;
      if (Result.isFailure(observation)) {
        yield* Effect.logWarning("Could not check whether the NTBS thread exists", {
          sourceUri: state.sourceUri,
          cause: observation.failure,
        });
      }
      const decision = NTBS.fromWorkPlanned(state, context, now);

      switch (decision.type) {
        case "expire": {
          return yield* expire(state, now);
        }

        case "provision-thread": {
          // TODO: Quite sure there's low hanging fruits here
          const rejection = yield* act(
            state,
            t3.provisionThread(state),
            PROVISION_THREAD_TIMEOUT,
          ).pipe(
            Effect.as(null),
            Effect.catchTag("FatalError", (error) => Effect.succeed(error)),
            orFail("Failed to provision the T3 thread"),
          );

          if (rejection !== null) {
            const completedAt = yield* Clock.currentTimeMillis;
            const next = yield* persist(NTBS.toRejected(state, rejection, completedAt));
            return transitionedTo(next);
          }

          break;
        }

        case "record-thread-created":
          break;

        case "wait":
          return unchanged;
      }

      const completedAt = yield* Clock.currentTimeMillis;
      const threadCreated = yield* persist(NTBS.toThreadCreated(state, completedAt));
      yield* adapter.acknowledge(threadCreated).pipe(
        Effect.timeout(ACKNOWLEDGE_TIMEOUT),
        Effect.catch((cause) =>
          Effect.logWarning("Failed to post the NTBS acknowledgement", {
            sourceUri: threadCreated.sourceUri,
            threadId: threadCreated.t3.threadId,
            cause,
          }),
        ),
      );
      return transitionedTo(threadCreated);
    });

    const processThreadCreated = Effect.fn("NTBSProcessor.processThreadCreated")(function* (
      state: NTBS.ThreadCreated,
    ) {
      const observation = yield* observeWithTimeout(state, t3.getTurnStatus(state));
      const now = yield* Clock.currentTimeMillis;
      const context: NTBS.ThreadCreatedContext = Result.isFailure(observation)
        ? { turn: "unknown" }
        : observation.success;
      if (Result.isFailure(observation)) {
        yield* Effect.logWarning("Could not check the NTBS turn", {
          sourceUri: state.sourceUri,
          cause: observation.failure,
        });
      }
      const decision = NTBS.fromThreadCreated(state, context, now);

      switch (decision.type) {
        case "expire": {
          return yield* expire(state, now);
        }

        case "start-turn": {
          const rejection = yield* act(state, t3.startTurn(state), START_TURN_TIMEOUT).pipe(
            Effect.as(null),
            Effect.catchTag("FatalError", (error) => Effect.succeed(error)),
            orFail("Failed to start the T3 turn"),
          );

          if (rejection !== null) {
            const completedAt = yield* Clock.currentTimeMillis;
            const replyPending = yield* persist(NTBS.toRejected(state, rejection, completedAt));
            return transitionedTo(replyPending);
          }

          return unchanged;
        }

        case "wait":
          return unchanged;

        case "record-reply-pending": {
          const next = yield* persist(NTBS.toReplyPending(state, decision.reply, now));
          return transitionedTo(next);
        }
      }
    });

    const processReplyPending = Effect.fn("NTBSProcessor.processReplyPending")(function* (
      state: NTBS.ReplyPending,
    ) {
      const observation = yield* observeWithTimeout(state, adapter.findPostedReply(state));
      const now = yield* Clock.currentTimeMillis;
      const context: NTBS.ReplyPendingContext = Result.isFailure(observation)
        ? { platformReply: "unknown" }
        : observation.success === null
          ? { platformReply: "missing" }
          : { platformReply: "posted", replySourceUri: observation.success };
      if (Result.isFailure(observation)) {
        yield* Effect.logWarning("Could not check whether the NTBS reply was posted", {
          sourceUri: state.sourceUri,
          cause: observation.failure,
        });
      }
      const decision = NTBS.fromReplyPending(state, context, now);

      switch (decision.type) {
        case "expire": {
          return yield* expire(state, now);
        }

        case "post-reply": {
          const delivery = yield* act(state, adapter.postReply(state), POST_REPLY_TIMEOUT).pipe(
            Effect.map((postedReplySourceUri) => ({
              type: "posted" as const,
              replySourceUri: postedReplySourceUri,
            })),
            Effect.catchTag("ReplyRejected", (error) =>
              Effect.succeed({ type: "rejected" as const, cause: error.cause }),
            ),
            orFail("Failed to post the platform reply"),
          );

          const completedAt = yield* Clock.currentTimeMillis;
          const next = yield* persist(
            delivery.type === "posted"
              ? NTBS.toReplyPosted(state, delivery.replySourceUri, completedAt)
              : NTBS.toUndeliverable(state, delivery.cause, completedAt),
          );
          return transitionedTo(next);
        }

        case "wait":
          return unchanged;

        case "record-reply-posted": {
          const next = yield* persist(NTBS.toReplyPosted(state, decision.replySourceUri, now));
          return transitionedTo(next);
        }
      }
    });

    const advanceExchange = Effect.fn("NTBSProcessor.advanceExchange")(function* (
      initial: NTBS.Exchange,
    ) {
      let state = initial;

      while (NTBS.isNonTerminal(state)) {
        let result: TransitionResult;

        switch (state.tag) {
          case "request-accepted":
            result = yield* processRequestAccepted(state);
            break;

          case "work-planned":
            result = yield* processWorkPlanned(state);
            break;

          case "thread-created":
            result = yield* processThreadCreated(state);
            break;

          case "reply-pending":
            result = yield* processReplyPending(state);
            break;
        }

        if (result.type === "unchanged") {
          return;
        }

        state = result.state;
      }
    });

    const advanceSavedExchange = Effect.fn("NTBSProcessor.advanceSavedExchange")(function* (
      sourceUri: string,
    ) {
      return yield* withExchangeLock(
        sourceUri,
        Effect.gen(function* () {
          const exchange = yield* repo
            .findBySourceUri(sourceUri)
            .pipe(orFail("Failed to reload the exchange"));

          if (exchange === null || NTBS.isTerminal(exchange)) {
            return;
          }

          yield* advanceExchange(exchange);
        }),
      );
    });

    const process = Effect.fn("NTBSProcessor.process")(function* (
      request: NTBS.Request,
      t3Target: NTBS.T3Target,
    ) {
      return yield* withExchangeLock(
        request.sourceUri,
        Effect.gen(function* () {
          /*
            1. Check whether an Exchange exists for this source URI.
            2. If there is already - we can return. We treat duplicate deliveries of requests with the same sourceUri as duplicates. No ops.
            3. If there isn't we record the request as accepted and advance the exchange.
            From the record on, a failure is the exchange's to keep, not the caller's: it is left for `run` to retry.
          */

          const existing = yield* repo
            .findBySourceUri(request.sourceUri)
            .pipe(orFail("Failed to find the exchange for the platform request"));

          if (existing !== null) {
            return;
          }

          const now = yield* Clock.currentTimeMillis;
          const accepted = yield* persist(NTBS.makeRequestAccepted(request, t3Target, now));
          yield* advanceExchange(accepted).pipe(Effect.orDie);
        }),
      );
    });

    const processThreadActivity = Effect.fn("NTBSProcessor.processThreadActivity")(function* (
      threadId: ThreadId,
    ) {
      const exchange = yield* repo
        .findByThreadId(threadId)
        .pipe(orFail("Failed to find the exchange for the active T3 thread"));

      if (exchange !== null) {
        yield* advanceSavedExchange(exchange.sourceUri);
      }
    });

    const subscribeToThreadActivity = Stream.runForEach(t3.threadActivity, (threadId) =>
      processThreadActivity(threadId).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Failed to process NTBS thread activity", { threadId, cause }),
        ),
      ),
    );

    const resumeNonTerminalExchanges = repo.findNonTerminalExchanges.pipe(
      orFail("Failed to load non-terminal exchanges"),
      Effect.flatMap((exchanges) =>
        Effect.forEach(
          exchanges,
          (exchange) =>
            advanceSavedExchange(exchange.sourceUri).pipe(
              Effect.catch((cause) =>
                Effect.logWarning("Failed to resume the NTBS exchange", {
                  sourceUri: exchange.sourceUri,
                  cause,
                }),
              ),
            ),
          { discard: true },
        ),
      ),
      Effect.catch((cause) =>
        Effect.logWarning("Failed to load NTBS exchanges for recovery", { cause }),
      ),
    );

    /*
      The sweeper: the same pass as startup recovery, repeated on an interval for the whole life of `run`.
      Thread activity is the primary wake signal but it is fire-and-forget: a ping missed while the process is up would otherwise strand its exchange until the next restart.
      Redundant sweeps are safe and cheap because the cycle observes before acting: an exchange whose context has not moved answers "wait" and stops.
      The interval is a judgment call, low enough that a stranded exchange recovers within a tolerable wait for whoever asked, high enough that the periodic query stays negligible.
      Delay first: `run` has just swept via startup recovery, so an immediate first pass would be pure noise.
    */
    const sweepNonTerminalExchanges = resumeNonTerminalExchanges.pipe(
      Effect.delay(SWEEP_INTERVAL),
      Effect.forever,
    );

    const run = Effect.scoped(
      Effect.gen(function* () {
        yield* subscribeToThreadActivity.pipe(Effect.forkScoped({ startImmediately: true }));
        yield* resumeNonTerminalExchanges;
        return yield* sweepNonTerminalExchanges;
      }),
    );

    return {
      process,
      run,
    };
  });
