/**
 * Lazy FIFO work lanes keyed by an identifier.
 *
 * A lane exists only while its key has active or queued work. Same-key work is
 * serial, different keys run concurrently, and idle lanes are reclaimed.
 */
import * as Scope from "effect/Scope";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Semaphore from "effect/Semaphore";
import * as TxRef from "effect/TxRef";

export interface KeyedDrainableWorker<K, A> {
  readonly enqueue: (item: A) => Effect.Effect<void>;
  readonly cancelKey: (key: K) => Effect.Effect<void>;
  readonly drain: Effect.Effect<void>;
  readonly drainKey: (key: K) => Effect.Effect<void>;
  readonly activeKeyCount: Effect.Effect<number>;
}

interface Lane<A, E> {
  readonly queue: Array<A>;
  fiber: Fiber.Fiber<void, E> | undefined;
}

interface Outstanding<K> {
  readonly total: number;
  readonly byKey: Map<K, number>;
}

export const makeKeyedDrainableWorker = <K, A, E, R>(options: {
  readonly key: (item: A) => K;
  readonly process: (item: A) => Effect.Effect<void, E, R>;
}): Effect.Effect<KeyedDrainableWorker<K, A>, never, Scope.Scope | R> =>
  Effect.gen(function* () {
    const context = yield* Effect.context<R>();
    const registryLock = yield* Semaphore.make(1);
    const lanes = new Map<K, Lane<A, E>>();
    const outstandingRef = yield* TxRef.make<Outstanding<K>>({
      total: 0,
      byKey: new Map(),
    });

    const adjustOutstanding = (key: K, delta: number) =>
      TxRef.update(outstandingRef, (state) => {
        const byKey = new Map(state.byKey);
        const next = (byKey.get(key) ?? 0) + delta;
        if (next <= 0) byKey.delete(key);
        else byKey.set(key, next);
        return { total: state.total + delta, byKey };
      }).pipe(Effect.tx);

    const processLane = (key: K, lane: Lane<A, E>): Effect.Effect<void, E> =>
      Effect.suspend(() =>
        registryLock
          .withPermit(
            Effect.sync(() => {
              const item = lane.queue.shift();
              if (item === undefined && lanes.get(key) === lane) {
                lanes.delete(key);
              }
              return item;
            }),
          )
          .pipe(
            Effect.flatMap((item) =>
              item === undefined
                ? Effect.void
                : options
                    .process(item)
                    .pipe(
                      Effect.provide(context),
                      Effect.ensuring(adjustOutstanding(key, -1)),
                      Effect.andThen(processLane(key, lane)),
                    ),
            ),
          ),
      );

    const enqueue: KeyedDrainableWorker<K, A>["enqueue"] = (item) => {
      const key = options.key(item);
      return registryLock.withPermit(
        Effect.gen(function* () {
          let lane = lanes.get(key);
          if (lane === undefined) {
            lane = { queue: [], fiber: undefined };
            lanes.set(key, lane);
          }
          lane.queue.push(item);
          yield* adjustOutstanding(key, 1);
          if (lane.fiber === undefined) {
            lane.fiber = yield* processLane(key, lane).pipe(Effect.forkDetach);
          }
        }),
      );
    };

    const cancelKey: KeyedDrainableWorker<K, A>["cancelKey"] = (key) =>
      Effect.gen(function* () {
        let fiber: Fiber.Fiber<void, E> | undefined;
        let droppedQueuedItems = 0;
        yield* registryLock.withPermit(
          Effect.sync(() => {
            const lane = lanes.get(key);
            if (lane === undefined) return;
            lanes.delete(key);
            droppedQueuedItems = lane.queue.length;
            lane.queue.length = 0;
            fiber = lane.fiber;
          }),
        );
        if (droppedQueuedItems > 0) {
          yield* adjustOutstanding(key, -droppedQueuedItems);
        }
        if (fiber !== undefined) {
          yield* Fiber.interrupt(fiber);
        }
      });

    yield* Effect.addFinalizer(() =>
      registryLock
        .withPermit(
          Effect.sync(() => {
            const fibers = Array.from(lanes.values()).flatMap((lane) =>
              lane.fiber === undefined ? [] : [lane.fiber],
            );
            lanes.clear();
            return fibers;
          }),
        )
        .pipe(
          Effect.flatMap((fibers) => Fiber.interruptAll(fibers)),
          Effect.asVoid,
        ),
    );

    const drain = TxRef.get(outstandingRef).pipe(
      Effect.tap((state) => (state.total > 0 ? Effect.txRetry : Effect.void)),
      Effect.asVoid,
      Effect.tx,
    );

    const drainKey: KeyedDrainableWorker<K, A>["drainKey"] = (key) =>
      TxRef.get(outstandingRef).pipe(
        Effect.tap((state) => (state.byKey.has(key) ? Effect.txRetry : Effect.void)),
        Effect.asVoid,
        Effect.tx,
      );

    const activeKeyCount = registryLock.withPermit(Effect.sync(() => lanes.size));

    return {
      enqueue,
      cancelKey,
      drain,
      drainKey,
      activeKeyCount,
    } satisfies KeyedDrainableWorker<K, A>;
  });
