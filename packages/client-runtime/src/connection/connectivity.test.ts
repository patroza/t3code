import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as Connectivity from "./connectivity.ts";
import type { NetworkStatus } from "./model.ts";
import * as ConnectionWakeups from "./wakeups.ts";

// Acknowledgements follow stream demand, so tests wait for actual consumption,
// including reports that the connectivity service intentionally deduplicates.
const makeEventStream = Effect.fnUntraced(function* <A>() {
  const events = yield* Queue.unbounded<{
    readonly value: A;
    readonly delivered: Deferred.Deferred<void>;
    readonly processed: Deferred.Deferred<void>;
  }>();
  const changes = Stream.fromQueue(events).pipe(
    Stream.flatMap((event) =>
      Stream.concat(
        Stream.fromEffect(Deferred.succeed(event.delivered, undefined)).pipe(Stream.drain),
        Stream.concat(
          Stream.succeed(event.value),
          Stream.fromEffect(Deferred.succeed(event.processed, undefined)).pipe(Stream.drain),
        ),
      ),
    ),
  );
  const enqueue = Effect.fnUntraced(function* (value: A) {
    const delivered = yield* Deferred.make<void>();
    const processed = yield* Deferred.make<void>();
    yield* Queue.offer(events, { value, delivered, processed });
    return { delivered: Deferred.await(delivered), processed: Deferred.await(processed) };
  });
  return { changes, enqueue };
});

const makeHarness = Effect.fn("TestConnectivityHarness.make")(function* (options?: {
  readonly status?: Effect.Effect<NetworkStatus>;
  readonly initialStatus?: NetworkStatus;
}) {
  const liveStatus = yield* Ref.make<NetworkStatus>(options?.initialStatus ?? "online");
  const reported = yield* makeEventStream<NetworkStatus>();
  const wakeups = yield* makeEventStream<"application-active">();
  const applied = yield* Ref.make<ReadonlyArray<NetworkStatus>>([]);

  const connectivity = Connectivity.Connectivity.of({
    status: options?.status ?? Ref.get(liveStatus),
    changes: reported.changes,
  });
  const wakeupService = ConnectionWakeups.ConnectionWakeups.of({ changes: wakeups.changes });
  const enqueueReport = Effect.fnUntraced(function* (status: NetworkStatus) {
    yield* Ref.set(liveStatus, status);
    return yield* reported.enqueue(status);
  });
  const enqueueResume = wakeups.enqueue("application-active");

  return {
    connectivity,
    wakeups: wakeupService,
    applied,
    setLiveStatus: (status: NetworkStatus) => Ref.set(liveStatus, status),
    enqueueReport,
    enqueueResume,
    // The stream acknowledges only after the consumer has handled the event.
    report: (status: NetworkStatus) =>
      enqueueReport(status).pipe(Effect.flatMap((event) => event.processed)),
    resume: enqueueResume.pipe(Effect.flatMap((event) => event.processed)),
    apply: (status: NetworkStatus) => Ref.update(applied, (statuses) => [...statuses, status]),
  };
});

