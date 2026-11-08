import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

/**
 * dfx runs each interaction inside `Effect.scoped`. A fiber forked from that
 * handler inherits the handler scope, so HTTP started by the turn is cancelled
 * when the ack returns. Capture the router fiber's context and run the work
 * there. The interaction still returns immediately.
 */
export const makeInteractionBackground = Effect.fn("makeInteractionBackground")(function* () {
  const context = yield* Effect.context();
  const scope = yield* Effect.scope;

  const fork = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<void> =>
    Effect.sync(() => {
      // The captured context is the router fiber's. Callers fork effects that
      // need those services; the type of `context` here is only what this
      // function itself requires.
      Effect.runForkWith(context as Context.Context<R>)(
        effect.pipe(Effect.forkIn(scope, { startImmediately: true }), Effect.asVoid),
      );
    });

  return { fork };
});
