import * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

export interface DiscordThreadTurnCoordinator {
  readonly withLock: <A, E, R>(
    discordThreadId: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  readonly tryWithLock: <A, E, R>(
    discordThreadId: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<Option.Option<A>, E, R>;
}

/**
 * Serializes mention handling per Discord thread. In particular, a follow-up
 * mention must not race the first mention between link lookup and persistence.
 */
export const makeDiscordThreadTurnCoordinator = Effect.gen(function* () {
  const locksRef = yield* Ref.make<ReadonlyMap<string, Semaphore.Semaphore>>(new Map());

  const getLock = (discordThreadId: string) =>
    Effect.gen(function* () {
      const existing = (yield* Ref.get(locksRef)).get(discordThreadId);
      if (existing !== undefined) return existing;

      const created = yield* Semaphore.make(1);
      return yield* Ref.modify(locksRef, (locks) => {
        const current = locks.get(discordThreadId);
        if (current !== undefined) return [current, locks] as const;
        const next = new Map(locks);
        next.set(discordThreadId, created);
        return [created, next] as const;
      });
    });

  return {
    withLock: (discordThreadId, effect) =>
      Effect.flatMap(getLock(discordThreadId), (lock) => lock.withPermit(effect)),
    tryWithLock: (discordThreadId, effect) =>
      Effect.flatMap(getLock(discordThreadId), (lock) => lock.withPermitsIfAvailable(1)(effect)),
  } satisfies DiscordThreadTurnCoordinator;
});
