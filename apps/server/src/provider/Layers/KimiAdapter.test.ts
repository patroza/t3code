import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect } from "vite-plus/test";

import { settleAcpTurnCompletion } from "./CursorAdapter.ts";
import { KIMI_TURN_COMPLETION_SETTLE_DELAY } from "./KimiAdapter.ts";

describe("Kimi ACP turn completion", () => {
  it.effect("waits for late session updates before draining and completing", () =>
    Effect.gen(function* () {
      const drained = yield* Ref.make(false);
      const fiber = yield* settleAcpTurnCompletion(
        { drainEvents: Ref.set(drained, true) },
        KIMI_TURN_COMPLETION_SETTLE_DELAY,
      ).pipe(Effect.forkChild);

      yield* Effect.yieldNow;
      yield* TestClock.adjust("1999 millis");
      expect(yield* Ref.get(drained)).toBe(false);

      yield* TestClock.adjust("1 millis");
      yield* Fiber.join(fiber);
      expect(yield* Ref.get(drained)).toBe(true);
    }),
  );
});
