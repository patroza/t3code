// @effect-diagnostics nodeBuiltinImport:off anyUnknownInErrorContext:off missingEffectError:off missingEffectContext:off
/* oxlint-disable t3code/no-manual-effect-runtime-in-tests -- Legacy filesystem fixture uses a manually scoped runtime. */
import type { ProjectId, ThreadId } from "@t3tools/contracts";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { ProjectId as ProjectIdBrand, ThreadId as ThreadIdBrand } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, expect, it as vitestIt } from "vite-plus/test";

import {
  LINKS_DOCUMENT_VERSION,
  makeThreadLinkStore,
  migrateV1Link,
  normalizeThreadLinkInput,
  parseLinksDocument,
  type ThreadLinkInput,
  type ThreadLinkStoreService,
} from "./ThreadLinkStore.ts";

const makeTempDir = Effect.acquireRelease(
  Effect.tryPromise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "thread-link-store-"))),
  (dir) => Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true })),
);

const sampleV1 = {
  discordThreadId: "d-1",
  t3ThreadId: "t-1",
  projectId: "p-1",
  channelId: "c-1",
  guildId: "g-1",
  createdAt: "2026-01-01T00:00:00.000Z",
};

function input(overrides: Partial<ThreadLinkInput> = {}): ThreadLinkInput {
  return {
    discordThreadId: "d-1",
    t3ThreadId: "t-1" as ThreadId,
    projectId: "p-1" as ProjectId,
    channelId: "c-1",
    guildId: "g-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

async function withStore<A>(
  body: (store: ThreadLinkStoreService) => Effect.Effect<A, never, never>,
): Promise<A> {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-bot-links-"));
  try {
    return await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* makeThreadLinkStore(dir);
        return yield* body(store);
      }) as Effect.Effect<A, never, never>,
    );
  } finally {
    await NodeFSP.rm(dir, { recursive: true, force: true });
  }
}

describe("migrateV1Link / parseLinksDocument", () => {
  vitestIt("migrates v1 fields to v2 defaults", () => {
    const migrated = migrateV1Link(sampleV1);
    expect(migrated).toEqual({
      ...sampleV1,
      t3ThreadId: "t-1",
      projectId: "p-1",
      updatedAt: sampleV1.createdAt,
      lastActivityAt: sampleV1.createdAt,
      status: "active",
      lastSeenTurnId: null,
      lastFinalizedAssistantId: null,
      lastThreadSnapshotSequence: null,
      lastDeliveredSequence: null,
      threadTalkMode: undefined,
      taskDiscordMessageId: undefined,
      streamDiscordMessageIds: undefined,
      sentDiscordUserMessageIds: undefined,
      jiraIssueKeys: undefined,
      prUrls: undefined,
      infoDiscordMessageId: undefined,
      initialModelLine: undefined,
      currentModelLine: undefined,
      modelSinceAt: undefined,
    });
  });

  vitestIt("parses bare v1 array as migrated v2", () => {
    const parsed = parseLinksDocument([sampleV1]);
    expect(parsed.migratedFromV1).toBe(true);
    expect(parsed.version).toBe(LINKS_DOCUMENT_VERSION);
    expect(parsed.links).toHaveLength(1);
    expect(parsed.links[0]?.lastActivityAt).toBe(sampleV1.createdAt);
    expect(parsed.links[0]?.status).toBe("active");
    expect(parsed.links[0]?.streamDiscordMessageIds).toBeUndefined();
  });

  vitestIt("parses versioned v2 document", () => {
    const link = normalizeThreadLinkInput(input());
    const parsed = parseLinksDocument({ version: 2, links: [link] });
    expect(parsed.migratedFromV1).toBe(false);
    expect(parsed.links[0]).toEqual(link);
  });

  vitestIt("returns empty list for corrupt payload", () => {
    expect(parseLinksDocument(null).links).toEqual([]);
    expect(parseLinksDocument("nope").links).toEqual([]);
    expect(parseLinksDocument({ version: 2, links: "bad" }).links).toEqual([]);
  });

  vitestIt("preserves stream tip ids when migrating v1 with extras", () => {
    const parsed = parseLinksDocument([
      {
        ...sampleV1,
        streamDiscordMessageIds: ["s1", "s2"],
        taskDiscordMessageId: "task-1",
      },
    ]);
    expect(parsed.links[0]?.streamDiscordMessageIds).toEqual(["s1", "s2"]);
    expect(parsed.links[0]?.taskDiscordMessageId).toBe("task-1");
  });
});

