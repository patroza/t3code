// @effect-diagnostics globalFetch:off anyUnknownInErrorContext:off
import { it } from "@effect/vitest";
import { DiscordConfig } from "dfx";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { describe, expect, vi } from "vite-plus/test";
import { ensureThreadInfoPin } from "./ThreadInfoPin.ts";

const discordConfig = {
  token: Redacted.make("token"),
  rest: { baseUrl: "https://discord.test/api" },
} as unknown as DiscordConfig.DiscordConfig["Service"];

const patchFailing = (status: number) =>
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    if (init?.method === "PATCH") return new Response("nope", { status });
    if (init?.method === "POST") return Response.json({ id: "new" });
    if (init?.method === "PUT") return new Response(null, { status: 204 });
    return Response.json([]);
  });

const ensure = ensureThreadInfoPin({
  channelId: "thread",
  content: "**Omegent Info**",
  existingMessageId: "info",
}).pipe(Effect.provideService(DiscordConfig.DiscordConfig, discordConfig));

const posts = (fetch: ReturnType<typeof patchFailing>) =>
  fetch.mock.calls.filter(([, init]) => init?.method === "POST").length;

describe("ensureThreadInfoPin", () => {
  it.effect("keeps the stored message when an edit fails for another reason", () =>
    Effect.gen(function* () {
      using fetch = patchFailing(500);
      const pin = yield* ensure;
      expect(pin.messageId).toBe("info");
      expect(posts(fetch)).toBe(0);
    }),
  );

  it.effect("replaces the message only when Discord reports it deleted", () =>
    Effect.gen(function* () {
      using fetch = patchFailing(404);
      const pin = yield* ensure;
      expect(pin.messageId).toBe("new");
      expect(posts(fetch)).toBe(1);
    }),
  );
});
