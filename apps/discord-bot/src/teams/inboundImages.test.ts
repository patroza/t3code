// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalPromise:off
import { describe, expect, it, vi } from "vite-plus/test";

import { loadTeamsTurnImages, type TeamsTurnImageRequest } from "./inboundImages.ts";

const jpeg = Uint8Array.of(0xff, 0xd8, 0xff, 0xd9);
const png = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

function href(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function authorization(init: RequestInit | undefined): string | null {
  if (init?.headers === undefined) return null;
  return new Headers(init.headers).get("authorization");
}

function request(overrides: Partial<TeamsTurnImageRequest> = {}): TeamsTurnImageRequest {
  return {
    tenantId: "tenant",
    clientId: "client",
    clientSecret: "test-secret",
    messageId: "1793955945716",
    tokens: { graph: "graph-token", bot: "bot-token" },
    location: {
      kind: "channel",
      teamId: "team-guid",
      channelId: "19:channel@thread.tacv2",
    },
    ...overrides,
  };
}

describe("Teams turn images", () => {
  it("downloads a channel hosted screenshot with the Graph token", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = href(input);
      expect(authorization(init)).toBe("Bearer graph-token");
      if (url.endsWith("/hostedContents")) {
        expect(url).toBe(
          "https://graph.microsoft.com/v1.0/teams/team-guid/channels/19%3Achannel%40thread.tacv2/messages/1793955945716/hostedContents",
        );
        return Response.json({ value: [{ id: "hc1", contentType: null, contentBytes: null }] });
      }
      expect(url).toContain("/hostedContents/hc1/$value");
      return new Response(jpeg, { status: 200, headers: { "content-type": "image/jpeg" } });
    });
    const result = await loadTeamsTurnImages(request({ fetch }));
    expect(result.warnings).toEqual([]);
    expect(result.uploads).toHaveLength(1);
    expect(result.uploads[0]).toMatchObject({
      type: "image",
      mimeType: "image/jpeg",
      name: "teams-inline-hc1.jpeg",
      sizeBytes: jpeg.byteLength,
    });
    expect(result.uploads[0]?.dataUrl.startsWith("data:image/jpeg;base64,")).toBe(true);
    expect(result.note).toContain("teams-inline-hc1.jpeg");
  });

  it("reads a reply's hosted contents from the parent message", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = href(input);
      if (url.endsWith("/hostedContents")) {
        expect(url).toContain("/messages/parent/replies/1793955945716/hostedContents");
        return Response.json({
          value: [
            {
              id: "hc1",
              contentType: "image/jpeg",
              contentBytes: Buffer.from(jpeg).toString("base64"),
            },
          ],
        });
      }
      return new Response("unexpected", { status: 500 });
    });
    const result = await loadTeamsTurnImages(request({ fetch, replyToId: "parent" }));
    expect(result.uploads).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("opens an image file card without authorization and only names other files", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = href(input);
      if (url.includes("/hostedContents")) {
        expect(url).toBe(
          "https://graph.microsoft.com/v1.0/chats/19%3Amako%40thread.v2/messages/m1/hostedContents",
        );
        return new Response("missing", { status: 404 });
      }
      expect(url).toBe("https://files.example/shot.png");
      expect(authorization(init)).toBeNull();
      return new Response(png, { status: 200, headers: { "content-type": "image/png" } });
    });
    const result = await loadTeamsTurnImages(
      request({
        fetch,
        messageId: "m1",
        location: { kind: "chat", conversationId: "19:mako@thread.v2;messageid=m1" },
        attachments: [
          {
            contentType: "application/vnd.microsoft.teams.file.download.info",
            name: "shot.png",
            content: { downloadUrl: "https://files.example/shot.png", fileType: "png" },
          },
          {
            contentType: "application/vnd.microsoft.teams.file.download.info",
            name: "notes.pdf",
            content: { downloadUrl: "https://files.example/notes.pdf", fileType: "pdf" },
          },
        ],
      }),
    );
    expect(result.warnings).toEqual([]);
    expect(result.uploads).toHaveLength(1);
    expect(result.uploads[0]?.mimeType).toBe("image/png");
    expect(result.note).toContain("Teams attached files that were not opened: notes.pdf");
    expect(fetch.mock.calls.some((call) => href(call[0]).includes("notes.pdf"))).toBe(false);
  });

  it("retries a bot content URL without authorization and drops it on a cross-host redirect", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = href(input);
      if (url.includes("/hostedContents")) return new Response("missing", { status: 404 });
      if (url === "https://smba.example/original") {
        if (authorization(init) !== null) return new Response("no", { status: 401 });
        return new Response(null, {
          status: 302,
          headers: { location: "https://cdn.example/a.png" },
        });
      }
      expect(url).toBe("https://cdn.example/a.png");
      expect(authorization(init)).toBeNull();
      return new Response(png, { status: 200, headers: { "content-type": "image/png" } });
    });
    const result = await loadTeamsTurnImages(
      request({
        fetch,
        attachments: [
          {
            contentType: "image/png",
            name: "shot.png",
            contentUrl: "https://smba.example/original",
          },
        ],
      }),
    );
    expect(result.warnings).toEqual([]);
    expect(result.uploads).toHaveLength(1);
    expect(result.uploads[0]?.name).toBe("shot.png");
  });

  it("keeps quoted attachment text that is not already in the message", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response("missing", { status: 404 }),
    );
    const result = await loadTeamsTurnImages(
      request({
        fetch,
        plainText: "please look into mako prod",
        attachments: [
          {
            contentType: "text/html",
            content:
              "<p>please look into mako prod</p><blockquote>Please delete this CDC &amp; Wiener Neudorf</blockquote>",
          },
        ],
      }),
    );
    expect(result.uploads).toEqual([]);
    expect(result.note).toContain("Quoted Teams attachment text:");
    expect(result.note).toContain("Please delete this CDC & Wiener Neudorf");
    expect(result.note).not.toContain("please look into mako prod");
  });

  it("reports a hosted-content denial and ignores a missing collection", async () => {
    const denied = vi.fn<typeof globalThis.fetch>(async () => new Response("no", { status: 403 }));
    const deniedResult = await loadTeamsTurnImages(request({ fetch: denied }));
    expect(deniedResult.uploads).toEqual([]);
    expect(deniedResult.warnings).toEqual(["Teams hosted contents failed (403)"]);

    const missing = vi.fn<typeof globalThis.fetch>(
      async () => new Response("missing", { status: 404 }),
    );
    const missingResult = await loadTeamsTurnImages(request({ fetch: missing }));
    expect(missingResult.warnings).toEqual([]);
    expect(missingResult.uploads).toEqual([]);
  });

  it("deduplicates the same screenshot and leaves the ninth image out", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      if (href(input).includes("/hostedContents")) {
        return Response.json({
          value: Array.from({ length: 9 }, (_, index) => ({
            id: `h${index}`,
            contentType: "image/jpeg",
            contentBytes: Buffer.from(Uint8Array.of(0xff, 0xd8, 0xff, index)).toString("base64"),
          })),
        });
      }
      return new Response("unexpected", { status: 500 });
    });
    const capped = await loadTeamsTurnImages(request({ fetch }));
    expect(capped.uploads).toHaveLength(8);
    expect(capped.note).toContain("1 additional Teams images were left out.");

    const shared = Uint8Array.of(0xff, 0xd8, 0xff, 0x10);
    const duplicateFetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = href(input);
      if (url.endsWith("/hostedContents")) {
        return Response.json({
          value: [
            {
              id: "same",
              contentType: "image/jpeg",
              contentBytes: Buffer.from(shared).toString("base64"),
            },
          ],
        });
      }
      expect(authorization(init)).toBeNull();
      return new Response(shared, { status: 200, headers: { "content-type": "image/jpeg" } });
    });
    const duplicated = await loadTeamsTurnImages(
      request({
        fetch: duplicateFetch,
        messageId: "m1",
        location: { kind: "chat", conversationId: "19:mako@thread.v2" },
        attachments: [
          {
            contentType: "application/vnd.microsoft.teams.file.download.info",
            name: "same.jpg",
            content: { downloadUrl: "https://files.example/same.jpg", fileType: "jpg" },
          },
        ],
      }),
    );
    expect(duplicated.uploads).toHaveLength(1);
    expect(duplicated.note).not.toContain("same.jpg");
  });

  it("reuses a Graph token until it is near expiry", async () => {
    let tokenCalls = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = href(input);
      if (url.includes("/oauth2/v2.0/token")) {
        tokenCalls += 1;
        expect(String(init?.body)).toContain("grant_type=client_credentials");
        expect(String(init?.body)).toContain("scope=https%3A%2F%2Fgraph.microsoft.com%2F.default");
        return Response.json({ access_token: "minted", expires_in: 3600 });
      }
      expect(authorization(init)).toBe("Bearer minted");
      return new Response("missing", { status: 404 });
    });
    const tokenCache = new Map<string, { token: string; expiresAt: number }>();
    const { tokens: _injectedTokens, ...input } = request({ fetch, tokenCache });
    await loadTeamsTurnImages(input);
    await loadTeamsTurnImages(input);
    expect(tokenCalls).toBe(1);
  });
});
