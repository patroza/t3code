import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

const describeValue = (value: unknown) => {
  try {
    const text = JSON.stringify(value);
    if (text === undefined) {
      return String(value);
    }
    return text.length > 2_000 ? `${text.slice(0, 2_000)}…` : text;
  } catch {
    return String(value);
  }
};

export interface PollUntilOptions<A, E, R> {
  readonly poll: Effect.Effect<A, E, R>;
  readonly until: (value: A) => boolean;
  readonly description: string;
  readonly timeout?: Duration.Input;
  readonly interval?: Duration.Input;
}

/**
 * Polls asynchronous OS work using real time even when an Effect test uses
 * TestClock. This gives child processes and libuv callbacks time to progress.
 */
export const pollUntil = <A, E, R>(options: PollUntilOptions<A, E, R>) =>
  Effect.gen(function* () {
    const timeoutMillis = Duration.toMillis(options.timeout ?? "10 seconds");
    const interval = options.interval ?? "25 millis";
    const startedAt = yield* TestClock.withLive(Clock.currentTimeMillis);

    for (;;) {
      const value = yield* options.poll;
      if (options.until(value)) {
        return value;
      }

      const now = yield* TestClock.withLive(Clock.currentTimeMillis);
      if (now - startedAt >= timeoutMillis) {
        return yield* Effect.die(
          new Error(
            `Timed out after ${timeoutMillis}ms waiting for ${options.description}. ` +
              `Last polled value: ${describeValue(value)}`,
          ),
        );
      }
      yield* TestClock.withLive(Effect.sleep(interval));
    }
  });
