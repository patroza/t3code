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

const inMemoryER: Effect.Effect<ExchangeRepository> = Effect.gen(function* () {
  const exchanges: Ref.Ref<HashMap.HashMap<string, Exchange>> = yield* Ref.make(
    HashMap.empty<string, Exchange>(),
  );

  /** Whether `exchange` may be written into `map`, with the reason when it may not. */
  const validate = (
    map: HashMap.HashMap<string, Exchange>,
    exchange: Exchange,
  ): Result.Result<void, ExchangeRepositoryError> => {
    // Rule 1: a stored exchange may only be replaced by an update of itself.
    const previous = HashMap.get(map, exchange.sourceUri);

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

    const owner = HashMap.findFirst(
      map,
      (existing, sourceUri) =>
        sourceUri !== exchange.sourceUri && getThreadId(existing) === threadId,
    );

    if (isSome(owner)) {
      return Result.fail(
        new ExchangeRepositoryError({
          reason: `Thread ${threadId} already belongs to exchange ${owner.value[0]}`,
          cause: {
            threadId,
            existingSourceUri: owner.value[0],
            incomingSourceUri: exchange.sourceUri,
          },
        }),
      );
    }

    return Result.void;
  };

  // Validating and writing share one modify, so concurrent upserts cannot both pass.
  const upsert = Effect.fn("ExchangeRepository.upsert")((exchange: Exchange) =>
    exchanges.pipe(
      Ref.modify((map) => {
        const result = validate(map, exchange);
        return [
          result,
          Result.isSuccess(result) ? HashMap.set(map, exchange.sourceUri, exchange) : map,
        ];
      }),
      Effect.flatMap(Effect.fromResult),
    ),
  );

  const findBySourceUri = (uri: string) =>
    Ref.get(exchanges).pipe(
      Effect.map((map) => HashMap.get(map, uri)),
      Effect.map((o) => (isSome(o) ? o.value : null)),
    );

  const findByThreadId = (threadId: ThreadId) =>
    Ref.get(exchanges).pipe(
      Effect.map((map) => HashMap.filter(map, (val) => getThreadId(val) === threadId)),
      // if we get more than one Exchange in the HashMap, something's wrong
      Effect.andThen((map) =>
        HashMap.size(map) > 1
          ? new ExchangeRepositoryError({
              reason: "Exchange Repository contains more than one entry for thredId: " + threadId,
              cause: map,
            })
          : Effect.succeed(Array.fromIterable(HashMap.entries(map))).pipe(
              Effect.map((arr) => (arr.length === 1 ? arr[0]![1] : null)),
            ),
      ),
    );

  const findNonTerminalExchanges = Ref.get(exchanges).pipe(
    Effect.map((map) => Array.fromIterable(HashMap.entries(map))),
    Effect.map((arr) =>
      Array.filter(
        arr.map((el) => el[1]),
        isNonTerminal,
      ),
    ),
  );

  return { upsert, findBySourceUri, findByThreadId, findNonTerminalExchanges };
});

export const inMemoryExchangeRepository = Layer.effect(ExchangeRepository, inMemoryER);
