import { describe, expect, it } from "@effect/vitest";
import { EnvironmentInternalError } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";

import * as AuthHttp from "./http.ts";

const encodeEnvironmentInternalError = Schema.encodeUnknownSync(EnvironmentInternalError);

const loggerLayer = (messages: Array<unknown>) =>
  Logger.layer(
    [
      Logger.make(({ message }) => {
        messages.push(message);
      }),
    ],
    { mergeWithExisting: false },
  );

describe("auth http diagnostics", () => {
  it.effect(
    "retains the exact internal cause while logging and encoding bounded diagnostics",
    () => {
      const messages: Array<unknown> = [];
      const cause = new Error("credential=secret-value");

      return Effect.gen(function* () {
        const error = yield* Effect.flip(
          AuthHttp.failEnvironmentInternal("browser_session_cookie_failed", cause),
        );

        expect(error).toBeInstanceOf(AuthHttp.EnvironmentHttpInternalError);
        expect(error.cause).toBe(cause);
        expect(error.failureTag).toBe("Error");
        expect(error.message).toBe(
          "Environment API operation failed (browser_session_cookie_failed).",
        );
        expect(encodeEnvironmentInternalError(error)).toEqual({
          _tag: "EnvironmentInternalError",
          code: "internal_error",
          reason: "browser_session_cookie_failed",
          traceId: error.traceId,
        });

        expect(messages).toEqual([
          [
            "environment api operation failed",
            {
              reason: "browser_session_cookie_failed",
              traceId: error.traceId,
              failureTag: "Error",
              reasonCount: 1,
              failureCount: 1,
              defectCount: 0,
              interruptionCount: 0,
            },
          ],
        ]);
      }).pipe(Effect.provide(loggerLayer(messages)));
    },
  );

  it.effect("logs request failures without serializing their Error or Cause values", () => {
    const messages: Array<unknown> = [];
    const request = HttpServerRequest.fromWeb(
      new Request("https://environment.example.test/api/auth/session"),
    );
    const requestCause = Cause.combine(
      Cause.fail(new Error("credential=secret-value")),
      Cause.die(new Error("stderr=private-value")),
    );

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        Effect.scoped(
          Effect.gen(function* () {
            yield* AuthHttp.annotateEnvironmentRequest("auth.session");
            return yield* Effect.failCause(requestCause);
          }),
        ).pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request)),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      expect(messages).toEqual([
        [
          "environment api request failed",
          {
            endpoint: "auth.session",
            traceId: "unavailable",
            failureTag: "Error",
            reasonCount: 2,
            failureCount: 1,
            defectCount: 1,
            interruptionCount: 0,
          },
        ],
      ]);
    }).pipe(Effect.provide(loggerLayer(messages)));
  });

  it.effect("re-propagates nested interruption causes without logging a synthetic 500", () => {
    const messages: Array<unknown> = [];
    const interruption = Cause.interrupt();
    const cause = new Error("cancelled", { cause: interruption });

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(AuthHttp.failEnvironmentInternal("internal_error", cause));

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
        expect(Option.isNone(Cause.findErrorOption(exit.cause))).toBe(true);
      }
      expect(messages).toEqual([]);
    }).pipe(Effect.provide(loggerLayer(messages)));
  });
});
