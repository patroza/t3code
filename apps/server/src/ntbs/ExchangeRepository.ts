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
import { Array, Effect, Context, Data, HashMap, Ref, Layer } from "effect";
import { isNonTerminal, type Exchange, type NonTerminalExchange } from "./exchange.ts";
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

  /** Inserts or replaces the exchange identified by its `sourceUri`. */
  readonly upsert: (exchange: Exchange) => Effect.Effect<void, ExchangeRepositoryError>;
}

export const ExchangeRepository = Context.Service<ExchangeRepository>(
  "t3code/ntbs/ExchangeRepository",
);

const inMemoryER: Effect.Effect<ExchangeRepository> = Effect.gen(function* () {
  const exchanges: Ref.Ref<HashMap.HashMap<string, Exchange>> = yield* Ref.make(
    HashMap.empty<string, Exchange>(),
  );

  const upsert = Effect.fn("ExchangeRepository.upsert")(function* (exchange: Exchange) {
    // we return conflicting source Uri as the first argument
    // in case we find that the same threadId belongs already to a different sourceUri
    const conflictingSourceUri = yield* Ref.modify(exchanges, (map) => {
      const conflict = HashMap.findFirst(
        map,
        (existing, sourceUri) =>
          sourceUri !== exchange.sourceUri && existing.t3.threadId === exchange.t3.threadId,
      );

      return isSome(conflict)
        ? [conflict.value[0], map]
        : [null, HashMap.set(map, exchange.sourceUri, exchange)];
    });

    if (conflictingSourceUri !== null) {
      return yield* new ExchangeRepositoryError({
        reason: `Thread ${exchange.t3.threadId} already belongs to exchange ${conflictingSourceUri}`,
        cause: {
          threadId: exchange.t3.threadId,
          existingSourceUri: conflictingSourceUri,
          incomingSourceUri: exchange.sourceUri,
        },
      });
    }
  });

  const findBySourceUri = (uri: string) =>
    Ref.get(exchanges).pipe(
      Effect.map((map) => HashMap.get(map, uri)),
      Effect.map((o) => (isSome(o) ? o.value : null)),
    );

  const findByThreadId = (threadId: ThreadId) =>
    Ref.get(exchanges).pipe(
      Effect.map((map) => HashMap.filter(map, (val) => val.t3.threadId === threadId)),
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
