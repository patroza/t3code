import { PREVIEW_AUTOMATION_HOST_WS_METHODS, type ThreadId } from "@t3tools/contracts";
import type { RpcSession } from "@t3tools/client-runtime/rpc";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import {
  type BrowserAutomationHost,
  browserResponseAfterDeliveryFailure,
} from "./BrowserAutomationHost.ts";

const causeMessage = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/**
 * Serves the server's browser requests from `host`. The server ends the stream when it evicts
 * an unresponsive host, so a clean end re-registers; a failure stops the host.
 */
export const serveBrowserHost = (
  client: RpcSession["client"],
  host: BrowserAutomationHost,
  onStopped: () => void,
) =>
  Stream.suspend(() =>
    client[PREVIEW_AUTOMATION_HOST_WS_METHODS.previewAutomationConnect](host.registration()),
  ).pipe(
    Stream.runForEach((event) =>
      Effect.gen(function* () {
        const startedAt = yield* Clock.currentTimeMillis;
        const response = yield* Effect.promise(() => host.consume(event));
        if (event.type === "connected") {
          const focusHost = client[PREVIEW_AUTOMATION_HOST_WS_METHODS.previewAutomationFocusHost];
          yield* Effect.forEach(host.reclaims(), (claim) => focusHost(claim), {
            discard: true,
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Could not re-claim bot browser threads", { cause }),
            ),
          );
        }
        if (event.type === "request") {
          yield* Effect.logInfo("Bot browser operation completed", {
            operation: event.request.operation,
            requestId: event.request.requestId,
            tabId: event.request.tabId ?? null,
            elapsedMs: (yield* Clock.currentTimeMillis) - startedAt,
            ok: response?.ok ?? false,
            errorTag: response?.error?._tag ?? null,
          });
        }
        if (response === null) return;
        const respond = client[PREVIEW_AUTOMATION_HOST_WS_METHODS.previewAutomationRespond];
        // A result that fails schema encoding must not end the host stream: the server would
        // drop this host's thread claims and the next call would land on a different browser.
        yield* respond(response).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning(
              "Bot browser response was not delivered; returning an error for this call.",
              { requestId: response.requestId, cause },
            ).pipe(Effect.andThen(respond(browserResponseAfterDeliveryFailure(response, cause)))),
          ),
        );
      }),
    ),
    Effect.repeat(Schedule.spaced("1 second")),
    Effect.catchCause((cause) =>
      Effect.sync(onStopped).pipe(
        Effect.andThen(Effect.promise(() => host.close())),
        Effect.ignore,
        Effect.andThen(
          Effect.logError(`Bot browser automation host stopped: ${causeMessage(cause)}`),
        ),
      ),
    ),
    Effect.asVoid,
  );

/** Routes the thread's browser tool calls to this bot's browser instead of the server's. */
export const claimBrowserHostThread = Effect.fn("BotBrowserHost.claimThread")(
  function* (client: RpcSession["client"], host: BrowserAutomationHost | null, threadId: ThreadId) {
    const claim = host?.claim(threadId);
    if (claim === null || claim === undefined) return;
    yield* client[PREVIEW_AUTOMATION_HOST_WS_METHODS.previewAutomationFocusHost](claim);
    yield* Effect.logInfo("Claimed bot browser host for thread", { threadId });
  },
  (effect, _client, _host, threadId) =>
    effect.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not claim bot browser host for thread", { threadId, cause }),
      ),
    ),
);
