// @effect-diagnostics nodeBuiltinImport:off
/* oxlint-disable t3code/no-manual-effect-runtime-in-tests -- Legacy filesystem fixture uses a manually scoped runtime. */
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import { describe, expect, it as vitestIt } from "vite-plus/test";

import {
  canResumeFromWarmThreadCache,
  makeThreadWarmCacheStore,
  parseWarmThreadCacheDocument,
} from "./ThreadWarmCacheStore.ts";

const sampleThread = {
  id: "thread-1",
  projectId: "project-1",
  title: "Warm cache",
  modelSelection: { instanceId: "grok", model: "grok-4.5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: "2026-07-21T00:00:00.000Z",
  updatedAt: "2026-07-21T00:00:00.000Z",
  archivedAt: null,
  deletedAt: null,
  messages: [
    {
      id: "a1",
      role: "assistant",
      text: "hello",
      turnId: null,
      streaming: false,
      createdAt: "2026-07-21T00:00:00.000Z",
      updatedAt: "2026-07-21T00:00:00.000Z",
    },
  ],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: null,
};

describe("parseWarmThreadCacheDocument / canResumeFromWarmThreadCache", () => {
  vitestIt("parses a valid document", () => {
    const entry = parseWarmThreadCacheDocument({
      version: 1,
      threadId: "thread-1",
      snapshotSequence: 42,
      lastFinalizedAssistantId: "a1",
      updatedAt: "2026-07-21T00:00:00.000Z",
      thread: sampleThread,
    });
    expect(entry?.snapshotSequence).toBe(42);
    expect(entry?.thread.messages).toHaveLength(1);
    expect(canResumeFromWarmThreadCache(entry)).toBe(true);
  });

  vitestIt("rejects corrupt payloads", () => {
    expect(parseWarmThreadCacheDocument(null)).toBeNull();
    expect(parseWarmThreadCacheDocument({ version: 1, threadId: "x" })).toBeNull();
    expect(canResumeFromWarmThreadCache(null)).toBe(false);
  });
});

describe("makeThreadWarmCacheStore", () => {
  vitestIt("round-trips save / load / remove", async () => {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-bot-warm-"));
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* makeThreadWarmCacheStore(dir);
          expect(yield* store.load("thread-1")).toBeNull();
          yield* store.save({
            threadId: "thread-1",
            snapshotSequence: 99,
            thread: sampleThread as never,
            lastFinalizedAssistantId: "a1",
          });
          const loaded = yield* store.load("thread-1");
          expect(loaded?.snapshotSequence).toBe(99);
          expect(loaded?.lastFinalizedAssistantId).toBe("a1");
          expect(loaded?.thread.messages[0]?.id).toBe("a1");
          yield* store.remove("thread-1");
          expect(yield* store.load("thread-1")).toBeNull();
        }) as Effect.Effect<void, never, never>,
      );
    } finally {
      await NodeFSP.rm(dir, { recursive: true, force: true });
    }
  });
});
