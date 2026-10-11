// @effect-diagnostics nodeBuiltinImport:off globalDateInEffect:off unsafeEffectTypeAssertion:off missingEffectContext:off anyUnknownInErrorContext:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { it } from "@effect/vitest";
import { expect, describe } from "vite-plus/test";
import type * as Scope from "effect/Scope";
import { ProjectAliasStore, makeProjectAliasStore } from "../projectAliases.ts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as ConfigProvider from "effect/ConfigProvider";
import { IntegrationThreadView } from "@t3tools/shared/integrationThreadView";
import { DiscordBotConfig } from "../config.ts";
import { ThreadLinkStore, makeThreadLinkStore } from "../store/ThreadLinkStore.ts";
import { ThreadWarmCacheStore, makeThreadWarmCacheStore } from "../store/ThreadWarmCacheStore.ts";
import { T3Session, type T3SessionService } from "../t3/T3Session.ts";
import {
  BotResponseTransport,
  type BotMessage,
  type BotResponseTransportService,
} from "./BotResponseTransport.ts";
import { runBridge } from "./ResponseBridge.ts";

const time = "2026-10-11T17:50:00.000Z";
const decodeThread = Schema.decodeUnknownSync(IntegrationThreadView);
function fixture(completed: boolean) {
  return decodeThread({
    id: "thread",
    projectId: "project",
    title: "Time request",
    modelSelection: {
      instanceId: "codex",
      model: "gpt-6.1-sol",
      options: [{ id: "reasoningEffort", value: "medium" }],
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    pullRequests: [],
    createdAt: time,
    updatedAt: time,
    archivedAt: null,
    deletedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    proposedPlans: [],
    checkpoints: [],
    latestTurn: {
      turnId: "turn",
      state: completed ? "completed" : "running",
      requestedAt: time,
      startedAt: time,
      completedAt: completed ? time : null,
      assistantMessageId: completed ? "answer" : null,
    },
    messages: [
      {
        id: "question",
        role: "user",
        text: "Authorized Teams request: What is the time?",
        turnId: "turn",
        streaming: false,
        createdAt: time,
        updatedAt: time,
      },
      ...(completed
        ? [
            {
              id: "answer",
              role: "assistant",
              text: "It’s 19:50 CEST.",
              turnId: "turn",
              streaming: false,
              createdAt: time,
              updatedAt: time,
            },
          ]
        : []),
    ],
    activities: completed
      ? [
          {
            id: "usage",
            tone: "info",
            kind: "context-window.updated",
            summary: "usage",
            turnId: "turn",
            createdAt: time,
            payload: { lastInputTokens: 1500, lastOutputTokens: 250, durationMs: 2000 },
          },
        ]
      : [],
  });
}

describe("shared response runner", () => {
  it.live.each(["discord", "teams"] as const)(
    "delivers working, turn info and token statistics through the %s transport",
    (platform) =>
      Effect.gen(function* () {
        const directory = yield* Effect.acquireRelease(
          Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "shared-bot-test-"))),
          (directory) =>
            Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
        );
        const links = yield* makeThreadLinkStore(directory);
        const warm = yield* makeThreadWarmCacheStore(directory);
        const running = fixture(false),
          completed = fixture(true);
        yield* links.put({
          sourceKind: platform,
          sourceThreadId: "source",
          discordThreadId: "conversation",
          t3ThreadId: completed.id,
          projectId: completed.projectId,
          channelId: "channel",
          guildId: "team",
          createdAt: time,
        });
        const config = yield* DiscordBotConfig.pipe(
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({}))),
        );
        const working = yield* Deferred.make<void>();
        const final = yield* Deferred.make<string>();
        const info = yield* Deferred.make<string>();
        const ready = yield* Deferred.make<void>();
        const messages = new Map<string, BotMessage>();
        let counter = 0;
        const write = (content: string, id?: string) =>
          Effect.gen(function* () {
            const message = { id: id ?? String(++counter), content, author: { id: "bot" } };
            messages.set(message.id, message);
            if (/working/iu.test(content)) yield* Deferred.succeed(working, undefined);
            if (content.includes("It’s 19:50 CEST.") && content.includes("↑1.5k"))
              yield* Deferred.succeed(final, content);
            return message;
          });
        const adapter: BotResponseTransportService = {
          platform,
          config: { ...config, webUiBaseUrl: "https://example.com" },
          contentLimit: 2000,
          fileLimit: 10,
          uploadLimitBytes: 10_000_000,
          normalizeContent: (text) => text.trim(),
          getMyUser: () => Effect.succeed({ id: "bot" }),
          getChannel: (id) => Effect.succeed({ id, type: 0, topic: "omegent-ips" }),
          updateChannel: () => Effect.void,
          getMessage: (_, id) => Effect.succeed(messages.get(id)!),
          listMessages: () => Effect.succeed([...messages.values()].reverse()),
          createMessage: (_, fields) => write(fields.content),
          updateMessage: (_, id, fields) => write(fields.content, id),
          deleteMessage: (_, id) =>
            Effect.sync(() => {
              messages.delete(id);
            }),
          createMessageWithFiles: (_, content) => write(content),
          upsertThreadInfo: (input) =>
            Deferred.succeed(info, input.modelSelection?.model ?? "").pipe(Effect.asVoid),
        };
        const session = {
          fetchThreadDetail: () => Effect.succeed({ thread: completed, snapshotSequence: 1 }),
          getProjectShell: () => Effect.succeed(null),
          refreshVcsStatus: () => Effect.succeed(null),
          subscribeThread: (
            _id: Parameters<T3SessionService["subscribeThread"]>[0],
            onThread: Parameters<T3SessionService["subscribeThread"]>[1],
          ) =>
            Effect.gen(function* () {
              yield* onThread(running);
              yield* Deferred.await(working);
              yield* onThread(completed);
              return yield* Effect.never;
            }),
        } as unknown as T3SessionService;
        const fiber = yield* runBridge(
          {
            discordChannelId: "conversation",
            t3ThreadId: "thread",
            sentDiscordUserMessageIds: ["question"],
          },
          ready,
          {
            noteSentUserMessageIds: () => Effect.void,
            adoptWorkingAckMessageId: () => Effect.void,
            refreshThreadIndicators: () => Effect.succeed({ ok: false, error: "unused" }),
          },
        ).pipe(
          Effect.provideService(T3Session, session),
          Effect.provideService(BotResponseTransport, adapter),
          Effect.provideService(ThreadLinkStore, links),
          Effect.provideService(ThreadWarmCacheStore, warm),
          Effect.provideService(ProjectAliasStore, makeProjectAliasStore([])),
          // T3Session erases subscriber callback requirements; all bridge services are supplied.
          (effect) => effect as Effect.Effect<void, unknown, Scope.Scope>,
          Effect.forkChild,
        );
        const answer = yield* Deferred.await(final);
        expect(answer).toContain("gpt-6.1-sol");
        expect(answer).toContain("effort medium");
        expect(answer).toContain("↑1.5k ↓250");
        expect(answer).toContain("https://example.com");
        expect(yield* Deferred.await(info)).toBe("gpt-6.1-sol");
        yield* Fiber.interrupt(fiber);
        const stored = yield* links.getByDiscordThreadId("conversation");
        expect(stored?.lastFinalizedAssistantId).toBe("answer");
      }).pipe(Effect.scoped),
    15000,
  );
});
