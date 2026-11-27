// @effect-diagnostics nodeBuiltinImport:off unsafeEffectTypeAssertion:off globalErrorInEffectFailure:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { it } from "@effect/vitest";
import { DiscordREST } from "dfx";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { describe, expect } from "vite-plus/test";

import { DiscordBotConfig } from "../config.ts";
import { makeProjectAliasStore, ProjectAliasStore } from "../projectAliases.ts";
import { makeThreadLinkStore, ThreadLinkStore } from "../store/ThreadLinkStore.ts";
import { T3Session, type T3SessionService } from "../t3/T3Session.ts";
import type { GroupChatRule } from "../teams/groupChats.ts";
import { parseOmegentLinkMarker } from "./linkMarker.ts";
import {
  ensureTeamsMirrorLink,
  groupChatPlaceholderThreadId,
  ingestTeamsGroupChat,
  type TeamsChannelPoster,
  type TeamsMirrorTurn,
} from "./TeamsGroupChatObserver.ts";

const rules: ReadonlyArray<GroupChatRule> = [
  {
    titleIncludes: "MAKO",
    projectShortName: "scanner",
    mirror: { tenantId: "tenant", teamId: "team", channelId: "19:mirror@thread.tacv2" },
  },
];

const message = (text: string) => ({
  event: "message" as const,
  tenantId: "tenant",
  conversationId: "19:chat@thread.v2",
  conversationType: "groupChat",
  title: "MAKO Scanner",
  text,
  messageId: "m1",
  author: "Frerk",
  fromBot: false,
  mentionedBot: false,
});

function makeHarness(
  chatRules: ReadonlyArray<GroupChatRule> = rules,
  base: { readonly title?: string | undefined } = {},
) {
  return Effect.gen(function* () {
    const directory = yield* Effect.acquireRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "group-chat-observer-"))),
      (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
    );
    const defaults = yield* DiscordBotConfig.pipe(
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({}))),
    );
    const config: DiscordBotConfig = {
      ...defaults,
      dataDir: directory,
      alertsChannelId: "900",
      webUiBaseUrl: "https://t3.test",
    };
    const links = yield* makeThreadLinkStore(directory);
    const calls = {
      t3Starts: 0,
      t3Continues: 0,
      discordThreads: 0,
      discordPosts: [] as Array<{ channelId: string; content: string }>,
      mirrorThreads: 0,
      mirrorReplies: [] as Array<string>,
      titles: [] as Array<string | undefined>,
      bridged: [] as Array<TeamsMirrorTurn>,
    };
    const state = { discordFails: false, mirrorFails: false, t3Fails: false, t3FailsOnce: false };
    const projectId = ProjectId.make("project:scanner");
    const session = {
      findProjectByWorkspaceRoot: () =>
        Effect.succeed({ id: projectId, workspaceRoot: "/workspace/scanner" }),
      resolveModelSelection: () =>
        Effect.succeed({ instanceId: ProviderInstanceId.make("codex"), model: "gpt" }),
      fetchThreadDetail: () => Effect.succeed({ thread: { projectId } }),
      serverConfig: () =>
        Effect.succeed({ settings: DEFAULT_SERVER_SETTINGS, newProjectsRoot: "/projects" }),
      shell: () => Effect.succeed({ threads: [] }),
      startTurnWithWorktree: (input: { readonly titleSeed?: string }) =>
        state.t3Fails || state.t3FailsOnce
          ? Effect.sync(() => {
              state.t3FailsOnce = false;
            }).pipe(Effect.andThen(Effect.fail(new Error("T3 down"))))
          : Effect.sync(() => {
              calls.t3Starts += 1;
              calls.titles.push(input.titleSeed);
              return { threadId: ThreadId.make("thread:weekly"), messageId: "message:1" };
            }),
      startTurn: () =>
        Effect.sync(() => {
          calls.t3Continues += 1;
          return { messageId: "message:n" };
        }),
    } as unknown as T3SessionService;
    let nextId = 1000;
    const rest = {
      createMessage: (channelId: string, body: { content: string }) =>
        state.discordFails
          ? Effect.fail(new Error("401: Unauthorized"))
          : Effect.sync(() => {
              calls.discordPosts.push({ channelId, content: body.content });
              return { id: String(nextId++) };
            }),
      createThreadFromMessage: () =>
        Effect.sync(() => {
          calls.discordThreads += 1;
          return { id: String(nextId++) };
        }),
    } as unknown as DiscordREST["Service"];
    const poster: TeamsChannelPoster = {
      openThread: async () => {
        if (state.mirrorFails) throw new Error("Teams 403");
        calls.mirrorThreads += 1;
        return { id: "19:mirror@thread.tacv2", activityId: "77" };
      },
      reply: async (_conversationId, text) => {
        if (state.mirrorFails) throw new Error("Teams 403");
        calls.mirrorReplies.push(text);
      },
    };
    const ingest = (text: string, withDiscord = true, t3Retries = 0) =>
      Effect.gen(function* () {
        const runtime = yield* Effect.context<never>();
        return yield* ingestTeamsGroupChat(
          config,
          chatRules,
          [],
          runtime,
          { ...message(text), ...base },
          poster,
          {
            t3RetrySchedule: Schedule.recurs(t3Retries),
            bridgeMirror: (turn) =>
              Effect.sync(() => {
                calls.bridged.push(turn);
              }),
          },
        );
      }).pipe(
        (effect) => (withDiscord ? Effect.provideService(effect, DiscordREST, rest) : effect),
        Effect.provideService(ThreadLinkStore, links),
        Effect.provideService(T3Session, session),
        Effect.provideService(
          ProjectAliasStore,
          makeProjectAliasStore([{ shortName: "scanner", workspaceRoot: "/workspace/scanner" }]),
        ),
      );
    const weeklyLink = Effect.gen(function* () {
      const all = yield* links.list();
      expect(all).toHaveLength(1);
      return all[0]!;
    });
    const ensureMirrorLink = (turn: TeamsMirrorTurn) =>
      ensureTeamsMirrorLink(turn).pipe(
        Effect.provideService(ThreadLinkStore, links),
        Effect.provideService(T3Session, session),
      );
    return { calls, state, ingest, links, weeklyLink, ensureMirrorLink };
  });
}

