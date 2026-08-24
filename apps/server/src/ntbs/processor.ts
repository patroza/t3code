import { type ProjectId } from "@t3tools/contracts";
import type * as NTBS from "./exchange.ts";
import { makeRequestClaimed } from "./exchange.ts";
import { Context, Data, Effect } from "effect";
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
   * The starting point for the thread's worktree: the new branch is created from this ref.
   *
   * Usually a branch name such as `main`. Before use it is resolved against `origin`, so the worktree starts from the latest remote commit even when the local copy of the branch is behind. A commit SHA is also accepted and is used as-is.
   *
   * Set by the platform-specific inbound code.
   */
  readonly baseRef: string;
};

export class NTBSProcessorError extends Data.TaggedError("NTBSProcessorError")<{
  reason: string;
  cause: unknown;
}> {}

export interface NTBSProcessor {
  /**
   * Claims one external request and drives its exchange.
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
   * Subscribes to T3 activity, then resumes every non-terminal exchange. Subscribing first means nothing is missed while recovery runs. After that, an exchange only moves when its T3 thread does.
   *
   * Never returns. It has no error channel: a failure on one exchange is logged and the next event is still processed.
   */
  readonly run: Effect.Effect<void>;
}

export const makeNTBSProcessorTag = (key: string) => Context.Service<NTBSProcessor>(key);

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

/**
 * Builds a processor for the adapter found in the context.
 *
 * Build one per platform, each with its own adapter provided.
 */
export const makeNTBSProcessor: Effect.Effect<NTBSProcessor, never, NTBSProcessorRequirements> =
  Effect.gen(function* () {
    const adapter = yield* NTBSAdapter;
    const t3 = yield* T3Gateway;
    const repo = yield* ExchangeRepository;

    const orFail = (reason: string) =>
      Effect.mapError((cause: unknown) => new NTBSProcessorError({ reason, cause }));

    /*
      Handles an external request in this order:

      1. Ask the adapter whether this platform request already has a recorded
      `ThreadCreated` or `ResponsePosted`.
      If yes - stop. . If no - continue
      2. Create the worktree and T3 thread.
      3. Generate the first user message ID and record it with ThreadCreated.
      4. Start the first T3 turn with that message ID, the snapshot, and attachments.
      5. Attempt to post the acknowledgement independently.
    */
    const process = (request: NTBS.Request, t3Context: T3Target) =>
      Effect.gen(function* () {
        const sourceId = request.sourceUri;
        const maybeExchange = yield* repo.findBySourceUri(sourceId);

        if (!maybeExchange) {
          const coordinates = yield* t3.planT3Work(t3Context);
          const claimed = makeRequestClaimed(request, coordinates);
          yield* repo.upsert(claimed);
        }
      });

    const run = Effect.never;

    return {
      process,
      run,
    };
  });
