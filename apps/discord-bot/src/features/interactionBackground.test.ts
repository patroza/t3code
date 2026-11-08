import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import { makeInteractionBackground } from "./interactionBackground.ts";

class Marker extends Context.Service<Marker, { readonly id: string }>()(
  "@t3tools/discord-bot/features/interactionBackground.test/Marker",
) {}

describe("interaction background", () => {
  it.effect("keeps turn resources after the interaction scope closes", () =>
    Effect.gen(function* () {
      const background = yield* makeInteractionBackground();
      const released = yield* Ref.make(false);
      const started = yield* Deferred.make<void>();
      const unblock = yield* Deferred.make<void>();

      yield* Effect.scoped(
        background.fork(
          Effect.acquireRelease(Effect.void, () => Ref.set(released, true)).pipe(
            Effect.andThen(Deferred.succeed(started, undefined)),
            Effect.andThen(Deferred.await(unblock)),
          ),
        ),
      );

      yield* Deferred.await(started);
      expect(yield* Ref.get(released)).toBe(false);
      yield* Deferred.succeed(unblock, undefined);
    }),
  );

  it.effect("runs the turn with the router services, not the interaction context", () =>
    Effect.gen(function* () {
      const background = yield* makeInteractionBackground();
      const seen = yield* Deferred.make<string>();
      yield* Effect.scoped(
        background.fork(
          Effect.gen(function* () {
            const marker = yield* Marker;
            yield* Deferred.succeed(seen, marker.id);
          }),
        ),
      );
      expect(yield* Deferred.await(seen)).toBe("router");
    }).pipe(Effect.provideService(Marker, { id: "router" })),
  );

  it.effect("releases work forked inside the interaction scope when that scope closes", () =>
    Effect.gen(function* () {
      const released = yield* Ref.make(false);
      yield* Effect.scoped(
        Effect.acquireRelease(Effect.void, () => Ref.set(released, true)).pipe(
          Effect.andThen(Effect.never),
          Effect.forkDetach({ startImmediately: true }),
        ),
      );
      expect(yield* Ref.get(released)).toBe(true);
    }),
  );
});
