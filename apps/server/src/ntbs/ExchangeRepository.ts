/*
 * Defines the repository for durable NTBS exchange state.
 *
 * An exchange links an admitted external-platform request to its planned T3
 * work and tracks its progress through delivery of the eventual reply.
 *
 * The repository owns persistence, lookup, and recovery. Each stored exchange
 * is identified by its `sourceUri`, while the processor decides how to handle
 * duplicate requests. It does not communicate with T3 or the originating
 * platform.
 */
import { type Effect, Context, Data } from "effect";
import { type ExchangeState, type NonTerminalExchangeState } from "./exchange.ts";
import type { ThreadId } from "@t3tools/contracts";

export class ExchangeRepositoryError extends Data.TaggedError("ExchangeRepositoryError")<{
  readonly reason: string;
  readonly cause: unknown;
}> {}

export interface ExchangeRepository {
  readonly findBySourceUri: (
    sourceUri: string,
  ) => Effect.Effect<ExchangeState | null, ExchangeRepositoryError>;

  readonly findByThreadId: (
    threadId: ThreadId,
  ) => Effect.Effect<ExchangeState | null, ExchangeRepositoryError>;

  readonly findNonTerminalExchanges: Effect.Effect<
    ReadonlyArray<NonTerminalExchangeState>,
    ExchangeRepositoryError
  >;

  /** Inserts or replaces the exchange identified by its `sourceUri`. */
  readonly upsert: (state: ExchangeState) => Effect.Effect<void, ExchangeRepositoryError>;
}

export const makeRepositoryTag = (key: string) => Context.Service<ExchangeRepository>(key);