const markers = (posts: ReadonlyArray<{ content: string }>) =>
  posts.flatMap((post) => {
    const marker = parseOmegentLinkMarker(post.content);
    return marker === null ? [] : [marker];
  });

describe("Teams group chat observer failure isolation", () => {
  it.effect("retries a T3 turn that fails once instead of dropping the message", () =>
    Effect.gen(function* () {
      const { calls, state, ingest, weeklyLink } = yield* makeHarness();
      state.t3FailsOnce = true;
      yield* ingest("Paketnummern fehlen", true, 2);
      expect(calls.t3Starts).toBe(1);
      expect((yield* weeklyLink).t3ThreadId).toBe("thread:weekly");
    }).pipe(Effect.scoped),
  );

  it.effect("still copies to the Teams mirror and starts T3 when Discord fails", () =>
    Effect.gen(function* () {
      const { calls, state, ingest, weeklyLink } = yield* makeHarness();
      state.discordFails = true;
      expect(yield* ingest("Der Scanner bucht nicht.")).toEqual({ handled: true });
      expect(calls.mirrorThreads).toBe(1);
      expect(calls.mirrorReplies[0]).toContain("Der Scanner bucht nicht.");
      expect(calls.t3Starts).toBe(1);
      const link = yield* weeklyLink;
      expect(link.discordThreadId).toBe(groupChatPlaceholderThreadId(link.sourceThreadId!));
      // The Omegent link still reaches the new Teams mirror thread.
      expect(calls.mirrorReplies.at(-1)).toBe("https://t3.test/?thread=thread:weekly");
    }).pipe(Effect.scoped),
  );

  it.effect("still opens Discord and starts T3 when the Teams mirror fails", () =>
    Effect.gen(function* () {
      const { calls, state, ingest, weeklyLink } = yield* makeHarness();
      state.mirrorFails = true;
      yield* ingest("Der Scanner bucht nicht.");
      expect(calls.discordThreads).toBe(1);
      expect(calls.t3Starts).toBe(1);
      const link = yield* weeklyLink;
      expect(link.discordThreadId).toMatch(/^\d+$/u);
      expect(markers(calls.discordPosts)).toEqual([
        {
          t3ThreadId: "thread:weekly",
          projectShortName: "scanner",
          sourceKind: "teams",
          sourceThreadId: link.sourceThreadId,
        },
      ]);
      const markerPost = calls.discordPosts.find((post) => post.content.includes("omegent-link"));
      expect(markerPost?.channelId).toBe(link.discordThreadId);
      expect(markerPost?.content).toContain(
        "[Open in Omegent](https://t3.test/?thread=thread:weekly)",
      );
    }).pipe(Effect.scoped),
  );

  it.effect("opens one Discord thread and posts the marker once after Discord comes back", () =>
    Effect.gen(function* () {
      const { calls, ingest, weeklyLink } = yield* makeHarness();
      yield* ingest("Erste Meldung.", false);
      expect(calls.t3Starts).toBe(1);
      const placeholder = yield* weeklyLink;
      expect(placeholder.discordThreadId.startsWith("teams-group:")).toBe(true);

      yield* ingest("Zweite Meldung.");
      yield* ingest("Dritte Meldung.");
      expect(calls.discordThreads).toBe(1);
      expect(calls.t3Starts).toBe(1);
      expect(calls.t3Continues).toBe(2);
      expect(markers(calls.discordPosts)).toHaveLength(1);
      const live = yield* weeklyLink;
      expect(live.t3ThreadId).toBe(placeholder.t3ThreadId);
      expect(live.discordThreadId).toMatch(/^\d+$/u);
      expect(live.channelId).toBe("900");
      expect(calls.discordPosts.every((post) => /^\d+$/u.test(post.channelId))).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect("reuses the Discord thread when the first T3 turn failed", () =>
    Effect.gen(function* () {
      const { calls, state, ingest, weeklyLink } = yield* makeHarness();
      state.t3Fails = true;
      yield* ingest("Erste Meldung.");
      expect(calls.discordThreads).toBe(1);
      expect(calls.mirrorThreads).toBe(1);
      state.t3Fails = false;
      yield* ingest("Zweite Meldung.");
      expect(calls.discordThreads).toBe(1);
      expect(calls.mirrorThreads).toBe(1);
      expect(calls.t3Starts).toBe(1);
      const link = yield* weeklyLink;
      const observed = calls.discordPosts.filter((post) => post.content.startsWith("**Frerk:**"));
      expect(new Set(observed.map((post) => post.channelId))).toEqual(
        new Set([link.discordThreadId]),
      );
      expect(markers(calls.discordPosts)).toHaveLength(1);
    }).pipe(Effect.scoped),
  );
});

describe("Teams group chat mirror delivery", () => {
  it.effect("streams each weekly T3 turn into the Teams mirror thread", () =>
    Effect.gen(function* () {
      const { calls, ingest, weeklyLink } = yield* makeHarness();
      yield* ingest("Der Scanner bucht nicht.");
      yield* ingest("Immer noch nicht.");
      const link = yield* weeklyLink;
      expect(calls.bridged).toEqual([
        {
          mirror: rules[0]!.mirror,
          conversationId: "19:mirror@thread.tacv2;messageid=77",
          sourceKey: link.sourceThreadId,
          t3ThreadId: "thread:weekly",
          messageId: "message:1",
        },
        expect.objectContaining({
          conversationId: "19:mirror@thread.tacv2;messageid=77",
          t3ThreadId: "thread:weekly",
          messageId: "message:n",
        }),
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("does not stream when the chat has no mirror thread", () =>
    Effect.gen(function* () {
      const { calls, ingest } = yield* makeHarness([
        { titleIncludes: "MAKO", projectShortName: "scanner" },
      ]);
      yield* ingest("Der Scanner bucht nicht.");
      expect(calls.t3Starts).toBe(1);
      expect(calls.mirrorThreads).toBe(0);
      expect(calls.bridged).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "keeps one delivery link per mirror thread, whether a turn or a mention ensures it",
    () =>
      Effect.gen(function* () {
        const { calls, ingest, links, ensureMirrorLink } = yield* makeHarness();
        yield* ingest("Der Scanner bucht nicht.");
        const turn = calls.bridged[0]!;
        yield* ensureMirrorLink(turn);
        yield* links.setInfoDiscordMessageId(turn.conversationId, "info-card", "fingerprint");
        // A later mention in the mirror thread ensures the same conversation and T3 thread.
        yield* ensureMirrorLink(turn);
        const all = yield* links.list();
        expect(all).toHaveLength(2);
        const mirrorLink = yield* links.getByDiscordThreadId(turn.conversationId);
        expect(mirrorLink?.t3ThreadId).toBe("thread:weekly");
        expect(mirrorLink?.infoDiscordMessageId).toBe("info-card");
        // The weekly key still resolves to the Discord thread's link.
        const weekly = yield* links.getBySourceThread("teams", turn.sourceKey);
        expect(weekly?.discordThreadId).toMatch(/^\d+$/u);
      }).pipe(Effect.scoped),
  );
});

describe("Teams group chat names and channels", () => {
  it.effect("names the T3 thread after the chat and week, not the passive prompt", () =>
    Effect.gen(function* () {
      const { calls, ingest } = yield* makeHarness();
      yield* ingest("Der Scanner bucht nicht.");
      expect(calls.titles[0]).toMatch(/^Teams: MAKO Scanner · week \d{4}-\d{2}-\d{2}$/u);
    }).pipe(Effect.scoped),
  );

  it.effect("uses the rule's title and Discord channel when Teams sends no chat title", () =>
    Effect.gen(function* () {
      const { calls, ingest, weeklyLink } = yield* makeHarness(
        [
          {
            conversationId: "19:chat@thread.v2",
            projectShortName: "scanner",
            title: "Easy Life Scanner",
            discordChannelId: "1345512665602330664",
          },
        ],
        { title: undefined },
      );
      yield* ingest("Der Scanner bucht nicht.");
      expect(calls.discordPosts[0]).toMatchObject({ channelId: "1345512665602330664" });
      expect(calls.discordPosts[0]?.content).toContain("**Easy Life Scanner**");
      expect(calls.titles[0]).toMatch(/^Teams: Easy Life Scanner · week /u);
      expect((yield* weeklyLink).channelId).toBe("1345512665602330664");
    }).pipe(Effect.scoped),
  );
});