describe("normalizeThreadLinkInput", () => {
  vitestIt("fills durable defaults for optional bridge fields", () => {
    const link = normalizeThreadLinkInput(input());
    expect(link.updatedAt).toBe(link.createdAt);
    expect(link.lastActivityAt).toBe(link.createdAt);
    expect(link.status).toBe("active");
    expect(link.lastSeenTurnId).toBeNull();
    expect(link.lastFinalizedAssistantId).toBeNull();
  });
});

describe("makeThreadLinkStore", () => {
  vitestIt("put / getByDiscordThreadId / getByT3ThreadId / list", async () => {
    await withStore((store) =>
      Effect.gen(function* () {
        yield* store.put(input());
        const byDiscord = yield* store.getByDiscordThreadId("d-1");
        const byT3 = yield* store.getByT3ThreadId("t-1");
        const missing = yield* store.getByDiscordThreadId("missing");
        const all = yield* store.list();

        expect(byDiscord?.t3ThreadId).toBe("t-1");
        expect(byT3?.discordThreadId).toBe("d-1");
        expect(missing).toBeNull();
        expect(all).toHaveLength(1);
      }),
    );
  });

  vitestIt("touch updates lastActivityAt and updatedAt", async () => {
    await withStore((store) =>
      Effect.gen(function* () {
        yield* store.put(input());
        const touched = yield* store.touch("d-1", "2026-06-01T12:00:00.000Z");
        expect(touched?.lastActivityAt).toBe("2026-06-01T12:00:00.000Z");
        expect(touched?.updatedAt).toBe("2026-06-01T12:00:00.000Z");
      }),
    );
  });

  vitestIt("tombstone marks link inactive", async () => {
    await withStore((store) =>
      Effect.gen(function* () {
        yield* store.put(input());
        const tombstoned = yield* store.tombstone("d-1");
        expect(tombstoned?.status).toBe("tombstone");
      }),
    );
  });

  vitestIt("updateBridgeHints persists finalize + stream tip ids", async () => {
    await withStore((store) =>
      Effect.gen(function* () {
        yield* store.put(input());
        yield* store.updateBridgeHints("d-1", {
          lastFinalizedAssistantId: "asst-1",
          streamDiscordMessageIds: ["s1", "s1", ""],
        });
        const link = yield* store.getByDiscordThreadId("d-1");
        expect(link?.lastFinalizedAssistantId).toBe("asst-1");
        expect(link?.streamDiscordMessageIds).toEqual(["s1"]);

        yield* store.updateBridgeHints("d-1", { streamDiscordMessageIds: [] });
        const cleared = yield* store.getByDiscordThreadId("d-1");
        expect(cleared?.streamDiscordMessageIds).toBeUndefined();
        expect(cleared?.lastFinalizedAssistantId).toBe("asst-1");
      }),
    );
  });

  vitestIt("partial bridge hint writes do not wipe sequence or stream markers", async () => {
    await withStore((store) =>
      Effect.gen(function* () {
        yield* store.put(input());
        yield* store.updateBridgeHints("d-1", {
          lastThreadSnapshotSequence: 42,
          lastDeliveredSequence: 40,
          streamDiscordMessageIds: ["tip-1"],
        });
        // Sequence-only update must keep stream tip ids + delivery cursor.
        yield* store.updateBridgeHints("d-1", { lastThreadSnapshotSequence: 99 });
        const afterSeq = yield* store.getByDiscordThreadId("d-1");
        expect(afterSeq?.lastThreadSnapshotSequence).toBe(99);
        expect(afterSeq?.lastDeliveredSequence).toBe(40);
        expect(afterSeq?.streamDiscordMessageIds).toEqual(["tip-1"]);

        // Delivery cursor-only update must keep orchestration sequence.
        yield* store.updateBridgeHints("d-1", { lastDeliveredSequence: 99 });
        const afterDelivered = yield* store.getByDiscordThreadId("d-1");
        expect(afterDelivered?.lastDeliveredSequence).toBe(99);
        expect(afterDelivered?.lastThreadSnapshotSequence).toBe(99);

        // Stream-only update must keep both sequence cursors.
        yield* store.setStreamDiscordMessageIds("d-1", ["tip-2"]);
        const afterStream = yield* store.getByDiscordThreadId("d-1");
        expect(afterStream?.streamDiscordMessageIds).toEqual(["tip-2"]);
        expect(afterStream?.lastThreadSnapshotSequence).toBe(99);
        expect(afterStream?.lastDeliveredSequence).toBe(99);

        // Minimal put must preserve durable dual-cursor + tip hints.
        yield* store.put(input());
        const afterPut = yield* store.getByDiscordThreadId("d-1");
        expect(afterPut?.lastThreadSnapshotSequence).toBe(99);
        expect(afterPut?.lastDeliveredSequence).toBe(99);
        expect(afterPut?.streamDiscordMessageIds).toEqual(["tip-2"]);
      }),
    );
  });
});