describe("followNetworkStatus", () => {
  it.effect("applies statuses reported by the platform listener", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* Connectivity.followNetworkStatus({
          connectivity: harness.connectivity,
          wakeups: harness.wakeups,
          apply: harness.apply,
        });

        yield* harness.report("offline");
        expect(yield* Ref.get(harness.applied)).toEqual(["offline"]);
      }),
    ),
  );

  it.effect("applies a resumed read when the listener missed a transition", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness({ initialStatus: "offline" });
        yield* Connectivity.followNetworkStatus({
          connectivity: harness.connectivity,
          wakeups: harness.wakeups,
          apply: harness.apply,
        });

        // The device came back online while suspended and the listener never
        // reported the transition.
        yield* harness.setLiveStatus("online");
        yield* harness.resume;
        expect(yield* Ref.get(harness.applied)).toEqual(["online"]);
      }),
    ),
  );

  it.effect("discards a resumed read that a repeated report raced", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const readStarted = yield* Deferred.make<void>();
        const releaseRead = yield* Deferred.make<void>();
        const harness = yield* makeHarness({
          initialStatus: "online",
          // The resume samples a brief opposite state.
          status: Deferred.succeed(readStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseRead)),
            Effect.as("offline" as const),
          ),
        });
        yield* Connectivity.followNetworkStatus({
          connectivity: harness.connectivity,
          wakeups: harness.wakeups,
          apply: harness.apply,
        });

        // Apply "online" first so the listener's later repeat of it is genuinely
        // redundant rather than a new status.
        yield* harness.report("online");
        const resumed = yield* harness.enqueueResume;
        yield* Deferred.await(readStarted);

        // The repeat carries no new status, but it proves the listener spoke
        // after this read began, so the read is stale even though the status it
        // returns differs. Applying it would strand consumers on "offline" while
        // the platform reports "online" — the very failure this helper exists to
        // prevent.
        yield* harness.report("online");
        yield* Deferred.succeed(releaseRead, undefined);
        yield* resumed.processed;

        expect(yield* Ref.get(harness.applied)).toEqual(["online"]);
      }),
    ),
  );

  it.effect("still deduplicates a repeated report before it reaches consumers", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness({ initialStatus: "online" });
        yield* Connectivity.followNetworkStatus({
          connectivity: harness.connectivity,
          wakeups: harness.wakeups,
          apply: harness.apply,
        });

        yield* harness.report("offline");
        // Counting the repeat for staleness must not turn it into a redundant
        // consumer update.
        yield* harness.report("offline");
        expect(yield* Ref.get(harness.applied)).toEqual(["offline"]);

        // A genuine transition after the repeat still lands.
        yield* harness.report("online");
        expect(yield* Ref.get(harness.applied)).toEqual(["offline", "online"]);
      }),
    ),
  );

  it.effect("does not start a second status read while one is in flight", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const firstRead = yield* Deferred.make<NetworkStatus>();
        const readStarted = yield* Deferred.make<void>();
        const readCount = yield* Ref.make(0);
        const activeReads = yield* Ref.make(0);
        const maximumActiveReads = yield* Ref.make(0);
        const harness = yield* makeHarness({
          initialStatus: "unknown",
          status: Effect.gen(function* () {
            yield* Ref.update(readCount, (count) => count + 1);
            const active = yield* Ref.updateAndGet(activeReads, (count) => count + 1);
            yield* Ref.update(maximumActiveReads, (maximum) => Math.max(maximum, active));
            yield* Deferred.succeed(readStarted, undefined);
            const status = yield* Deferred.await(firstRead);
            yield* Ref.update(activeReads, (count) => count - 1);
            return status;
          }),
        });
        yield* Connectivity.followNetworkStatus({
          connectivity: harness.connectivity,
          wakeups: harness.wakeups,
          apply: harness.apply,
        });

        const firstResume = yield* harness.enqueueResume;
        yield* Deferred.await(readStarted);
        const secondResume = yield* harness.enqueueResume;
        const thirdResume = yield* harness.enqueueResume;
        expect(yield* Ref.get(readCount)).toBe(1);

        yield* Deferred.succeed(firstRead, "online");
        yield* firstResume.processed;
        yield* secondResume.processed;
        yield* thirdResume.processed;
        expect(yield* Ref.get(readCount)).toBe(3);
        expect(yield* Ref.get(maximumActiveReads)).toBe(1);
        expect(yield* Ref.get(harness.applied)).toEqual(["online"]);
      }),
    ),
  );

  it.effect("discards a resumed read that a newer reported change superseded", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const readStarted = yield* Deferred.make<void>();
        const releaseRead = yield* Deferred.make<void>();
        const harness = yield* makeHarness({
          initialStatus: "offline",
          status: Deferred.succeed(readStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseRead)),
            Effect.as("online" as const),
          ),
        });
        yield* Connectivity.followNetworkStatus({
          connectivity: harness.connectivity,
          wakeups: harness.wakeups,
          apply: harness.apply,
        });

        // Resume, and hold the status read open so the listener can report a
        // newer transition while that read is still in flight.
        const resumed = yield* harness.enqueueResume;
        yield* Deferred.await(readStarted);
        yield* harness.report("offline");
        yield* Deferred.succeed(releaseRead, undefined);
        yield* resumed.processed;

        // The stale "online" snapshot must not land on top of the newer event.
        expect(yield* Ref.get(harness.applied)).toEqual(["offline"]);
      }),
    ),
  );

  it.effect("keeps a reported change from interleaving with a resumed apply", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const applyStarted = yield* Deferred.make<void>();
        const releaseApply = yield* Deferred.make<void>();
        const harness = yield* makeHarness({ initialStatus: "offline" });
        // Holds the resumed apply open once it begins, so a reported change has
        // a window to interleave between the guard and its apply.
        const gatedApply = (status: NetworkStatus) =>
          status === "online"
            ? Deferred.succeed(applyStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseApply)),
                Effect.andThen(harness.apply(status)),
              )
            : harness.apply(status);

        yield* Connectivity.followNetworkStatus({
          connectivity: harness.connectivity,
          wakeups: harness.wakeups,
          apply: gatedApply,
        });

        yield* harness.setLiveStatus("online");
        const resumed = yield* harness.enqueueResume;
        yield* Deferred.await(applyStarted);

        // The listener reports a newer transition mid-apply.
        const reported = yield* harness.enqueueReport("offline");
        yield* reported.delivered;
        yield* Deferred.succeed(releaseApply, undefined);
        yield* resumed.processed;
        yield* reported.processed;

        // The reported change has to land last; applying it before the resumed
        // status finished would leave the stale "online" as the final word.
        expect(yield* Ref.get(harness.applied)).toEqual(["online", "offline"]);
      }),
    ),
  );
});
