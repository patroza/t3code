// @effect-diagnostics globalDateInEffect:off
/* oxlint-disable t3code/no-manual-effect-runtime-in-tests -- Legacy concurrency tests manually drive Effect fibers. */
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import {
  makeBridgeHub,
  type BridgeControlSlot,
  type BridgeEnsureInput,
  type BridgeRunner,
} from "./BridgeHub.ts";

const baseInput = (id: string, t3 = `t3-${id}`): BridgeEnsureInput => ({
  discordChannelId: id,
  t3ThreadId: t3,
  mode: "interactive",
});

const runnerWithControl = (
  body: (input: BridgeEnsureInput, ready: Deferred.Deferred<void>) => Effect.Effect<void>,
): BridgeRunner => {
  return (input, ready, _control: BridgeControlSlot) => body(input, ready);
};

describe("BridgeHub", () => {
  it("ensure starts a fiber and listActive tracks it until drop", async () => {
    const runner: BridgeRunner = runnerWithControl((_input, ready) =>
      Effect.gen(function* () {
        yield* Deferred.succeed(ready, undefined);
        yield* Effect.sleep("1 minute");
      }),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const hub = yield* makeBridgeHub(runner);
        yield* hub.ensure(baseInput("ch-1"));
        expect(yield* hub.activeCount()).toBe(1);
        expect(yield* hub.listActive()).toEqual([
          expect.objectContaining({
            discordChannelId: "ch-1",
            t3ThreadId: "t3-ch-1",
          }),
        ]);

        yield* hub.drop("ch-1");
        expect(yield* hub.activeCount()).toBe(0);
      }),
    );
  });

  it("rehydrate ensure is a no-op when the same t3 thread is already bridged", async () => {
    let starts = 0;
    const runner: BridgeRunner = runnerWithControl((_input, ready) =>
      Effect.gen(function* () {
        starts += 1;
        yield* Deferred.succeed(ready, undefined);
        yield* Effect.sleep("1 minute");
      }),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const hub = yield* makeBridgeHub(runner);
        yield* hub.ensure({ ...baseInput("ch-1"), mode: "rehydrate" });
        yield* hub.ensure({ ...baseInput("ch-1"), mode: "rehydrate" });
        expect(starts).toBe(1);
        expect(yield* hub.activeCount()).toBe(1);
        yield* hub.drop("ch-1");
      }),
    );
  });

  it("interactive ensure reuses an existing fiber for the same t3 thread", async () => {
    let starts = 0;
    let adopted = 0;
    const sentIds: string[] = [];
    const runner: BridgeRunner = (input, ready, control) =>
      Effect.gen(function* () {
        starts += 1;
        control.noteSentUserMessageIds = (ids) =>
          Effect.sync(() => {
            sentIds.push(...ids);
          });
        control.adoptWorkingAckMessageId = () =>
          Effect.sync(() => {
            adopted += 1;
          });
        yield* Deferred.succeed(ready, undefined);
        yield* Effect.sleep("1 minute");
      });

    await Effect.runPromise(
      Effect.gen(function* () {
        const hub = yield* makeBridgeHub(runner);
        yield* hub.ensure(baseInput("ch-1"));
        yield* hub.ensure({
          ...baseInput("ch-1"),
          sentDiscordUserMessageIds: ["user-2"],
          workingAckMessageId: "ack-2",
        });
        expect(starts).toBe(1);
        expect(adopted).toBe(1);
        expect(sentIds).toEqual(["user-2"]);
        expect(yield* hub.activeCount()).toBe(1);
        yield* hub.drop("ch-1");
      }),
    );
  });

  it("replace fiber when t3ThreadId changes", async () => {
    const seen: string[] = [];
    const runner: BridgeRunner = runnerWithControl((input, ready) =>
      Effect.gen(function* () {
        seen.push(input.t3ThreadId);
        yield* Deferred.succeed(ready, undefined);
        yield* Effect.sleep("1 minute");
      }),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const hub = yield* makeBridgeHub(runner);
        yield* hub.ensure(baseInput("ch-1", "t3-a"));
        yield* hub.ensure(baseInput("ch-1", "t3-b"));
        expect(seen).toEqual(["t3-a", "t3-b"]);
        expect(yield* hub.activeCount()).toBe(1);
        expect((yield* hub.listActive())[0]?.t3ThreadId).toBe("t3-b");
        yield* hub.drop("ch-1");
      }),
    );
  });

  it("dropAll clears every live bridge", async () => {
    const runner: BridgeRunner = runnerWithControl((_input, ready) =>
      Effect.gen(function* () {
        yield* Deferred.succeed(ready, undefined);
        yield* Effect.sleep("1 minute");
      }),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const hub = yield* makeBridgeHub(runner);
        yield* hub.ensure(baseInput("a"));
        yield* hub.ensure(baseInput("b"));
        expect(yield* hub.activeCount()).toBe(2);
        yield* hub.dropAll();
        expect(yield* hub.activeCount()).toBe(0);
      }),
    );
  });

  it("getLive returns control surface for a matching channel", async () => {
    const runner: BridgeRunner = (input, ready, control) =>
      Effect.gen(function* () {
        control.noteSentUserMessageIds = () => Effect.void;
        yield* Deferred.succeed(ready, undefined);
        yield* Effect.sleep("1 minute");
      });

    await Effect.runPromise(
      Effect.gen(function* () {
        const hub = yield* makeBridgeHub(runner);
        yield* hub.ensure(baseInput("ch-1", "t3-1"));
        const live = yield* hub.getLive("ch-1", "t3-1");
        expect(live?.t3ThreadId).toBe("t3-1");
        expect(yield* hub.getLive("ch-1", "other")).toBeNull();
        yield* hub.drop("ch-1");
      }),
    );
  });
});
