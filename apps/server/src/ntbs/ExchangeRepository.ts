/*
 * Defines the repository for durable NTBS exchanges.
 *
 * An exchange links an admitted external-platform request to its planned T3
 * work and tracks its progress through delivery of the eventual reply.
 *
 * The repository owns persistence, lookup, and recovery. Each stored exchange
 * is identified by its `sourceUri`, while the processor decides how to handle
 * duplicate requests. It does not communicate with T3 or the originating
 * platform.
 */
import { Array, Effect, Context, Data, HashMap, Ref, Layer, Result } from "effect";
import {
  getThreadId,
  isNonTerminal,
  isUpdateOf,
  type Exchange,
  type NonTerminalExchange,
} from "./exchange.ts";
import type { ThreadId } from "@t3tools/contracts";
import { isSome } from "effect/Option";

export class ExchangeRepositoryError extends Data.TaggedError("ExchangeRepositoryError")<{
  readonly reason: string;
  readonly cause: unknown;
}> {}

export interface ExchangeRepository {
  readonly findBySourceUri: (
    sourceUri: string,
  ) => Effect.Effect<Exchange | null, ExchangeRepositoryError>;

  readonly findByThreadId: (
    threadId: ThreadId,
  ) => Effect.Effect<Exchange | null, ExchangeRepositoryError>;

  readonly findNonTerminalExchanges: Effect.Effect<
    ReadonlyArray<NonTerminalExchange>,
    ExchangeRepositoryError
  >;

  /**
   * Inserts or replaces the exchange identified by its `sourceUri`, as long as it is a legal update of the stored one and the thread it refers to does not already belong to another exchange.
   *
   * The checks and the write are atomic, so of two conflicting concurrent upserts at most one succeeds.
   */
  readonly upsert: (exchange: Exchange) => Effect.Effect<void, ExchangeRepositoryError>;
}

export const ExchangeRepository = Context.Service<ExchangeRepository>(
  "t3code/ntbs/ExchangeRepository",
);

/** The in-memory store: every exchange by its `sourceUri`, plus the thread index. */
type StoredExchanges = {
  readonly bySourceUri: HashMap.HashMap<string, Exchange>;
  readonly byThreadId: HashMap.HashMap<ThreadId, Exchange>;
};

const inMemoryER: Effect.Effect<ExchangeRepository> = Effect.gen(function* () {
  const state = yield* Ref.make<StoredExchanges>({
    bySourceUri: HashMap.empty<string, Exchange>(),
    // An index over the same exchanges: rule 2 of `validate` keeps at most one per thread.
    byThreadId: HashMap.empty<ThreadId, Exchange>(),
  });

  /** Whether `exchange` may be written into `state`, with the reason when it may not. */
  const validate = (
    state: StoredExchanges,
    exchange: Exchange,
  ): Result.Result<void, ExchangeRepositoryError> => {
    // Rule 1: a stored exchange may only be replaced by an update of itself.
    const previous = HashMap.get(state.bySourceUri, exchange.sourceUri);

    if (isSome(previous) && !isUpdateOf(exchange, previous.value)) {
      return Result.fail(
        new ExchangeRepositoryError({
          reason: `Exchange ${exchange.sourceUri} cannot move from ${previous.value.tag} to ${exchange.tag}`,
          cause: { sourceUri: exchange.sourceUri, from: previous.value.tag, to: exchange.tag },
        }),
      );
    }

    // Rule 2: the thread an exchange refers to may not belong to another exchange.
    const threadId = getThreadId(exchange);

    if (threadId === null) {
      return Result.void;
    }

    const owner = HashMap.get(state.byThreadId, threadId);

    if (isSome(owner) && owner.value.sourceUri !== exchange.sourceUri) {
      return Result.fail(
        new ExchangeRepositoryError({
          reason: `Thread ${threadId} already belongs to exchange ${owner.value.sourceUri}`,
          cause: {
            threadId,
            existingSourceUri: owner.value.sourceUri,
            incomingSourceUri: exchange.sourceUri,
          },
        }),
      );
    }

    return Result.void;
  };

  // Validating and writing share one modify, so concurrent upserts cannot both pass.
  const upsert = Effect.fn("ExchangeRepository.upsert")((exchange: Exchange) =>
    state.pipe(
      Ref.modify(
        (current): readonly [Result.Result<void, ExchangeRepositoryError>, StoredExchanges] => {
          const result = validate(current, exchange);

          if (Result.isFailure(result)) {
            return [result, current];
          }

          const previous = HashMap.get(current.bySourceUri, exchange.sourceUri);
          const previousThreadId = isSome(previous) ? getThreadId(previous.value) : null;
          const threadId = getThreadId(exchange);

          let byThreadId = current.byThreadId;

          if (previousThreadId !== null && previousThreadId !== threadId) {
            byThreadId = HashMap.remove(byThreadId, previousThreadId);
          }

          if (threadId !== null) {
            byThreadId = HashMap.set(byThreadId, threadId, exchange);
          }

          return [
            result,
            {
              bySourceUri: HashMap.set(current.bySourceUri, exchange.sourceUri, exchange),
              byThreadId,
            },
          ];
        },
      ),
      Effect.flatMap(Effect.fromResult),
    ),
  );

  const findBySourceUri = (uri: string) =>
    Ref.get(state).pipe(
      Effect.map(({ bySourceUri }) => HashMap.get(bySourceUri, uri)),
      Effect.map((o) => (isSome(o) ? o.value : null)),
    );

  const findByThreadId = (threadId: ThreadId) =>
    Ref.get(state).pipe(
      Effect.map(({ byThreadId }) => HashMap.get(byThreadId, threadId)),
      Effect.map((o) => (isSome(o) ? o.value : null)),
    );

  const findNonTerminalExchanges = Ref.get(state).pipe(
    Effect.map(({ bySourceUri }) => Array.fromIterable(HashMap.values(bySourceUri))),
    Effect.map(Array.filter(isNonTerminal)),
  );

  return { upsert, findBySourceUri, findByThreadId, findNonTerminalExchanges };
});

export const inMemoryExchangeRepository = Layer.effect(ExchangeRepository, inMemoryER);
