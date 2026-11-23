// @effect-diagnostics nodeBuiltinImport:off unsafeEffectTypeAssertion:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import { DiscordBotConfig } from "../config.ts";
import { makeProjectAliasStore, ProjectAliasStore } from "../projectAliases.ts";
import { makeThreadLinkStore, ThreadLinkStore } from "../store/ThreadLinkStore.ts";
import { T3Session, type T3SessionService } from "../t3/T3Session.ts";
import { startOrContinueT3Turn } from "./LinkedTurnRouter.ts";

describe("Teams weekly thread join", () => {
  it.effect("links a new reply chain to the week's thread, and keeps old chains on theirs", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "teams-week-join-"))),
        (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
      );
      const config = yield* DiscordBotConfig.pipe(
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({}))),
      );
      const project = ProjectId.make("project:teams");
      const projects = new Map<string, ProjectId>([
        ["thread:week", project],
        ["thread:old-chain", project],
        ["thread:other-project", ProjectId.make("project:other")],
      ]);
      const continued: Array<string> = [];
      let launches = 0;
      const session = {
        findProjectByWorkspaceRoot: () =>
          Effect.succeed({
            id: project,
            workspaceRoot: "/workspace/omega",
            defaultModelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok" },
          }),
        resolveModelSelection: () =>
          Effect.succeed({ instanceId: ProviderInstanceId.make("grok"), model: "grok" }),
        fetchThreadDetail: (threadId: string) =>
          Effect.succeed(
            projects.has(threadId) ? { thread: { projectId: projects.get(threadId) } } : null,
          ),
        serverConfig: () =>
          Effect.succeed({ settings: DEFAULT_SERVER_SETTINGS, newProjectsRoot: "/projects" }),
        shell: () => Effect.succeed({ threads: [] }),
        startTurnWithWorktree: () =>
          Effect.sync(() => {
            launches += 1;
            return { threadId: ThreadId.make(`thread:new-${launches}`), messageId: "m:new" };
          }),
        startTurn: (input: Parameters<T3SessionService["startTurn"]>[0]) =>
          Effect.sync(() => {
            continued.push(input.threadId);
            return { messageId: `m:${continued.length}` };
          }),
      } as unknown as T3SessionService;

      const links = yield* makeThreadLinkStore(directory);
      const turn = (chain: string, joinT3ThreadId: string | undefined) =>
        startOrContinueT3Turn(config, {
          source: { sourceKind: "teams", sourceThreadId: `native/t/team/ch/${chain}` },
          joinT3ThreadId,
          externalConversationId: chain,
          externalParentId: "team/ch",
          externalTenantId: "t",
          projectShortName: "omega",
          prompt: "Investigate",
          promptContext: { kind: "raw", value: "Investigate" },
          flags: {},
          stickyModelOnContinue: true,
        }).pipe(
          Effect.provideService(
            ProjectAliasStore,
            makeProjectAliasStore([{ shortName: "omega", workspaceRoot: "/workspace/omega" }]),
          ),
          Effect.provideService(ThreadLinkStore, links),
          Effect.provideService(T3Session, session),
        );

      // A new top-level post joins the week's thread and gets its own link to it.
      expect(yield* turn("chain-b", "thread:week")).toMatchObject({
        threadId: "thread:week",
        isNew: false,
      });
      expect(
        (yield* links.getBySourceThread("teams", "native/t/team/ch/chain-b"))?.t3ThreadId,
      ).toBe("thread:week");
      expect((yield* links.getByDiscordThreadId("chain-b"))?.t3ThreadId).toBe("thread:week");

      // A reply chain that already has a thread stays on it, whatever the week's thread is.
      yield* links.put({
        sourceKind: "teams",
        sourceThreadId: "native/t/team/ch/chain-old",
        discordThreadId: "chain-old",
        t3ThreadId: ThreadId.make("thread:old-chain"),
        projectId: project,
        channelId: "team/ch",
        guildId: "t",
        createdAt: "2026-11-02T09:00:00.000Z",
      });
      expect((yield* turn("chain-old", "thread:week")).threadId).toBe("thread:old-chain");

      // A missing or foreign week thread falls back to opening a new one.
      expect(yield* turn("chain-c", "thread:gone")).toMatchObject({ isNew: true });
      expect(yield* turn("chain-d", "thread:other-project")).toMatchObject({ isNew: true });
      expect(continued).toEqual(["thread:week", "thread:old-chain"]);
    }).pipe(Effect.scoped),
  );
});
