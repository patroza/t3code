import { type ProjectId, type ThreadId } from "@t3tools/contracts";
import * as NTBS from "./exchange.ts";
import { Context, Data, Effect, Semaphore, Stream } from "effect";
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

/**
 * Describes _where_ the T3 works goes. Necessary for creating worktrees, threads and starting turns.
 */
export type T3Target = {
  readonly projectId: ProjectId;
  /**
   * The starting point for the thread's worktree: the new branch is created from this one.
   *
   * Must be a branch that exists on `origin`; it is resolved there, so the worktree starts from the
   * latest remote commit even when the local copy is behind. Tags, commit SHAs and local-only
   * branches are rejected.
   *
   * Set by the platform-specific inbound code.
   */
  readonly startBranchName: string;
};

export class NTBSProcessorError extends Data.TaggedError("NTBSProcessorError")<{
  reason: string;
  cause: unknown;
}> {}

const SWEEP_INTERVAL = "1 minute";

export interface NTBSProcessor {
  /**
   * Handles a request coming from an external platform.
   *
   * Does no filtering: the caller decides whether a request deserves T3 work, and everything passed here starts it.
   *
   * Returns once the exchange is claimed and under way, not once the request is answered: the reply is posted later, when T3 reports the turn finished.
   *
   * Idempotent per `sourceUri`: a redelivery of an already-claimed request is a no-op, whatever state that exchange has reached. Concurrent deliveries of the same request are serialized, so only the first claims it.
   */
  readonly process: (
    request: NTBS.Request,
    t3Target: T3Target,
  ) => Effect.Effect<void, NTBSProcessorError>;

  /**
   * The main loop of the processor.
   * Subscribes to T3 activity, then resumes every non-terminal exchange. Subscribing first means nothing is missed while recovery runs. After that, an exchange moves when its T3 thread does, with a periodic sweep re-driving every non-terminal exchange as the backstop for missed activity pings.
   *
   * Never returns. It has no error channel: a failure on one exchange is logged and the next event is still processed.
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

    const createReplyFailure = (failure: {
      readonly reason: string;
      readonly cause: unknown;
    }): NTBS.ReplyFailure => ({
      type: "failure",
      text: failure.reason,
      cause: failure.cause,
    });

    const persist = <State extends NTBS.Exchange>(state: State) =>
      repo.upsert(state).pipe(orFail("Failed to persist the exchange state"), Effect.as(state));

    /**
     * Serializes concurrent work on the same sourceUri, protecting the check-then-act claim in `process` (findBySourceUri -> plan -> persist).
     * The lock is in-process memory: single-writer is an assumption on the deployment, not something the code or the database enforces.
     * Two processors on the same database would each pass the "no exchange yet" check, both claim, and the upsert would silently overwrite the first claim instead of failing.
     * TODO: If we ever run more than one processor, this needs remote locking or a claim that can lose (e.g. a unique insert on sourceUri that rejects the second claimer).
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

    const processRequestClaimed = Effect.fn("NTBSProcessor.processRequestClaimed")(function* (
      state: NTBS.RequestClaimed,
    ) {
      const context = yield* t3
        .getThreadStatus(state)
        .pipe(orFail("Failed to get the T3 thread status"));
      const decision = NTBS.fromRequestClaimed(state, context);

      switch (decision.type) {
        case "provision-thread": {
          // TODO: Quite sure there's low hanging fruits here
          const rejection = yield* t3.provisionThread(state).pipe(
            Effect.as(null),
            Effect.catchTag("FatalError", (error) => Effect.succeed(error)),
            orFail("Failed to provision the T3 thread"),
          );

          if (rejection !== null) {
            const next = yield* persist(NTBS.toReplyPending(state, createReplyFailure(rejection)));
            return transitionedTo(next);
          }

          break;
        }

        case "record-thread-created":
          break;
      }

      const threadCreated = yield* persist(NTBS.toThreadCreated(state));
      yield* adapter.acknowledge(threadCreated).pipe(
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
      const context = yield* t3
        .getTurnStatus(state)
        .pipe(orFail("Failed to get the T3 turn status"));
      const decision = NTBS.fromThreadCreated(state, context);

      switch (decision.type) {
        case "start-turn": {
          const rejection = yield* t3.startTurn(state).pipe(
            Effect.as(null),
            Effect.catchTag("FatalError", (error) => Effect.succeed(error)),
            orFail("Failed to start the T3 turn"),
          );

          if (rejection !== null) {
            const replyPending = yield* persist(
              NTBS.toReplyPending(state, createReplyFailure(rejection)),
            );
            return transitionedTo(replyPending);
          }

          return unchanged;
        }

        case "wait":
          return unchanged;

        case "record-reply-pending": {
          const next = yield* persist(NTBS.toReplyPending(state, decision.reply));
          return transitionedTo(next);
        }
      }
    });

    const processReplyPending = Effect.fn("NTBSProcessor.processReplyPending")(function* (
      state: NTBS.ReplyPending,
    ) {
      const replySourceUri = yield* adapter
        .findPostedReply(state)
        .pipe(orFail("Failed to find the posted platform reply"));
      const context: NTBS.ReplyPendingContext =
        replySourceUri === null
          ? { platformReply: "missing" }
          : { platformReply: "posted", replySourceUri };
      const decision = NTBS.fromReplyPending(state, context);

      switch (decision.type) {
        case "post-reply": {
          const delivery = yield* adapter.postReply(state).pipe(
            Effect.map((postedReplySourceUri) => ({
              type: "posted" as const,
              replySourceUri: postedReplySourceUri,
            })),
            Effect.catchTag("ReplyRejected", (error) =>
              Effect.succeed({ type: "rejected" as const, cause: error.cause }),
            ),
            orFail("Failed to post the platform reply"),
          );

          const next = yield* persist(
            delivery.type === "posted"
              ? NTBS.toReplyPosted(state, delivery.replySourceUri)
              : NTBS.toUndeliverable(state, delivery.cause),
          );
          return transitionedTo(next);
        }

        case "record-reply-posted": {
          const next = yield* persist(NTBS.toReplyPosted(state, decision.replySourceUri));
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
          case "request-claimed":
            result = yield* processRequestClaimed(state);
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
      t3Target: T3Target,
    ) {
      return yield* withExchangeLock(
        request.sourceUri,
        Effect.gen(function* () {
          /*
            1. Check whether an Exchange exists for this source URI.
            2. If there is already - we can return. We treat duplicate deliveries of requests with the same sourceUri as duplicates. No ops.
            3. If there isn't we get the t3 coordinates, save them and advance the exchange.
          */

          const existing = yield* repo
            .findBySourceUri(request.sourceUri)
            .pipe(orFail("Failed to find the exchange for the platform request"));

          if (existing !== null) {
            return;
          }

          const coordinates = yield* t3
            .planCoordinates(t3Target.projectId, t3Target.startBranchName)
            .pipe(orFail("Failed to plan the T3 work"));
          const claimed = NTBS.makeRequestClaimed(request, coordinates);
          yield* persist(claimed);
          yield* advanceExchange(claimed);
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
          Effect.logWarning("Failed to advance an exchange after T3 thread activity", {
            threadId,
            cause,
          }),
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
                Effect.logWarning("Failed to recover an exchange", {
                  sourceUri: exchange.sourceUri,
                  threadId: exchange.t3.threadId,
                  cause,
                }),
              ),
            ),
          { discard: true },
        ),
      ),
      Effect.catch((cause) =>
        Effect.logError("Failed to start exchange recovery", {
          cause,
        }),
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
