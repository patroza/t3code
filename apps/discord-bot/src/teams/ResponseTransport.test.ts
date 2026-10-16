// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalPromise:off globalFetch:off
import { it } from "@effect/vitest";
import { ThreadId, ProjectId } from "@t3tools/contracts";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, vi, beforeEach, afterEach } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as ConfigProvider from "effect/ConfigProvider";
import { ThreadLinkStore, makeThreadLinkStore } from "../store/ThreadLinkStore.ts";
import { ProjectAliasStore, makeProjectAliasStore } from "../projectAliases.ts";
import { T3Session, type T3SessionService } from "../t3/T3Session.ts";
import { DiscordBotConfig } from "../config.ts";
import { findAlreadyPostedFinalChunkIds } from "../features/ResponseBridge.ts";
import { workingFields, idleFields, wakeUpFields } from "../features/BotResponseTransport.ts";
import { channelTopicOptsIntoInProgressStream } from "../presentation/attachments.ts";
import {
  makeTeamsResponseTransport,
  teamsMessageFields,
  teamsControlActivity,
  teamsInfoRefreshFields,
  teamsMessageIsThreadInfo,
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
  it.effect("updates one labelled thread-info message as workspace setup progresses", () =>
    Effect.gen(function* () {
      const config = yield* DiscordBotConfig.pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnvRecord({
              T3_DISCORD_BOT_DATA_DIR: directory,
              T3_WEB_UI_BASE_URL: "https://omega.example",
            }),
          ),
        ),
      );
      const links = yield* makeThreadLinkStore(directory);
      yield* links.put({
        discordThreadId: options.conversationId,
        t3ThreadId: ThreadId.make("scanner-thread"),
        projectId: ProjectId.make("scanner"),
        channelId: "channel",
        guildId: "team",
        createdAt: "2026-10-15T10:00:00.000Z",
      });
      const send = vi
        .fn<(wire: TeamsResponseActivity) => Promise<{ id: string }>>()
        .mockResolvedValue({ id: "info" });
      const adapter = makeTeamsResponseTransport({ ...options, config, send });
      for (const workspace of [
        { workspaceStatus: "preparing" as const },
        { workspaceStatus: "preparing" as const, worktreePath: "/worktrees/scanner/task" },
        { worktreePath: "/worktrees/scanner/task" },
        { workspaceStatus: "failed" as const, worktreePath: "/worktrees/scanner/task" },
      ]) {
        yield* adapter
          .upsertThreadInfo({
            config,
            conversationId: options.conversationId,
            threadId: "scanner-thread",
            modelSelection: { instanceId: "grok", model: "grok-4.7" },
            ...workspace,
          })
          .pipe(
            Effect.provideService(ThreadLinkStore, links),
            Effect.provideService(ProjectAliasStore, makeProjectAliasStore([])),
            Effect.provideService(T3Session, {} as T3SessionService),
          );
      }
      expect(send).toHaveBeenCalledTimes(4);
      expect(send.mock.calls[0]?.[0].id).toBeUndefined();
      expect(send.mock.calls.slice(1).every(([activity]) => activity.id === "info")).toBe(true);
      expect(send.mock.calls[0]?.[0].text).toContain("Preparing workspace…");
      expect(send.mock.calls[0]?.[0].text).not.toContain("local (no worktree)");
      expect(send.mock.calls[1]?.[0].text).toContain("Worktree: `/worktrees/scanner/task`");
      expect(send.mock.calls[1]?.[0].text).toContain("Preparing workspace…");
      expect(send.mock.calls[2]?.[0].text).toContain("Worktree: `/worktrees/scanner/task`");
      expect(send.mock.calls[2]?.[0].text).not.toContain("Preparing workspace…");
      expect(send.mock.calls[3]?.[0].text).toContain("Workspace setup failed.");
      expect(send.mock.calls[0]?.[0].text).toContain(
        "[Open in Omegent](https://omega.example/?thread=scanner-thread)",
      );
      expect(send.mock.calls[0]?.[0].textFormat).toBe("extendedmarkdown");
    }),
  );
  it("keeps a delivered Teams reply when thread info refreshes", () => {
    expect(teamsMessageIsThreadInfo("**Omegent Info**\nModel: `grok/grok-4.7`")).toBe(true);
    expect(teamsMessageIsThreadInfo("**Omegent Info**\n\n_Working.._")).toBe(true);
    expect(teamsMessageIsThreadInfo("_Working.._")).toBe(false);
    expect(teamsMessageIsThreadInfo("No secrets in the repositories.")).toBe(false);
    expect(
      teamsInfoRefreshFields({
        rendered: "**Omegent Info**\nModel: `grok/grok-4.7`",
        current: "**Omegent Info**\nModel: `grok/grok-4.7`\n\n_Working.._",
        threadId: "thread",
      })?.content,
    ).toBe("**Omegent Info**\nModel: `grok/grok-4.7`\n\n_Working.._");
    expect(
      teamsInfoRefreshFields({
        rendered: "**Omegent Info**\nModel: `grok/grok-4.7`",
        current: "No secrets in the repositories.",
        threadId: "thread",
      }),
    ).toBeNull();
  });
  it.effect("does not post a second Teams message over a delivered reply", () =>
    Effect.gen(function* () {
      const config = yield* DiscordBotConfig.pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnvRecord({ T3_DISCORD_BOT_DATA_DIR: directory }),
          ),
        ),
      );
      const links = yield* makeThreadLinkStore(directory);
      yield* links.put({
        discordThreadId: options.conversationId,
        t3ThreadId: ThreadId.make("scanner-thread"),
        projectId: ProjectId.make("scanner"),
        channelId: "channel",
        guildId: "team",
        createdAt: "2026-10-15T10:00:00.000Z",
      });
      const send = vi
        .fn<(wire: TeamsResponseActivity) => Promise<{ id?: string }>>()
        .mockImplementation(async (wire) => ({ id: wire.id ?? "info" }));
      const adapter = makeTeamsResponseTransport({ ...options, config, send });
      const provide = <A, E>(
        effect: Effect.Effect<A, E, ThreadLinkStore | ProjectAliasStore | T3Session>,
      ) =>
        effect.pipe(
          Effect.provideService(ThreadLinkStore, links),
          Effect.provideService(ProjectAliasStore, makeProjectAliasStore([])),
          Effect.provideService(T3Session, {} as T3SessionService),
        );
      yield* provide(
        adapter.upsertThreadInfo({
          config,
          conversationId: options.conversationId,
          threadId: "scanner-thread",
          modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
        }),
      );
      yield* adapter.updateMessage(options.conversationId, "info", {
        content: "No secrets in the repositories.",
      });
      const callsAfterReply = send.mock.calls.length;
      yield* provide(
        adapter.upsertThreadInfo({
          config,
          conversationId: options.conversationId,
          threadId: "scanner-thread",
          modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
          worktreePath: "/var/lib/t3/worktrees/HausfuxApps/t3-teams-23b871f2",
        }),
      );
      expect(send.mock.calls.length).toBe(callsAfterReply);
      expect((yield* adapter.getMessage(options.conversationId, "info")).content).toBe(
        "No secrets in the repositories.",
      );
    }),
  );
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
  it("recovers an accepted native table from Graph HTML after a timeout", () => {
    const final = "Build report\n\n| Item | Status |\n| --- | --- |\n| **Build** | Ready |";
    const remote = graphMessage({
      id: "landed",
      from: { application: { id: "bot" } },
      body: {
        content:
          "<p>Build report</p><table><tr><th>Item</th><th>Status</th></tr><tr><td><strong>Build</strong></td><td>Ready</td></tr></table>",
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
  it("preserves native Markdown tables in replies and progress messages", () => {
    const content = "| Item | Status |\n| --- | --- |\n| Build | Ready |";
    for (const fields of [idleFields(content), workingFields(content, "thread")]) {
      expect(teamsMessageFields(fields)).toMatchObject({
        text: content,
        textFormat: "extendedmarkdown",
      });
    }
  });
  it("keeps working text free of cards and posts Stop as its own activity", () => {
    const working = teamsMessageFields(workingFields("Working…", "thread"));
    expect(working.text).toBe("Working…");
    expect(working.textFormat).toBe("extendedmarkdown");
    expect(working.attachments).toEqual([]);
    expect(teamsControlActivity(workingFields("Working…", "thread"))).toMatchObject({
      text: "",
      attachments: [
        {
          content: {
            body: [],
            actions: [{ data: { action: "omegent", command: "stop", threadId: "thread" } }],
          },
        },
      ],
    });
    expect(teamsControlActivity(idleFields("19:50"))).toBeNull();
  });
  it.effect("uploads a channel document with extended Markdown text and SharePoint controls", () =>
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
      expect(send.mock.calls[0]?.[0].text).toBe("Here is the report.");
      expect(send.mock.calls[0]?.[0].textFormat).toBe("extendedmarkdown");
      expect(send.mock.calls[0]?.[0].attachments?.[0]?.content).toMatchObject({
        body: [],
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
  it.live("repairs idless rows and adopts a sent reply before editing it in place", () =>
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
      const deleteMessage = vi.fn(async () => {});
      const send = vi.fn<(wire: TeamsResponseActivity) => Promise<{ id?: string }>>(async (wire) =>
        wire.attachments?.length ? { id: "control-1" } : {},
      );
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
                body: { content: '<p>Working…</p><attachment id="card"></attachment>' },
                attachments: [
                  {
                    contentType: "application/vnd.microsoft.card.adaptive",
                    content: JSON.stringify({
                      body: [],
                    }),
                  },
                ],
              },
            ],
          }),
        );
      const adapter = makeTeamsResponseTransport({
        ...options,
        config,
        send,
        fetch,
        deleteMessage,
      });
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
      expect(send.mock.calls.map(([wire]) => wire.id)).toEqual([
        undefined,
        undefined,
        remoteId,
        remoteId,
      ]);
      expect(send.mock.calls[0]?.[0].attachments).toEqual([]);
      expect(send.mock.calls[1]?.[0]).toMatchObject({
        text: "",
        attachments: [{ content: { body: [], actions: [{ title: "Stop" }] } }],
      });
      expect(send.mock.calls[2]?.[0]).toMatchObject({
        id: remoteId,
        text: "Checking…",
        attachments: [],
      });
      expect(send.mock.calls[3]?.[0].attachments).toEqual([]);
      expect(deleteMessage).toHaveBeenCalledTimes(1);
      expect(deleteMessage).toHaveBeenCalledWith("control-1");
      const rows = JSON.parse(NodeFS.readFileSync(ledgerPath, "utf8")) as Array<{
        id: string;
        content: string;
        controlId?: string;
      }>;
      expect(rows.map((row) => row.id).sort()).toEqual([remoteId, "sent"].sort());
      expect(rows.find((row) => row.id === remoteId)?.content).toBe("It’s 21:08 UTC.");
      expect(rows.find((row) => row.id === remoteId)?.controlId).toBeUndefined();
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
              {
                id: "stop-card",
                createdDateTime: "2026-10-11T17:02:00Z",
                body: { content: "" },
                from: { application: { id: "bot" } },
                attachments: [
                  {
                    contentType: "application/vnd.microsoft.card.adaptive",
                    content: JSON.stringify({
                      type: "AdaptiveCard",
                      version: "1.4",
                      body: [],
                      actions: [{ type: "Action.Execute", title: "Stop" }],
                    }),
                  },
                ],
              },
            ],
          }),
        );
      const adapter = makeTeamsResponseTransport({
        ...options,
        config,
        fetch,
        send: async (wire) => ({ id: wire.attachments?.length ? "control" : (wire.id ?? "sent") }),
      });
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
  it.effect(
    "deletes the Stop card with its working text and replaces it when the action changes",
    () =>
      Effect.gen(function* () {
        const config = yield* DiscordBotConfig.pipe(
          Effect.provide(
            ConfigProvider.layer(
              ConfigProvider.fromEnvRecord({ T3_DISCORD_BOT_DATA_DIR: directory }),
            ),
          ),
        );
        let texts = 0;
        let controls = 0;
        const send = vi.fn(async (wire: TeamsResponseActivity) => {
          if (wire.id) return { id: wire.id };
          if (wire.attachments?.length) return { id: `control-${++controls}` };
          return { id: `text-${++texts}` };
        });
        const deleteMessage = vi.fn(async (_messageId: string) => {});
        const adapter = makeTeamsResponseTransport({
          ...options,
          config,
          send,
          deleteMessage,
          teamId: "",
          channelId: "",
        });
        const working = yield* adapter.createMessage(
          options.conversationId,
          workingFields("Working…", "thread"),
        );
        yield* adapter.updateMessage(
          options.conversationId,
          working.id,
          workingFields("Checking…", "thread"),
        );
        expect(send.mock.calls.filter(([wire]) => wire.attachments?.length)).toHaveLength(1);
        const woken = yield* adapter.updateMessage(
          options.conversationId,
          working.id,
          wakeUpFields("Still going", "thread"),
        );
        expect(woken.id).toBe(working.id);
        expect(send.mock.calls.at(-1)?.[0]).toMatchObject({
          id: "control-1",
          text: "",
          attachments: [{ content: { actions: [{ title: "Continue" }] } }],
        });
        yield* adapter.deleteMessage(options.conversationId, working.id);
        expect(deleteMessage.mock.calls.map(([id]) => id)).toEqual(["control-1", working.id]);
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
