import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import {
  EnvironmentId,
  type PreviewAutomationHostClaim,
  type PreviewAutomationStreamEvent,
  ThreadId,
} from "@t3tools/contracts";
import type { RpcSession } from "@t3tools/client-runtime/rpc";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import type { BrowserAutomationHost } from "./BrowserAutomationHost.ts";
import { serveBrowserHost } from "./browserHostSession.ts";

const environmentId = EnvironmentId.make("environment-browser-host");
const threadId = ThreadId.make("thread-bot");

describe("bot browser host session", () => {
  it.effect("re-registers after the server ends the stream and re-claims its threads", () =>
    Effect.gen(function* () {
      const claims = yield* Queue.unbounded<PreviewAutomationHostClaim>();
      const firstEnded = yield* Deferred.make<void>();
      let connects = 0;
      let connectionId: string | null = null;
      const host = {
        registration: () => ({ clientId: "discord-browser-default", environmentId }),
        consume: async (event: PreviewAutomationStreamEvent) => {
          if (event.type === "connected") connectionId = event.connectionId;
          return null;
        },
        reclaims: () =>
          connectionId === null
            ? []
            : [
                {
                  clientId: "discord-browser-default",
                  environmentId,
                  connectionId,
                  focused: true,
                  threadId,
                },
              ],
        close: async () => {},
      } as unknown as BrowserAutomationHost;
      const client = {
        "previewAutomation.connect": () => {
          connects += 1;
          const event: PreviewAutomationStreamEvent = {
            type: "connected",
            connectionId: `connection-${connects}`,
          };
          const connected = Stream.make(event);
          return connects === 1
            ? connected.pipe(Stream.ensuring(Deferred.succeed(firstEnded, undefined)))
            : Stream.concat(connected, Stream.never);
        },
        "previewAutomation.focusHost": (claim: PreviewAutomationHostClaim) =>
          Queue.offer(claims, claim),
        "previewAutomation.respond": () => Effect.void,
      } as unknown as RpcSession["client"];

      yield* serveBrowserHost(client, host, () => {}).pipe(Effect.forkScoped);
      expect((yield* Queue.take(claims)).connectionId).toBe("connection-1");
      yield* Deferred.await(firstEnded);
      yield* TestClock.adjust("1 second");
      const reclaimed = yield* Queue.take(claims);
      expect(reclaimed).toMatchObject({ connectionId: "connection-2", threadId, focused: true });
    }),
  );
});
