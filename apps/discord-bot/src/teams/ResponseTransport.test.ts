// @effect-diagnostics globalPromise:off globalFetch:off
import { it } from "@effect/vitest";
import { describe, expect, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as ConfigProvider from "effect/ConfigProvider";
import { DiscordBotConfig } from "../config.ts";
import { findAlreadyPostedFinalChunkIds } from "../features/ResponseBridge.ts";
import { workingFields, idleFields } from "../features/BotResponseTransport.ts";
import {
  makeTeamsResponseTransport,
  teamsMessageFields,
  normalizeTeamsContent,
  graphMessage,
} from "./ResponseTransport.ts";

const options = {
  clientId: "bot",
  clientSecret: "secret",
  tenantId: "tenant",
  teamId: "team",
  channelId: "channel",
  conversationId: "channel;messageid=root",
  rootMessageId: "root",
  assertActive: () => {},
  send: async () => ({ id: "sent" }),
  deleteMessage: async () => {},
};

describe("Teams response adapter", () => {
  it("adopts an accepted final after a send timeout with Graph's HTML body", () => {
    const final = "**It’s 19:50.**\n\n[Open in T3 Code](https://example.com/?thread=t)";
    const remote = graphMessage({
      id: "landed",
      from: { application: { id: "bot" } },
      body: {
        content:
          '<p><strong>It’s 19:50.</strong></p><p><a href="https://example.com/?thread=t">Open in T3 Code</a></p>',
      },
    });
    expect(
      findAlreadyPostedFinalChunkIds({
        recentMessages: [{ id: remote.id, authorId: remote.author!.id, content: remote.content }],
        botUserId: "bot",
        finalChunks: [final],
        normalizeContent: normalizeTeamsContent,
      }),
    ).toEqual(["landed"]);
  });
  it("keeps one visible working text and removes controls on completion", () => {
    const working = teamsMessageFields(workingFields("Working…", "thread"));
    expect(working.text).toBe("Working…");
    expect(working.attachments?.[0]?.content).toMatchObject({
      body: [],
      actions: [{ data: { action: "omegent", command: "stop", threadId: "thread" } }],
    });
    expect(teamsMessageFields(idleFields("19:50")).attachments).toEqual([]);
  });
  it.effect("reads the newest replies across pages and preserves creation order when editing", () =>
    Effect.gen(function* () {
      const config = yield* DiscordBotConfig.pipe(
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({}))),
      );
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(Response.json({ access_token: "token", expires_in: 3600 }))
        .mockResolvedValueOnce(
          Response.json({
            value: [
              {
                id: "sent",
                createdDateTime: "2026-10-11T17:00:00Z",
                body: { content: "Working…" },
                from: { application: { id: "bot" } },
              },
            ],
            "@odata.nextLink":
              "https://graph.microsoft.com/v1.0/teams/team/channels/channel/messages/root/replies?$skiptoken=next",
          }),
        )
        .mockResolvedValueOnce(
          Response.json({
            value: [
              {
                id: "human",
                createdDateTime: "2026-10-11T17:01:00Z",
                body: { content: "followup" },
                from: { user: { id: "person" } },
              },
            ],
          }),
        );
      const adapter = makeTeamsResponseTransport({ ...options, config, fetch });
      yield* adapter.updateMessage(
        options.conversationId,
        "sent",
        workingFields("Working…", "thread"),
      );
      const history = yield* adapter.listMessages(options.conversationId, { limit: 25 });
      expect(history.map((message) => message.id)).toEqual(["human", "sent"]);
      expect(history[1]?.timestamp).toBe("2026-10-11T17:00:00Z");
    }),
  );
  it.effect("fails closed when the binding is revoked before a send", () =>
    Effect.gen(function* () {
      const config = yield* DiscordBotConfig.pipe(
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({}))),
      );
      const send = vi.fn(options.send);
      const adapter = makeTeamsResponseTransport({
        ...options,
        config,
        send,
        assertActive: () => {
          throw new Error("revoked");
        },
      });
      const result = yield* adapter
        .createMessage(options.conversationId, { content: "answer" })
        .pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      expect(send).not.toHaveBeenCalled();
    }),
  );
});
