// @effect-diagnostics nodeBuiltinImport:off unsafeEffectTypeAssertion:off
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, expect, it as vitestIt } from "vite-plus/test";

import { makeThreadLinkStore, ThreadLinkStore } from "../store/ThreadLinkStore.ts";
import { T3Session, type T3SessionService } from "../t3/T3Session.ts";
import { BridgeHub, type BridgeEnsureInput, type BridgeHubService } from "./BridgeHub.ts";
import { adoptMarkedDiscordThread, findSelfLinkMarker } from "./LinkAdoption.ts";
import { formatOmegentLinkMarker } from "./linkMarker.ts";

const marker = {
  t3ThreadId: "thread:weekly",
  projectShortName: "scanner",
  sourceKind: "teams" as const,
  sourceThreadId: "native/t/group/19:chat@thread.v2/2026-W48",
};

describe("findSelfLinkMarker", () => {
  vitestIt("only trusts markers this bot posted", () => {
    const content = `Linked **scanner**\n${formatOmegentLinkMarker(marker)}`;
    expect(findSelfLinkMarker([{ author: { id: "someone" }, content }], "bot")).toBe(null);
    expect(
      findSelfLinkMarker(
        [{ author: { id: "bot" }, content: "hello" }, { author: { id: "bot" }, content }, null],
        "bot",
      ),
    ).toEqual(marker);
  });
});

describe("adoptMarkedDiscordThread", () => {
  it.effect("links the thread to the marker's T3 thread and bridges it once", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "link-adoption-"))),
        (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
      );
      const links = yield* makeThreadLinkStore(directory);
      const ensured: Array<BridgeEnsureInput> = [];
      const hub = {
        ensure: (input: BridgeEnsureInput) => Effect.sync(() => void ensured.push(input)),
      } as unknown as BridgeHubService;
      const session = {
        getThreadShell: (threadId: ThreadId) =>
          Effect.succeed(
            threadId === "thread:weekly"
              ? { id: threadId, projectId: ProjectId.make("project:scanner") }
              : null,
          ),
      } as unknown as T3SessionService;
      const adopt = (t3ThreadId: string) =>
        adoptMarkedDiscordThread({
          discordThreadId: "1001",
          parentChannelId: "900",
          guildId: "guild",
          marker: { ...marker, t3ThreadId },
        }).pipe(
          Effect.provideService(ThreadLinkStore, links),
          Effect.provideService(T3Session, session),
          Effect.provideService(BridgeHub, hub),
        );

      expect(yield* adopt("thread:missing")).toBe(null);
      expect(yield* links.list()).toEqual([]);

      const adopted = yield* adopt("thread:weekly");
      expect(adopted).toMatchObject({
        discordThreadId: "1001",
        t3ThreadId: ThreadId.make("thread:weekly"),
        projectId: "project:scanner",
        channelId: "900",
        guildId: "guild",
        sourceKind: "teams",
        sourceThreadId: marker.sourceThreadId,
        status: "active",
      });
      expect(ensured).toMatchObject([
        {
          discordChannelId: "1001",
          t3ThreadId: "thread:weekly",
          mode: "rehydrate",
          preferred: true,
        },
      ]);

      // A second sighting (MESSAGE_CREATE + history scan) keeps the link and does not re-bridge.
      expect((yield* adopt("thread:weekly"))?.t3ThreadId).toBe("thread:weekly");
      expect(ensured).toHaveLength(1);
    }).pipe(Effect.scoped),
  );
});

describe("MentionRouter link adoption wiring", () => {
  const source = NodeFS.readFileSync(new URL("./MentionRouter.ts", import.meta.url), "utf8");

  vitestIt("adopts from its own marker message before bot messages are dropped", () => {
    const adoptAt = source.indexOf("parseOmegentLinkMarker(event.content");
    const dropAt = source.indexOf(
      "event.author?.bot === true ||\n      event.author?.id === botUserId",
    );
    expect(adoptAt).toBeGreaterThan(-1);
    expect(dropAt).toBeGreaterThan(adoptAt);
    const selfAt = source.indexOf('source === "create" && event.author?.id === botUserId');
    expect(selfAt).toBeGreaterThan(-1);
    expect(selfAt).toBeLessThan(adoptAt);
  });

  vitestIt("continues the marker's T3 thread before the new-thread path", () => {
    const start = source.indexOf("const startBridgedTurnUnlocked =");
    const body = source.slice(start);
    const adoptAt = body.indexOf("(yield* adoptThreadFromHistory(input))");
    expect(adoptAt).toBeGreaterThan(-1);
    expect(adoptAt).toBeLessThan(
      body.indexOf("discordThreadHasPendingNewThreadOffer(input.discordThreadId)"),
    );
    expect(adoptAt).toBeLessThan(body.indexOf("t3.startTurnWithWorktree("));
  });
});
