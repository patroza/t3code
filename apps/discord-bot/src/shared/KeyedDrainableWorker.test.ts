import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

import { makeKeyedDrainableWorker } from "./KeyedDrainableWorker.ts";

describe("makeKeyedDrainableWorker", () => {
  it.live("keeps FIFO order per key, runs keys concurrently, and reclaims idle lanes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const blockedStarted = yield* Deferred.make<void>();
        const releaseBlocked = yield* Deferred.make<void>();
        const processed: string[] = [];
        const worker = yield* makeKeyedDrainableWorker<string, string, never, never>({
          key: (item) => item.split(":")[0] ?? item,
          process: (item) =>
            Effect.gen(function* () {
              processed.push(item);
              if (item === "blocked:first") {
                yield* Deferred.succeed(blockedStarted, undefined).pipe(Effect.orDie);
                yield* Deferred.await(releaseBlocked);
              }
            }),
        });

        expect(yield* worker.activeKeyCount).toBe(0);
        yield* worker.enqueue("blocked:first");
        yield* worker.enqueue("blocked:second");
        yield* Deferred.await(blockedStarted).pipe(Effect.timeout("1 second"));
        yield* worker.enqueue("free:first");
        yield* worker.drainKey("free");

        expect(processed).toEqual(["blocked:first", "free:first"]);
        expect(yield* worker.activeKeyCount).toBe(1);

        yield* Deferred.succeed(releaseBlocked, undefined).pipe(Effect.orDie);
        yield* worker.drain;
        expect(processed).toEqual(["blocked:first", "free:first", "blocked:second"]);
        expect(yield* worker.activeKeyCount).toBe(0);
      }),
    ),
  );

  it.live("interrupts active work and drops queued work when a key is cancelled", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const processed: string[] = [];
        const worker = yield* makeKeyedDrainableWorker<string, string, never, never>({
          key: () => "deleted-thread",
          process: (item) =>
            Effect.gen(function* () {
              processed.push(item);
              yield* Deferred.succeed(started, undefined).pipe(Effect.orDie);
              return yield* Effect.never;
            }),
        });

        yield* worker.enqueue("active");
        yield* worker.enqueue("queued");
        yield* Deferred.await(started).pipe(Effect.timeout("1 second"));
        yield* worker.cancelKey("deleted-thread");
        yield* worker.drain;

        expect(processed).toEqual(["active"]);
        expect(yield* worker.activeKeyCount).toBe(0);
      }),
    ),
  );
});