it.effect("persists the task message id for later bridge restarts", () =>
  Effect.gen(function* () {
    const dataDir = yield* makeTempDir;
    const store = yield* makeThreadLinkStore(dataDir);

    yield* store.put({
      discordThreadId: "discord-thread-1",
      t3ThreadId: ThreadIdBrand.make("thread-1"),
      projectId: ProjectIdBrand.make("project-1"),
      channelId: "channel-1",
      guildId: "guild-1",
      createdAt: "2026-07-18T00:00:00.000Z",
    });
    yield* store.setTaskDiscordMessageId("discord-thread-1", "task-message-1");

    const reloaded = yield* makeThreadLinkStore(dataDir);
    const link = yield* reloaded.getByDiscordThreadId("discord-thread-1");

    assert.strictEqual(link?.taskDiscordMessageId, "task-message-1");
    assert.strictEqual(link?.status, "active");
    assert.strictEqual(link?.lastActivityAt, "2026-07-18T00:00:00.000Z");
  }),
);

it.effect("persists jira keys in first-seen order and info message id", () =>
  Effect.gen(function* () {
    const dataDir = yield* makeTempDir;
    const store = yield* makeThreadLinkStore(dataDir);

    yield* store.put({
      discordThreadId: "discord-thread-1",
      t3ThreadId: ThreadIdBrand.make("thread-1"),
      projectId: ProjectIdBrand.make("project-1"),
      channelId: "channel-1",
      guildId: "guild-1",
      createdAt: "2026-07-18T00:00:00.000Z",
    });
    yield* store.appendJiraIssueKeys("discord-thread-1", ["PROJ-2", "PROJ-1"]);
    yield* store.appendJiraIssueKeys("discord-thread-1", ["PROJ-1", "PROJ-3"]);
    yield* store.setInfoDiscordMessageId("discord-thread-1", "info-msg-1");

    // Minimal put must preserve durable jira + info hints.
    yield* store.put({
      discordThreadId: "discord-thread-1",
      t3ThreadId: ThreadIdBrand.make("thread-1"),
      projectId: ProjectIdBrand.make("project-1"),
      channelId: "channel-1",
      guildId: "guild-1",
      createdAt: "2026-07-18T00:00:00.000Z",
    });

    const reloaded = yield* makeThreadLinkStore(dataDir);
    const link = yield* reloaded.getByDiscordThreadId("discord-thread-1");
    assert.deepStrictEqual(link?.jiraIssueKeys, ["PROJ-2", "PROJ-1", "PROJ-3"]);
    assert.strictEqual(link?.infoDiscordMessageId, "info-msg-1");
  }),
);

it.effect("persists PR urls in first-seen order across reloads and minimal puts", () =>
  Effect.gen(function* () {
    const dataDir = yield* makeTempDir;
    const store = yield* makeThreadLinkStore(dataDir);

    yield* store.put({
      discordThreadId: "discord-thread-1",
      t3ThreadId: ThreadIdBrand.make("thread-1"),
      projectId: ProjectIdBrand.make("project-1"),
      channelId: "channel-1",
      guildId: "guild-1",
      createdAt: "2026-07-18T00:00:00.000Z",
    });
    yield* store.appendPrUrls("discord-thread-1", [
      "https://github.com/acme/widgets/pull/42",
      "https://github.com/acme/widgets/pull/7/files",
    ]);
    yield* store.appendPrUrls("discord-thread-1", [
      "https://github.com/acme/widgets/pull/42",
      "https://github.com/example-org/scanner/pull/1950",
    ]);

    // Minimal put must preserve durable PR urls.
    yield* store.put({
      discordThreadId: "discord-thread-1",
      t3ThreadId: ThreadIdBrand.make("thread-1"),
      projectId: ProjectIdBrand.make("project-1"),
      channelId: "channel-1",
      guildId: "guild-1",
      createdAt: "2026-07-18T00:00:00.000Z",
    });

    const reloaded = yield* makeThreadLinkStore(dataDir);
    const link = yield* reloaded.getByDiscordThreadId("discord-thread-1");
    assert.deepStrictEqual(link?.prUrls, [
      "https://github.com/acme/widgets/pull/42",
      "https://github.com/acme/widgets/pull/7",
      "https://github.com/example-org/scanner/pull/1950",
    ]);
  }),
);

