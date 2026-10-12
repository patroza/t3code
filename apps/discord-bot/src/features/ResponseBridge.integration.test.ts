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
import { MessageId } from "@t3tools/contracts";
import { DiscordBotConfig } from "../config.ts";
import { ThreadLinkStore, makeThreadLinkStore } from "../store/ThreadLinkStore.ts";
import { ThreadWarmCacheStore, makeThreadWarmCacheStore } from "../store/ThreadWarmCacheStore.ts";
import { T3Session, type T3SessionService } from "../t3/T3Session.ts";
import {
  BotResponseTransport,
  type BotMessage,
  type BotMessageFields,
  BotTransportError,
  type BotResponseTransportService,
} from "./BotResponseTransport.ts";
import { runBridge } from "./ResponseBridge.ts";

const time = "2026-10-11T17:50:00.000Z";
const decodeThread = Schema.decodeUnknownSync(IntegrationThreadView);
function fixture(completed: boolean, progress = false, longAnswer = false) {
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
      runStatus: completed ? "completed" : progress ? "waiting" : "starting",
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
      ...(progress
        ? [
            {
              id: "progress-1",
              role: "assistant",
              text: "Reviewing " + "earlier commentary ".repeat(140),
              turnId: "turn",
              streaming: false,
              createdAt: time,
              updatedAt: time,
            },
            {
              id: "progress-2",
              role: "assistant",
              text: "Checking the current result.",
              turnId: "turn",
              streaming: true,
              createdAt: time,
              updatedAt: time,
            },
          ]
        : []),
      ...(completed
        ? [
            {
              id: "answer",
              role: "assistant",
              text:
                (longAnswer ? "A substantial final answer. ".repeat(170) : "") + "It’s 19:50 CEST.",
              turnId: "turn",
              streaming: true,
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
  it.live.each([
    { platform: "discord", failure: "none" },
    { platform: "discord", failure: "progress" },
    { platform: "discord", failure: "final" },
    { platform: "discord", failure: "missing" },
    { platform: "discord", failure: "partial-final" },
    { platform: "discord", failure: "accepted-final" },
    { platform: "discord", failure: "late-final" },
    { platform: "discord", failure: "restart" },
    { platform: "discord", failure: "upload" },
    { platform: "discord", failure: "shutdown" },
    { platform: "discord", failure: "same-run-follow-up" },
    { platform: "teams", failure: "none" },
    { platform: "teams", failure: "progress" },
    { platform: "teams", failure: "final" },
    { platform: "teams", failure: "missing" },
    { platform: "teams", failure: "partial-final" },
    { platform: "teams", failure: "accepted-final" },
    { platform: "teams", failure: "late-final" },
    { platform: "teams", failure: "restart" },
    { platform: "teams", failure: "upload" },
    { platform: "teams", failure: "shutdown" },
  ] as const)(
    "delivers progress and final replies through $platform (failure=$failure)",
    ({ platform, failure }) =>
      Effect.gen(function* () {
        const directory = yield* Effect.acquireRelease(
          Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "shared-bot-test-"))),
          (directory) =>
            Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
        );
        const links = yield* makeThreadLinkStore(directory);
        const warm = yield* makeThreadWarmCacheStore(directory);
        const running = fixture(false);
        let completed = fixture(true, false, ["partial-final", "accepted-final"].includes(failure));
        if (failure === "upload") {
          const paths = ["first.txt", "second.txt"].map((name) => NodePath.join(directory, name));
          yield* Effect.sync(() => {
            for (const path of paths) NodeFS.writeFileSync(path, "x".repeat(40));
          });
          completed = {
            ...completed,
            messages: completed.messages.map((message) =>
              message.id === "answer"
                ? {
                    ...message,
                    text:
                      message.text +
                      paths.map((path) => `\n[${NodePath.basename(path)}](${path})`).join(""),
                  }
                : message,
            ),
          };
        }
        yield* links.put({
          sourceKind: platform,
          sourceThreadId: "source",
          discordThreadId: "conversation",
          t3ThreadId: completed.id,
          projectId: completed.projectId,
          channelId: "channel",
          guildId: "team",
          createdAt: time,
          ...(failure === "restart"
            ? {
                lastFinalizedAssistantId: "answer",
                streamDiscordMessageIds: ["1"],
                deliveryReceipt: {
                  assistantId: "answer",
                  turnId: "turn",
                  text: "It’s 19:50 CEST.",
                  messageIds: ["1"],
                  uploads: [],
                  completed: true,
                },
              }
            : {}),
        });
        const config = yield* DiscordBotConfig.pipe(
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({}))),
        );
        const working = yield* Deferred.make<void>();
        const progress = yield* Deferred.make<void>();
        const followUpProgress = yield* Deferred.make<void>();
        const followUpFinal = yield* Deferred.make<string>();
        const resumed = yield* Deferred.make<void>();
        const grown = yield* Deferred.make<string>();
        const blockedWrite = yield* Deferred.make<void>();
        const releaseWrite = yield* Deferred.make<void>();
        let stopped = false;
        let writesAfterStop = 0;
        const failed = yield* Deferred.make<void>();
        const final = yield* Deferred.make<string>();
        const info = yield* Deferred.make<string>();
        const ready = yield* Deferred.make<void>();
        const messages = new Map<string, BotMessage>();
        let counter = 0;
        let didFail = false;
        const fieldsById = new Map<string, BotMessageFields>();
        const progressIds = new Set<string>();
        const write = (content: string, id?: string, fields: BotMessageFields = { content }) =>
          Effect.gen(function* () {
            if (stopped) writesAfterStop += 1;
            const message = { id: id ?? String(++counter), content, author: { id: "bot" } };
            messages.set(message.id, message);
            fieldsById.set(message.id, fields);
            if (fields.actions?.some((action) => action.command === "stop"))
              progressIds.add(message.id);
            if (content.includes("Following up on the same run."))
              yield* Deferred.succeed(followUpProgress, undefined);
            if (content.includes("The follow-up is complete."))
              yield* Deferred.succeed(followUpFinal, content);
            if (content.includes("Additional final details"))
              yield* Deferred.succeed(grown, content);
            if (content.includes("Checking the current result.") && content.includes("_Working"))
              yield* Deferred.succeed(resumed, undefined);
            if (content.includes("Checking the current result."))
              yield* Deferred.succeed(progress, undefined);
            if (/working|starting/iu.test(content)) yield* Deferred.succeed(working, undefined);
            if (content.includes("It’s 19:50 CEST.") && content.includes("↑1.5k"))
              yield* Deferred.succeed(final, content);
            return message;
          });
        const adapter: BotResponseTransportService = {
          platform,
          config: { ...config, webUiBaseUrl: "https://example.com" },
          contentLimit: 2000,
          fileLimit: 10,
          uploadLimitBytes: failure === "upload" ? 60 : 10_000_000,
          normalizeContent: (text) => text.trim(),
          getMyUser: () => Effect.succeed({ id: "bot" }),
          getChannel: (id) =>
            Effect.succeed({
              id,
              type: 0,
              topic: failure === "same-run-follow-up" ? "" : "omegent-ips",
            }),
          updateChannel: () => Effect.void,
          getMessage: (_, id) => Effect.succeed(messages.get(id)!),
          listMessages: () => Effect.succeed([...messages.values()].reverse()),
          createMessage: (_, fields) =>
            Effect.gen(function* () {
              if (
                platform === "discord" &&
                failure === "final" &&
                !didFail &&
                fields.content.includes("It’s 19:50 CEST.")
              ) {
                didFail = true;
                expect(
                  [...messages.values()].some((message) =>
                    message.content.includes("Checking the current result."),
                  ),
                ).toBe(true);
                return yield* new BotTransportError({
                  cause: new Error("temporary final failure"),
                });
              }
              if (
                ["partial-final", "accepted-final"].includes(failure) &&
                !didFail &&
                fields.content.includes("substantial final")
              ) {
                didFail = true;
                if (failure === "accepted-final") yield* write(fields.content, undefined, fields);
                return yield* new BotTransportError({
                  cause: new Error("temporary final chunk failure"),
                });
              }
              return yield* write(fields.content, undefined, fields);
            }),
          updateMessage: (_, id, fields) =>
            Effect.gen(function* () {
              if (
                failure === "shutdown" &&
                fields.content.includes("Checking the current result.")
              ) {
                yield* Deferred.succeed(blockedWrite, undefined);
                yield* Deferred.await(releaseWrite);
              }
              if (
                !didFail &&
                ((["progress", "missing"].includes(failure) &&
                  fields.content.includes("Checking the current result.")) ||
                  (platform === "teams" &&
                    failure === "final" &&
                    fields.content.includes("It’s 19:50 CEST.")))
              ) {
                didFail = true;
                yield* Deferred.succeed(failed, undefined);
                if (failure === "missing") messages.delete(id);
                return yield* new BotTransportError({
                  ...(failure === "missing" ? { reason: "message-not-found" as const } : {}),
                  cause: new Error("temporary rate limit"),
                });
              }
              const message = yield* write(fields.content, id, fields);
              fieldsById.set(message.id, fields);
              if (fields.content.includes("Checking the current result."))
                yield* Deferred.succeed(progress, undefined);
              return message;
            }),
          deleteMessage: (_, id) =>
            Effect.sync(() => {
              messages.delete(id);
            }),
          createMessageWithFiles: (_, content, files) =>
            Effect.gen(function* () {
              if (
                failure === "upload" &&
                files.some((file) => file.name === "second.txt") &&
                !didFail
              ) {
                didFail = true;
                return yield* new BotTransportError({
                  cause: new Error("temporary upload failure"),
                });
              }
              return yield* write(content);
            }),
          upsertThreadInfo: (input) =>
            Deferred.succeed(info, input.modelSelection?.model ?? "").pipe(Effect.asVoid),
        };
        if (failure === "restart") {
          counter = 1;
          messages.set("1", { id: "1", content: "It’s 19:50 CEST.", author: { id: "bot" } });
        }
        let latest = failure === "restart" ? completed : running;
        const session = {
          fetchThreadDetail: () => Effect.succeed({ thread: latest, snapshotSequence: 1 }),
          getProjectShell: () => Effect.succeed(null),
          refreshVcsStatus: () => Effect.succeed(null),
          subscribeThread: (
            _id: Parameters<T3SessionService["subscribeThread"]>[0],
            onThread: Parameters<T3SessionService["subscribeThread"]>[1],
          ) =>
            Effect.gen(function* () {
              if (failure === "restart") {
                yield* onThread(completed);
                return yield* Effect.never;
              }
              yield* onThread(running);
              yield* Deferred.await(working);
              latest = fixture(false, true);
              yield* onThread(latest);
              if (failure === "progress" || failure === "missing") {
                yield* Deferred.await(failed);
              }
              yield* Deferred.await(progress);
              expect(messages.size).toBe(1);
              expect([...messages.values()][0]?.content).toContain("_Waiting..");
              expect([...messages.values()][0]?.content).not.toContain("earlier commentary");
              expect(fieldsById.get([...messages.keys()][0]!)?.actions?.[0]?.command).toBe("stop");
              latest = { ...latest, latestTurn: { ...latest.latestTurn!, runStatus: "running" } };
              yield* onThread(latest);
              yield* Deferred.await(resumed);
              expect([...messages.values()][0]?.content).toContain("_Working..");
              latest = completed;
              yield* onThread(completed);
              if (failure === "same-run-follow-up") {
                yield* Deferred.await(final);
                while (
                  !(yield* links.getByDiscordThreadId("conversation"))?.deliveryReceipt?.completed
                )
                  yield* Effect.sleep("1 millis");
                const firstReply = [...messages.values()].find((message) =>
                  message.content.includes("It’s 19:50 CEST."),
                )!;
                expect(progressIds.has(firstReply.id)).toBe(false);
                expect([...progressIds].some((id) => messages.has(id))).toBe(false);
                const followUp = {
                  ...completed.messages.at(-1)!,
                  id: MessageId.make("answer-2"),
                  text: "Following up on the same run.",
                  streaming: true,
                };
                latest = {
                  ...running,
                  messages: [...completed.messages, followUp],
                };
                yield* onThread(latest);
                yield* Deferred.await(followUpProgress);
                expect(messages.get(firstReply.id)?.content).toBe(firstReply.content);
                expect(messages.size).toBe(2);
                latest = {
                  ...completed,
                  latestTurn: { ...completed.latestTurn!, assistantMessageId: followUp.id },
                  messages: [
                    ...completed.messages,
                    {
                      ...followUp,
                      text: "The follow-up is complete.",
                      streaming: false,
                    },
                  ],
                };
                yield* onThread(latest);
              }
              if (failure === "late-final") {
                yield* Deferred.await(final);
                while (
                  !(yield* links.getByDiscordThreadId("conversation"))?.deliveryReceipt?.completed
                )
                  yield* Effect.sleep("1 millis");
                latest = {
                  ...completed,
                  messages: completed.messages.map((message) =>
                    message.id === "answer"
                      ? {
                          ...message,
                          text:
                            message.text +
                            " Additional final details prove that an already finalized message is updated in place.",
                        }
                      : message,
                  ),
                };
                yield* onThread(latest);
              }
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
        if (failure === "shutdown") {
          yield* Deferred.await(blockedWrite);
          yield* Fiber.interrupt(fiber).pipe(Effect.timeout("2 seconds"));
          stopped = true;
          yield* Deferred.succeed(releaseWrite, undefined);
          yield* Effect.sleep("5 millis");
          expect(writesAfterStop).toBe(0);
          return;
        }
        if (failure === "restart") {
          yield* Deferred.await(info);
          yield* Fiber.interrupt(fiber);
          expect(counter).toBe(1);
          expect([...messages.values()].map((message) => message.content)).toEqual([
            "It’s 19:50 CEST.",
          ]);
          return;
        }
        const answer = yield* Deferred.await(
          failure === "late-final"
            ? grown
            : failure === "same-run-follow-up"
              ? followUpFinal
              : final,
        );
        const finalAssistantId = failure === "same-run-follow-up" ? "answer-2" : "answer";
        yield* Effect.gen(function* () {
          while (true) {
            const link = yield* links.getByDiscordThreadId("conversation");
            if (
              link?.lastFinalizedAssistantId === finalAssistantId &&
              link.deliveryReceipt?.completed &&
              (failure !== "late-final" ||
                link.deliveryReceipt.text.includes("Additional final details"))
            )
              break;
            yield* Effect.sleep("1 millis");
          }
        }).pipe(Effect.timeout("5 seconds"));
        expect(messages.size).toBe(
          ["partial-final", "accepted-final", "upload"].includes(failure)
            ? 3
            : failure === "same-run-follow-up"
              ? 2
              : 1,
        );
        expect(counter).toBe(
          messages.size +
            (failure === "missing" ? 1 : 0) +
            (platform === "discord" ? (failure === "same-run-follow-up" ? 2 : 1) : 0),
        );
        expect(didFail).toBe(!["none", "late-final", "same-run-follow-up"].includes(failure));
        if (platform === "discord") {
          expect([...progressIds].some((id) => messages.has(id))).toBe(false);
          expect([...messages.keys()].every((id) => !progressIds.has(id))).toBe(true);
        }
        expect(
          [...messages.keys()].every(
            (id) => !fieldsById.get(id)?.actions?.some((action) => action.command === "stop"),
          ),
        ).toBe(true);
        expect(answer).not.toMatch(/working/iu);
        expect(answer).toContain("gpt-6.1-sol");
        expect(answer).toContain("effort medium");
        expect(answer).toContain("↑1.5k ↓250");
        expect(answer).toContain("https://example.com");
        expect(yield* Deferred.await(info)).toBe("gpt-6.1-sol");
        yield* Fiber.interrupt(fiber);
        const stored = yield* links.getByDiscordThreadId("conversation");
        expect(stored?.lastFinalizedAssistantId).toBe(finalAssistantId);
      }).pipe(Effect.scoped),
    15000,
  );
});
