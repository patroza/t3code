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

import { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { v2Projection } from "../t3/nativeThreadTestFixtures.ts";
const sampleProjection = {
  ...v2Projection,
  thread: { ...v2Projection.thread, id: "thread-1" as never },
};

describe("parseWarmThreadCacheDocument / canResumeFromWarmThreadCache", () => {
  vitestIt("parses a valid document", () => {
    const entry = parseWarmThreadCacheDocument({
      version: 2,
      threadId: "thread-1",
      snapshotSequence: 42,
      lastFinalizedAssistantId: "a1",
      updatedAt: "2026-07-21T00:00:00.000Z",
      projection: Schema.encodeSync(Schema.toCodecJson(OrchestrationV2ThreadProjection))(
        sampleProjection,
      ),
    });
    expect(entry?.snapshotSequence).toBe(42);
    expect(entry?.projection.thread.title).toBe(sampleProjection.thread.title);
    expect(canResumeFromWarmThreadCache(entry)).toBe(true);
  });

  vitestIt("rejects corrupt payloads", () => {
    expect(parseWarmThreadCacheDocument(null)).toBeNull();
    expect(
      parseWarmThreadCacheDocument({
        version: 1,
        threadId: "thread-1",
        snapshotSequence: 42,
        lastFinalizedAssistantId: null,
        updatedAt: "2026-07-21T00:00:00.000Z",
        thread: { id: "thread-1", messages: [] },
      }),
    ).toBeNull();
    expect(parseWarmThreadCacheDocument({ version: 2, threadId: "x" })).toBeNull();
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
            projection: sampleProjection,
            lastFinalizedAssistantId: "a1",
          });
          const loaded = yield* store.load("thread-1");
          expect(loaded?.snapshotSequence).toBe(99);
          expect(loaded?.lastFinalizedAssistantId).toBe("a1");
          expect(loaded?.projection.thread.title).toBe(sampleProjection.thread.title);
          yield* store.remove("thread-1");
          expect(yield* store.load("thread-1")).toBeNull();
        }) as Effect.Effect<void, never, never>,
      );
    } finally {
      await NodeFSP.rm(dir, { recursive: true, force: true });
    }
  });
});
