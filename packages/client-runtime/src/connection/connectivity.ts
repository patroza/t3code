import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import type { NetworkStatus } from "./model.ts";
import * as ConnectionWakeups from "./wakeups.ts";

export class Connectivity extends Context.Service<
  Connectivity,
  {
    readonly status: Effect.Effect<NetworkStatus>;
    readonly changes: Stream.Stream<NetworkStatus>;
  }
>()("@t3tools/client-runtime/connection/connectivity") {}

const make = (service: Connectivity["Service"]) => Connectivity.of(service);

export const layer = (service: Connectivity["Service"]) =>
  Layer.succeed(Connectivity, make(service));

/** Apply listener changes plus a fresh status on resume, because suspended apps can miss transitions.
 * Every listener report (including repeats) invalidates an older async resume read so stale state cannot overwrite it.
 */
export const followNetworkStatus = Effect.fnUntraced(function* (options: {
  readonly connectivity: Connectivity["Service"];
  readonly wakeups: ConnectionWakeups.ConnectionWakeups["Service"];
  readonly apply: (status: NetworkStatus) => Effect.Effect<void>;
}) {
  // Count repeats too: they prove the listener is newer than an in-flight resume read.
  // Otherwise a stale snapshot can overwrite the status the platform just reported.
  const reportCount = yield* Ref.make(0);
  // Tracks what was last handed to `options.apply` purely to keep repeats from
  // reaching consumers. Deduplication is deliberately kept separate from the
  // staleness guard above.
  const appliedStatus = yield* Ref.make<Option.Option<NetworkStatus>>(Option.none());
  // Counting a report and applying it has to be indivisible with respect to the
  // resume branch's guard. Otherwise a change landing between that guard and its
  // apply would be overwritten by the older read.
  const applyLock = yield* Semaphore.make(1);

  const applyStatus = Effect.fnUntraced(function* (status: NetworkStatus) {
    const changed = yield* Ref.modify(appliedStatus, (current) =>
      Option.isSome(current) && current.value === status
        ? ([false, current] as const)
        : ([true, Option.some(status)] as const),
    );
    if (changed) {
      yield* options.apply(status);
    }
  });

  yield* options.connectivity.changes.pipe(
    Stream.runForEach((status) =>
      applyLock.withPermits(1)(
        Ref.update(reportCount, (count) => count + 1).pipe(Effect.andThen(applyStatus(status))),
      ),
    ),
    // Subscribe before returning so a transition reported while this is still
    // being set up is not dropped.
    Effect.forkScoped({ startImmediately: true }),
  );

  yield* options.wakeups.changes.pipe(
    Stream.runForEach((reason) =>
      reason === "application-active"
        ? Effect.gen(function* () {
            // `runForEach` is sequential, so resume reads cannot overlap: a
            // second resume does not start a read until this one has applied.
            const startedAt = yield* Ref.get(reportCount);
            const status = yield* options.connectivity.status;
            yield* applyLock.withPermits(1)(
              Effect.gen(function* () {
                // Re-read under the permit: any report that arrived while the
                // read was in flight is newer, so this result is stale.
                if ((yield* Ref.get(reportCount)) === startedAt) {
                  yield* applyStatus(status);
                }
              }),
            );
          })
        : Effect.void,
    ),
    Effect.forkScoped({ startImmediately: true }),
  );
});
