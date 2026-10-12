// @effect-diagnostics nodeBuiltinImport:off globalPromise:off tryCatchInEffectGen:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { it } from "@effect/vitest";
import { expect, vi } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { makeThreadLinkStore } from "./ThreadLinkStore.ts";
import { makeThreadWarmCacheStore } from "./ThreadWarmCacheStore.ts";
import { v2Projection } from "../t3/nativeThreadTestFixtures.ts";

const renameGate = vi.hoisted(() => ({
  before: undefined as undefined | (() => Promise<void>),
  after: undefined as undefined | (() => void),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      await renameGate.before?.();
      try {
        return await actual.rename(...args);
      } finally {
        renameGate.after?.();
      }
    },
  };
});

it.live.each(["links", "warm-cache"] as const)(
  "%s interruption awaits an in-flight atomic write before releasing storage",
  (kind) =>
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "chat-store-stop-"))),
        (directory) =>
          Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
      );
      const links = yield* makeThreadLinkStore(directory);
      const warm = yield* makeThreadWarmCacheStore(directory);
      yield* links.put({
        discordThreadId: "conversation",
        t3ThreadId: v2Projection.thread.id,
        projectId: v2Projection.thread.projectId,
        channelId: "channel",
        guildId: "team",
        createdAt: "2026-10-12T00:00:00.000Z",
      });
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const renamed = Promise.withResolvers<void>();
      renameGate.before = () => {
        started.resolve();
        return release.promise;
      };
      renameGate.after = () => renamed.resolve();
      try {
        const write =
          kind === "links"
            ? links.updateBridgeHints("conversation", { lastFinalizedAssistantId: "answer" })
            : warm.save({
                threadId: v2Projection.thread.id,
                snapshotSequence: 2,
                projection: v2Projection,
              });
        const writer = yield* write.pipe(Effect.forkChild);
        yield* Effect.promise(() => started.promise);
        const interrupted = yield* Deferred.make<void>();
        yield* Fiber.interrupt(writer).pipe(
          Effect.andThen(Deferred.succeed(interrupted, undefined)),
          Effect.forkChild,
        );
        yield* Effect.sleep("10 millis");
        expect(yield* Deferred.isDone(interrupted)).toBe(false);
        release.resolve();
        yield* Deferred.await(interrupted);
        if (kind === "links") {
          const restored = yield* makeThreadLinkStore(directory);
          expect(
            (yield* restored.getByDiscordThreadId("conversation"))?.lastFinalizedAssistantId,
          ).toBe("answer");
        } else {
          expect((yield* warm.load(v2Projection.thread.id))?.snapshotSequence).toBe(2);
        }
      } finally {
        release.resolve();
        yield* Effect.promise(() => renamed.promise);
        renameGate.before = undefined;
        renameGate.after = undefined;
      }
    }).pipe(Effect.scoped),
);
