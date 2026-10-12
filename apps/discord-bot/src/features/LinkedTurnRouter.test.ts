// @effect-diagnostics nodeBuiltinImport:off unsafeEffectTypeAssertion:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { ClientSourceHint, ProjectId, ThreadId } from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import { DiscordBotConfig } from "../config.ts";
import { makeProjectAliasStore, ProjectAliasStore } from "../projectAliases.ts";
import { makeThreadLinkStore, ThreadLinkStore } from "../store/ThreadLinkStore.ts";
import { T3Session, type T3SessionService } from "../t3/T3Session.ts";
import { startOrContinueT3Turn } from "./LinkedTurnRouter.ts";

describe("Teams linked turn attribution", () => {
  it.effect("forwards the starter on launch and each later requester on continuation", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "teams-attribution-"))),
        (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
      );
      const dispatched: Array<ClientSourceHint | undefined> = [];
      const threadId = ThreadId.make("thread:teams-attribution");
      const session = {
        findProjectByWorkspaceRoot: () =>
          Effect.succeed({
            id: ProjectId.make("project:teams"),
            workspaceRoot: "/workspace/omega",
          }),
        resolveModelSelection: () => Effect.succeed({ instanceId: "codex", model: "test-model" }),
        startTurnWithWorktree: (input: Parameters<T3SessionService["startTurnWithWorktree"]>[0]) =>
          Effect.sync(() => {
            dispatched.push(input.sourceHint);
            return { threadId, messageId: "message:first" };
          }),
        startTurn: (input: Parameters<T3SessionService["startTurn"]>[0]) =>
          Effect.sync(() => {
            dispatched.push(input.sourceHint);
            return { messageId: "message:second" };
          }),
      } as unknown as T3SessionService;
      yield* Effect.gen(function* () {
        const config = yield* DiscordBotConfig.pipe(
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({}))),
        );
        const links = yield* makeThreadLinkStore(directory);
        const input = {
          source: {
            sourceKind: "teams" as const,
            sourceThreadId: "native/tenant/team/channel/root",
          },
          externalConversationId: "root",
          externalParentId: "team/channel",
          externalTenantId: "tenant",
          projectShortName: "omega",
          prompt: "Investigate",
          promptContext: { kind: "raw" as const, value: "Investigate" },
          flags: {},
          stickyModelOnContinue: true,
        };
        const dispatch = (platformId: string) =>
          startOrContinueT3Turn(config, {
            ...input,
            sourceActor: { platformId },
          }).pipe(
            Effect.provideService(
              ProjectAliasStore,
              makeProjectAliasStore([{ shortName: "omega", workspaceRoot: "/workspace/omega" }]),
            ),
            Effect.provideService(ThreadLinkStore, links),
            Effect.provideService(T3Session, session),
          );
        expect((yield* dispatch("starter-aad-id")).isNew).toBe(true);
        expect((yield* dispatch("second-aad-id")).isNew).toBe(false);
      });
      expect(dispatched).toEqual([
        {
          channel: "teams",
          actor: { platformId: "starter-aad-id" },
          location: { guildId: "tenant", channelId: "team/channel", threadId: "root" },
        },
        {
          channel: "teams",
          actor: { platformId: "second-aad-id" },
          location: { guildId: "tenant", channelId: "team/channel", threadId: "root" },
        },
      ]);
    }).pipe(Effect.scoped),
  );
});
