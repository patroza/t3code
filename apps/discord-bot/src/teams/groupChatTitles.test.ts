import { describe, expect, it } from "vite-plus/test";

import { makeGroupChatTitleResolver } from "./groupChatTitles.ts";

const chat = "19:abc@thread.v2";

function harness(graph: { status: number; body?: unknown }) {
  const calls: Array<string> = [];
  let clock = 0;
  const fetchImpl = (async (url: string | URL) => {
    const href = String(url);
    calls.push(href);
    if (href.includes("login.microsoftonline.com"))
      return new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }));
    return new Response(JSON.stringify(graph.body ?? {}), { status: graph.status });
  }) as typeof globalThis.fetch;
  const resolve = makeGroupChatTitleResolver({
    clientId: "client",
    clientSecret: () => "secret",
    tokenCache: new Map(),
    fetchImpl,
    now: () => clock,
  });
  return {
    calls,
    resolve,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("makeGroupChatTitleResolver", () => {
  it("uses the activity's title without calling Graph", async () => {
    const h = harness({ status: 200, body: { topic: "ignored" } });
    expect(
      await h.resolve({ tenantId: "t", conversationId: chat, name: " MAKO scanner " }),
    ).toEqual({
      title: "MAKO scanner",
      source: "activity",
    });
    expect(h.calls).toEqual([]);
  });

  it("reads the chat topic from Graph when the activity has none, and caches it", async () => {
    const h = harness({ status: 200, body: { topic: "Empasa scanning" } });
    const first = await h.resolve({
      tenantId: "t",
      conversationId: `${chat};messageid=1`,
      name: undefined,
    });
    expect(first).toEqual({ title: "Empasa scanning", source: "graph", graph: "ok" });
    expect(h.calls.at(-1)).toBe(
      `https://graph.microsoft.com/v1.0/chats/${encodeURIComponent(chat)}?$select=id,topic`,
    );
    await h.resolve({ tenantId: "t", conversationId: chat, name: undefined });
    expect(h.calls.filter((url) => url.includes("/chats/"))).toHaveLength(1);
  });

  it("reports a refused lookup and retries it after a while", async () => {
    const h = harness({ status: 403 });
    expect(await h.resolve({ tenantId: "t", conversationId: chat, name: undefined })).toEqual({
      title: undefined,
      source: "none",
      graph: "403",
    });
    await h.resolve({ tenantId: "t", conversationId: chat, name: undefined });
    expect(h.calls.filter((url) => url.includes("/chats/"))).toHaveLength(1);
    h.advance(11 * 60 * 1000);
    await h.resolve({ tenantId: "t", conversationId: chat, name: undefined });
    expect(h.calls.filter((url) => url.includes("/chats/"))).toHaveLength(2);
  });

  it("treats an untitled chat as having no title", async () => {
    const h = harness({ status: 200, body: { topic: null } });
    expect(await h.resolve({ tenantId: "t", conversationId: chat, name: "" })).toMatchObject({
      title: undefined,
      graph: "no-topic",
    });
  });
});
