import { describe, expect, it } from "@effect/vitest";
import { PrimaryConnectionTarget } from "../connection/model.ts";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import type { PreparedConnection } from "../connection/model.ts";
import { RemoteEnvironmentAuthTimeoutError, remoteHttpClientLayer } from "../rpc/http.ts";
import { fetchEnvironmentThreadSnapshot } from "./threadSnapshotHttp.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});
const PREPARED: PreparedConnection = {
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  httpBaseUrl: TARGET.httpBaseUrl,
  socketUrl: TARGET.wsBaseUrl,
  httpAuthorization: null,
  target: TARGET,
};
const THREAD_ID = ThreadId.make("thread-1");

/** A fetch that never settles, standing in for a link too slow to finish. */
const hangingFetch = () => (() => new Promise<Response>(() => undefined)) satisfies typeof fetch;

const loadSnapshot = () =>
  fetchEnvironmentThreadSnapshot({
    prepared: PREPARED,
    threadId: THREAD_ID,
    signer: Option.none(),
  });

describe("thread snapshot HTTP loads", () => {
  it.effect("keeps a slow link on HTTP rather than deferring the snapshot to the socket", () =>
    Effect.gen(function* () {
      const errorFiber = yield* loadSnapshot().pipe(
        Effect.provide(remoteHttpClientLayer(hangingFetch())),
        Effect.flip,
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;

      // The previous six-second bound gave up here and let the subscription
      // embed the snapshot in the socket instead — the same bytes, queued ahead
      // of the heartbeat on the link least able to carry them (#2761). A load
      // this slow has to stay on HTTP.
      yield* TestClock.adjust(Duration.millis(6_000));
      expect(errorFiber.pollUnsafe()).toBeUndefined();

      yield* TestClock.adjust(Duration.millis(24_000));
      const error = yield* Fiber.join(errorFiber);

      expect(error).toBeInstanceOf(RemoteEnvironmentAuthTimeoutError);
      if (error._tag === "RemoteEnvironmentAuthTimeoutError") {
        expect(error.timeoutMs).toBe(30_000);
      }
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
