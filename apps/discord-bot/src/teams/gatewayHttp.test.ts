// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalDate:off globalTimers:off globalPromise:off globalErrorInErrorChannel:off
import { App } from "@microsoft/teams.apps";
import { describe, expect, it, vi } from "vite-plus/test";
import { LoopbackTeamsAdapter, RedactedTeamsLogger } from "./gatewayHttp.ts";

describe("Teams gateway ingress", () => {
  it("reports callback status without logging request content or credentials", async () => {
    const log = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const adapter = new LoopbackTeamsAdapter();
    adapter.registerRoute("POST", "/api/messages", async () => ({ status: 401 }));
    await adapter.start(0);
    try {
      await fetch("http://127.0.0.1:" + adapter.port + "/api/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer private-token" },
        body: JSON.stringify({ text: "private message" }),
      });
      expect(log.mock.calls).toEqual([["Teams callback status: 401\n"]]);
    } finally {
      await adapter.stop();
      log.mockRestore();
    }
  });
  it("uses the real SDK authentication before dispatch and exposes only the callback", async () => {
    const adapter = new LoopbackTeamsAdapter();
    const app = new App({
      clientId: "11111111-1111-4111-8111-111111111111",
      clientSecret: "test-only-secret",
      tenantId: "22222222-2222-4222-8222-222222222222",
      skipAuth: false,
      messagingEndpoint: "/api/messages",
      httpServerAdapter: adapter,
      logger: new RedactedTeamsLogger(),
    });
    const message = vi.fn();
    app.on("message", message);
    await app.start(0);
    const origin = "http://127.0.0.1:" + adapter.port;
    try {
      const response = await fetch(origin + "/api/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "message",
          serviceUrl: "https://smba.trafficmanager.net/emea/",
        }),
      });
      expect(response.status).toBe(401);
      expect(message).not.toHaveBeenCalled();
      for (const path of [
        "/",
        "/api/projects",
        "/ws",
        "/api/messages/extra",
        "/api/messages?x=1",
      ]) {
        expect((await fetch(origin + path, { method: "POST" })).status).toBe(404);
      }
      expect((await fetch(origin + "/api/messages")).status).toBe(405);
      expect((await fetch(origin + "/api/messages", { method: "POST", body: "{}" })).status).toBe(
        415,
      );
      expect(
        (
          await fetch(origin + "/api/messages", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "x".repeat(262145),
          })
        ).status,
      ).toBe(413);
    } finally {
      await app.stop();
    }
  });
});
