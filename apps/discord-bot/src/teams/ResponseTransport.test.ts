// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalPromise:off globalFetch:off
import { it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, vi, beforeEach, afterEach } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as ConfigProvider from "effect/ConfigProvider";
import { DiscordBotConfig } from "../config.ts";
import { findAlreadyPostedFinalChunkIds } from "../features/ResponseBridge.ts";
import { workingFields, idleFields } from "../features/BotResponseTransport.ts";
import { channelTopicOptsIntoInProgressStream } from "../presentation/attachments.ts";
import {
  makeTeamsResponseTransport,
  teamsMessageFields,
  normalizeTeamsContent,
  graphMessage,
  type TeamsResponseActivity,
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
  let directory: string;
  beforeEach(() => {
    directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "teams-adapter-"));
  });
  afterEach(() => NodeFS.rmSync(directory, { recursive: true, force: true }));
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
    expect(working.text).toBe("");
    expect(working.attachments?.[0]?.content).toMatchObject({
      body: [{ type: "TextBlock", text: "Working…", wrap: true }],
      actions: [{ data: { action: "omegent", command: "stop", threadId: "thread" } }],
    });
    expect(teamsMessageFields(idleFields("19:50")).attachments).toEqual([]);
  });
  it.effect("uploads a channel document and sends one answer card with its SharePoint link", () =>
    Effect.gen(function* () {
      const config = yield* DiscordBotConfig.pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnvRecord({ T3_DISCORD_BOT_DATA_DIR: directory }),
          ),
        ),
      );
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(Response.json({ access_token: "token", expires_in: 3600 }))
        .mockResolvedValueOnce(
          Response.json({
            id: "file",
            name: "stored-report.csv",
            webUrl: "https://omega.sharepoint.com/sites/Omega/report.csv",
          }),
        );
      const send = vi
        .fn<(wire: TeamsResponseActivity) => Promise<{ id: string }>>()
        .mockResolvedValue({ id: "sent" });
      const adapter = makeTeamsResponseTransport({
        ...options,
        config,
        fetch,
        send,
        fileDestination: {
          driveId: "drive",
          folderId: "folder",
          siteUrl: "https://omega.sharepoint.com/sites/Omega",
        },
      });
      const message = yield* adapter.createMessageWithFiles(
        options.conversationId,
        "Here is the report.",
        [{ name: "report.csv", mimeType: "text/csv", data: new Uint8Array([65, 66]) }],
      );
      expect(message.id).toBe("sent");
      expect((yield* adapter.getMessage(options.conversationId, message.id)).content).toBe(
        "Here is the report.",
      );
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0]?.[0].text).toBe("");
      expect(send.mock.calls[0]?.[0].attachments?.[0]?.content).toMatchObject({
        body: [{ type: "TextBlock", text: "Here is the report.", wrap: true }],
        actions: [
          {
            type: "Action.OpenUrl",
            title: "report.csv",
            url: "https://omega.sharepoint.com/sites/Omega/report.csv",
          },
        ],
      });
      expect(fetch.mock.calls[1]?.[1]?.method).toBe("PUT");
    }),
  );
  it.effect("keeps progress-history files opt-in for each Teams channel", () =>
    Effect.gen(function* () {
      const config = yield* DiscordBotConfig.pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnvRecord({ T3_DISCORD_BOT_DATA_DIR: directory }),
          ),
        ),
      );
      const ordinary = makeTeamsResponseTransport({ ...options, config });
      const described = makeTeamsResponseTransport({
        ...options,
        config,
        getChannelTopic: async () => "omegent-link-t3code omegent-ips",
      });
      expect((yield* described.getChannel(options.conversationId)).topic).toBe(
        "omegent-link-t3code omegent-ips",
      );

      const optedIn = makeTeamsResponseTransport({
        ...options,
        config,
        includeProgressHistory: true,
      });
      expect(
        channelTopicOptsIntoInProgressStream(
          (yield* ordinary.getChannel(options.conversationId)).topic,
        ),
      ).toBe(false);
      expect(
        channelTopicOptsIntoInProgressStream(
          (yield* optedIn.getChannel(options.conversationId)).topic,
        ),
      ).toBe(true);
    }),
  );
  it.live("repairs idless rows and adopts a sent card before editing it in place", () =>
    Effect.gen(function* () {
      const config = yield* DiscordBotConfig.pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnvRecord({ T3_DISCORD_BOT_DATA_DIR: directory }),
          ),
        ),
      );
      const first = makeTeamsResponseTransport({ ...options, config });
      yield* first.createMessage(options.conversationId, { content: "previous answer" });
      const ledgerDir = NodePath.join(directory, "teams-response-ledger");
      const ledgerPath = NodePath.join(ledgerDir, NodeFS.readdirSync(ledgerDir)[0]!);
      NodeFS.writeFileSync(
        ledgerPath,
        JSON.stringify([
          { id: "sent", content: "previous answer", author: { id: "bot" } },
          { content: "Working..", author: { id: "bot" }, timestamp: "2026-10-11T21:08:39Z" },
        ]),
      );
      const remoteId = "1791752939872";
      const now = yield* DateTime.now;
      const send = vi
        .fn<(wire: TeamsResponseActivity) => Promise<{ id?: string }>>()
        .mockResolvedValue({});
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(Response.json({ access_token: "token", expires_in: 3600 }))
        .mockResolvedValueOnce(
          Response.json({
            value: [
              {
                id: remoteId,
                from: { application: { id: "bot" } },
                createdDateTime: DateTime.formatIso(now),
                body: { content: '<attachment id="card"></attachment>' },
                attachments: [
                  {
                    contentType: "application/vnd.microsoft.card.adaptive",
                    content: JSON.stringify({
                      body: [{ type: "TextBlock", text: "Working…", wrap: true }],
                    }),
                  },
                ],
              },
            ],
          }),
        );
      const adapter = makeTeamsResponseTransport({ ...options, config, send, fetch });
      const working = yield* adapter.createMessage(
        options.conversationId,
        workingFields("Working…", "thread"),
      );
      expect(working.id).toBe(remoteId);
      yield* adapter.updateMessage(
        options.conversationId,
        working.id,
        workingFields("Checking…", "thread"),
      );
      const final = yield* adapter.updateMessage(
        options.conversationId,
        working.id,
        idleFields("It’s 21:08 UTC."),
      );
      expect(final.id).toBe(remoteId);
      expect(send.mock.calls.map(([wire]) => wire.id)).toEqual([undefined, remoteId, remoteId]);
      expect(send.mock.calls[1]?.[0].attachments?.[0]?.content).toMatchObject({
        body: [{ type: "TextBlock", text: "Checking…", wrap: true }],
      });
      expect(send.mock.calls[2]?.[0].attachments).toEqual([]);
      const rows = JSON.parse(NodeFS.readFileSync(ledgerPath, "utf8")) as Array<{
        id: string;
        content: string;
      }>;
      expect(rows.map((row) => row.id).sort()).toEqual([remoteId, "sent"].sort());
      expect(rows.find((row) => row.id === remoteId)?.content).toBe("It’s 21:08 UTC.");
      expect(
        NodeFS.readdirSync(ledgerDir).filter((name) => name.includes(".invalid-")).length,
      ).toBe(1);
      const restored = makeTeamsResponseTransport({ ...options, config, send, fetch });
      expect((yield* restored.getMessage(options.conversationId, remoteId)).content).toBe(
        "It’s 21:08 UTC.",
      );
    }),
  );
  it.effect("reads the newest replies across pages and preserves creation order when editing", () =>
    Effect.gen(function* () {
      const config = yield* DiscordBotConfig.pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnvRecord({ T3_DISCORD_BOT_DATA_DIR: directory }),
          ),
        ),
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
  it.effect("retains personal-chat replies and incoming messages across adapter recreation", () =>
    Effect.gen(function* () {
      const config = yield* DiscordBotConfig.pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnvRecord({ T3_DISCORD_BOT_DATA_DIR: directory }),
          ),
        ),
      );
      const fetch = vi.fn<typeof globalThis.fetch>();
      const first = makeTeamsResponseTransport({
        ...options,
        config,
        teamId: "",
        channelId: "",
        fetch,
      });
      yield* first.createMessage(options.conversationId, { content: "answer" });
      const restored = makeTeamsResponseTransport({
        ...options,
        config,
        teamId: "",
        channelId: "",
        fetch,
        incomingMessage: {
          id: "human",
          content: "followup",
          timestamp: "2099-01-01T00:00:00Z",
          author: { id: "person" },
        },
      });
      yield* first.updateMessage(options.conversationId, "sent", { content: "updated answer" });
      const history = yield* restored.listMessages(options.conversationId, { limit: 25 });
      expect(history.map((message) => message.id)).toEqual(["human", "sent"]);
      expect(history[1]?.content).toBe("updated answer");
      expect(fetch).not.toHaveBeenCalled();
    }),
  );
  it.effect("fails closed when the binding is revoked before a send", () =>
    Effect.gen(function* () {
      const config = yield* DiscordBotConfig.pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnvRecord({ T3_DISCORD_BOT_DATA_DIR: directory }),
          ),
        ),
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
