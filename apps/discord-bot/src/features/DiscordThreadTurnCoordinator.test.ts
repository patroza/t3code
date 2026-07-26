import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import { makeDiscordThreadTurnCoordinator } from "./DiscordThreadTurnCoordinator.ts";

describe("DiscordThreadTurnCoordinator", () => {
  it.live("prevents overlapping first-link creation for the same Discord thread", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const coordinator = yield* makeDiscordThreadTurnCoordinator;
        const linked = yield* Ref.make(false);
        const createdCount = yield* Ref.make(0);
        const firstStarted = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        const secondFinished = yield* Deferred.make<void>();

        const handleMention = (isFirst: boolean) =>
          coordinator.withLock(
            "discord-thread-1",
            Effect.gen(function* () {
              if (yield* Ref.get(linked)) return;
              yield* Ref.update(createdCount, (count) => count + 1);
              if (isFirst) {
                yield* Deferred.succeed(firstStarted, undefined);
                yield* Deferred.await(releaseFirst);
              }
              yield* Ref.set(linked, true);
            }),
          );

        yield* Effect.forkChild(handleMention(true));
        yield* Deferred.await(firstStarted);
        yield* Effect.forkChild(
          handleMention(false).pipe(
            Effect.ensuring(Deferred.succeed(secondFinished, undefined).pipe(Effect.orDie)),
          ),
        );
        yield* Effect.yieldNow;

        expect(yield* Ref.get(createdCount)).toBe(1);

        yield* Deferred.succeed(releaseFirst, undefined);
        yield* Deferred.await(secondFinished);

        expect(yield* Ref.get(createdCount)).toBe(1);
      }),
    ),
  );

  it.live("does not serialize unrelated Discord threads", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const coordinator = yield* makeDiscordThreadTurnCoordinator;
        const firstStarted = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        const secondRan = yield* Ref.make(false);

        yield* Effect.forkChild(
          coordinator.withLock(
            "discord-thread-1",
            Deferred.succeed(firstStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseFirst)),
            ),
          ),
        );
        yield* Deferred.await(firstStarted);

        yield* coordinator.withLock("discord-thread-2", Ref.set(secondRan, true));
        expect(yield* Ref.get(secondRan)).toBe(true);

        yield* Deferred.succeed(releaseFirst, undefined);
      }),
    ),
  );

  it.live("can reject work immediately when a thread lock is occupied", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const coordinator = yield* makeDiscordThreadTurnCoordinator;
        const firstStarted = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();

        yield* Effect.forkChild(
          coordinator.withLock(
            "discord-thread-1",
            Deferred.succeed(firstStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseFirst)),
            ),
          ),
        );
        yield* Deferred.await(firstStarted);

        const result = yield* coordinator.tryWithLock(
          "discord-thread-1",
          Effect.succeed("unexpected"),
        );
        expect(Option.isNone(result)).toBe(true);

        yield* Deferred.succeed(releaseFirst, undefined);
      }),
    ),
  );
});