it.effect("persists model history for thread info pin", () =>
  Effect.gen(function* () {
    const dataDir = yield* makeTempDir;
    const store = yield* makeThreadLinkStore(dataDir);

    yield* store.put({
      discordThreadId: "discord-thread-1",
      t3ThreadId: ThreadIdBrand.make("thread-1"),
      projectId: ProjectIdBrand.make("project-1"),
      channelId: "channel-1",
      guildId: "guild-1",
      createdAt: "2026-07-18T00:00:00.000Z",
    });
    yield* store.setModelHistory("discord-thread-1", {
      initialModelLine: "codex/gpt-5.4",
      currentModelLine: "grok/grok-4.5",
      modelSinceAt: "2026-07-20T08:05:00.000Z",
    });

    const reloaded = yield* makeThreadLinkStore(dataDir);
    const link = yield* reloaded.getByDiscordThreadId("discord-thread-1");
    assert.strictEqual(link?.initialModelLine, "codex/gpt-5.4");
    assert.strictEqual(link?.currentModelLine, "grok/grok-4.5");
    assert.strictEqual(link?.modelSinceAt, "2026-07-20T08:05:00.000Z");
  }),
);

it.effect("persists and clears stream message ids for bridge restart cleanup", () =>
  Effect.gen(function* () {
    const dataDir = yield* makeTempDir;
    const store = yield* makeThreadLinkStore(dataDir);

    yield* store.put({
      discordThreadId: "discord-thread-1",
      t3ThreadId: ThreadIdBrand.make("thread-1"),
      projectId: ProjectIdBrand.make("project-1"),
      channelId: "channel-1",
      guildId: "guild-1",
      createdAt: "2026-07-18T00:00:00.000Z",
    });
    yield* store.setStreamDiscordMessageIds("discord-thread-1", [
      "stream-1",
      "stream-2",
      "stream-1",
      "",
    ]);

    const reloaded = yield* makeThreadLinkStore(dataDir);
    const link = yield* reloaded.getByDiscordThreadId("discord-thread-1");

    assert.deepStrictEqual(link?.streamDiscordMessageIds, ["stream-1", "stream-2"]);

    yield* reloaded.setStreamDiscordMessageIds("discord-thread-1", []);
    const cleared = yield* (yield* makeThreadLinkStore(dataDir)).getByDiscordThreadId(
      "discord-thread-1",
    );

    assert.strictEqual(cleared?.streamDiscordMessageIds, undefined);
  }),
);

it.effect(
  "persists and clears Discord-originated user message ids for external echo suppression",
  () =>
    Effect.gen(function* () {
      const dataDir = yield* makeTempDir;
      const store = yield* makeThreadLinkStore(dataDir);

      yield* store.put({
        discordThreadId: "discord-thread-1",
        t3ThreadId: ThreadIdBrand.make("thread-1"),
        projectId: ProjectIdBrand.make("project-1"),
        channelId: "channel-1",
        guildId: "guild-1",
        createdAt: "2026-07-18T00:00:00.000Z",
      });
      yield* store.setSentDiscordUserMessageIds("discord-thread-1", [
        "user-1",
        "user-2",
        "user-1",
        "",
      ]);

      const reloaded = yield* makeThreadLinkStore(dataDir);
      const link = yield* reloaded.getByDiscordThreadId("discord-thread-1");

      assert.deepStrictEqual(link?.sentDiscordUserMessageIds, ["user-1", "user-2"]);

      yield* reloaded.setSentDiscordUserMessageIds("discord-thread-1", []);
      const cleared = yield* (yield* makeThreadLinkStore(dataDir)).getByDiscordThreadId(
        "discord-thread-1",
      );

      assert.strictEqual(cleared?.sentDiscordUserMessageIds, undefined);
    }),
);

it.effect("persists and disables thread-talk mode", () =>
  Effect.gen(function* () {
    const dataDir = yield* makeTempDir;
    const store = yield* makeThreadLinkStore(dataDir);

    yield* store.put({
      discordThreadId: "discord-thread-1",
      t3ThreadId: ThreadIdBrand.make("thread-1"),
      projectId: ProjectIdBrand.make("project-1"),
      channelId: "channel-1",
      guildId: "guild-1",
      createdAt: "2026-07-18T00:00:00.000Z",
    });
    yield* store.setThreadTalkMode("discord-thread-1", "all-messages");

    const enabled = yield* (yield* makeThreadLinkStore(dataDir)).getByDiscordThreadId(
      "discord-thread-1",
    );
    assert.strictEqual(enabled?.threadTalkMode, "all-messages");
    assert.strictEqual(enabled?.sentDiscordUserMessageIds, undefined);

    yield* store.setThreadTalkMode("discord-thread-1", null);
    const disabled = yield* (yield* makeThreadLinkStore(dataDir)).getByDiscordThreadId(
      "discord-thread-1",
    );
    assert.strictEqual(disabled?.threadTalkMode, undefined);
    assert.strictEqual(disabled?.sentDiscordUserMessageIds, undefined);
  }),
);
