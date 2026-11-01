// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { __testing } from "./DiscordLinkedChannelTool.ts";

describe("extractEnvAssignment", () => {
  it("reads values from dotenv-like content", () => {
    expect(__testing.extractEnvAssignment("DISCORD_BOT_TOKEN=abc123\n", "DISCORD_BOT_TOKEN")).toBe(
      "abc123",
    );
    expect(__testing.extractEnvAssignment("OTHER=1\n", "DISCORD_BOT_TOKEN")).toBeUndefined();
  });
});

describe("parseTopicShortName", () => {
  it("prefers omegent-link- project tags and still reads legacy t3- tags", () => {
    expect(__testing.parseTopicShortName("ops omegent-link-example-project channel")).toBe(
      "example-project",
    );
    expect(__testing.parseTopicShortName("ops t3-example-project channel")).toBe("example-project");
    expect(__testing.parseTopicShortName("omegent-link-scanner t3-other")).toBe("scanner");
    expect(__testing.parseTopicShortName("omegent-example-project")).toBeNull();
    expect(__testing.parseTopicShortName("omegent-ips")).toBeNull();
    expect(__testing.parseTopicShortName("notes omegent-ips t3-example")).toBe("example");
    expect(__testing.parseTopicShortName("no tag")).toBeNull();
    expect(__testing.parseTopicShortName("omegent-link-github:acme/app")).toBeNull();
  });
});

const scannerRepo = { owner: "macs-holding", repo: "scanner" };

describe("pickLinkedDiscordChannel", () => {
  it("returns a unique linked channel match", () => {
    const result = __testing.pickLinkedDiscordChannel({
      guilds: [{ id: "guild-1", name: "Main" }],
      channelsByGuildId: new Map([
        [
          "guild-1",
          [
            { id: "chan-1", name: "scanner", type: 0, topic: "team t3-example-project" },
            { id: "chan-2", name: "other", type: 0, topic: "team t3-other" },
          ],
        ],
      ]),
      target: { shortName: "example-project", repositories: [] },
    });
    expect(result.match).toEqual({
      guildId: "guild-1",
      guildName: "Main",
      channelId: "chan-1",
      channelName: "scanner",
      shortName: "example-project",
      topic: "team t3-example-project",
    });
    expect(result.conflicts).toEqual([]);
  });

  it("prefers the GitHub tag over a different short-name channel", () => {
    const result = __testing.pickLinkedDiscordChannel({
      guilds: [{ id: "guild-1", name: "Main" }],
      channelsByGuildId: new Map([
        [
          "guild-1",
          [
            { id: "chan-short", name: "legacy", type: 0, topic: "omegent-link-scanner" },
            {
              id: "chan-github",
              name: "scanner",
              type: 0,
              topic: "omegent-link-github:Macs-Holding/Scanner omegent-link-other",
            },
          ],
        ],
      ]),
      target: { shortName: "scanner", repositories: [scannerRepo] },
    });
    expect(result.match?.channelId).toBe("chan-github");
    expect(result.match?.shortName).toBe("macs-holding/scanner");
    expect(result.conflicts).toEqual([]);
  });

  it("matches a GitHub tag when there is no alias short name", () => {
    const result = __testing.pickLinkedDiscordChannel({
      guilds: [{ id: "guild-1", name: "Main" }],
      channelsByGuildId: new Map([
        [
          "guild-1",
          [
            {
              id: "chan-github",
              name: "scanner",
              type: 0,
              topic: "omegent-link-github:macs-holding/scanner",
            },
          ],
        ],
      ]),
      target: { shortName: null, repositories: [scannerRepo] },
    });
    expect(result.match?.channelId).toBe("chan-github");
    expect(result.conflicts).toEqual([]);
  });

  it("reports two GitHub channels for the same repository", () => {
    const result = __testing.pickLinkedDiscordChannel({
      guilds: [{ id: "guild-1", name: "Main" }],
      channelsByGuildId: new Map([
        [
          "guild-1",
          [
            { id: "chan-a", name: "a", type: 0, topic: "omegent-link-github:macs-holding/scanner" },
            { id: "chan-b", name: "b", type: 0, topic: "omegent-link-github:macs-holding/scanner" },
            { id: "chan-short", name: "legacy", type: 0, topic: "omegent-link-scanner" },
          ],
        ],
      ]),
      target: { shortName: "scanner", repositories: [scannerRepo] },
    });
    expect(result.match).toBeNull();
    expect(result.conflicts.map((entry) => entry.channelId)).toEqual(["chan-a", "chan-b"]);
  });

  it("does not use a sibling short name when the GitHub tag is a different repository", () => {
    const result = __testing.pickLinkedDiscordChannel({
      guilds: [{ id: "guild-1", name: "Main" }],
      channelsByGuildId: new Map([
        [
          "guild-1",
          [
            {
              id: "chan-both",
              name: "both",
              type: 0,
              topic: "omegent-link-github:acme/other omegent-link-scanner",
            },
            { id: "chan-short", name: "legacy", type: 0, topic: "omegent-link-scanner" },
          ],
        ],
      ]),
      target: { shortName: "scanner", repositories: [scannerRepo] },
    });
    expect(result.match?.channelId).toBe("chan-short");
  });
});

describe("pickLinkedDiscordThreadId", () => {
  it("prefers the newest Discord thread linked to the active T3 thread", () => {
    expect(
      __testing.pickLinkedDiscordThreadId(
        [
          {
            discordThreadId: "discord-old",
            t3ThreadId: "t3-active",
            createdAt: "2026-07-17T10:00:00.000Z",
          },
          {
            discordThreadId: "discord-other",
            t3ThreadId: "t3-other",
            createdAt: "2026-07-18T10:00:00.000Z",
          },
          {
            discordThreadId: "discord-new",
            t3ThreadId: "t3-active",
            createdAt: "2026-07-18T10:00:00.000Z",
          },
        ],
        "t3-active",
      ),
    ).toBe("discord-new");
  });

  it("reads v2 links.json documents used by the Discord bot", () => {
    expect(
      __testing.pickLinkedDiscordThreadId(
        {
          version: 2,
          links: [
            {
              discordThreadId: "discord-v2",
              t3ThreadId: "t3-active",
              createdAt: "2026-09-04T07:00:00.000Z",
              status: "active",
            },
          ],
        },
        "t3-active",
      ),
    ).toBe("discord-v2");
  });

  it("skips tombstones and prefers recent activity on v2 documents", () => {
    expect(
      __testing.pickLinkedDiscordThreadId(
        {
          version: 2,
          links: [
            {
              discordThreadId: "discord-tombstone",
              t3ThreadId: "t3-active",
              createdAt: "2026-09-04T09:00:00.000Z",
              lastActivityAt: "2026-09-04T09:00:00.000Z",
              status: "tombstone",
            },
            {
              discordThreadId: "discord-older-active",
              t3ThreadId: "t3-active",
              createdAt: "2026-09-04T07:00:00.000Z",
              lastActivityAt: "2026-09-04T07:00:00.000Z",
              status: "active",
            },
            {
              discordThreadId: "discord-newer-active",
              t3ThreadId: "t3-active",
              createdAt: "2026-09-04T08:00:00.000Z",
              lastActivityAt: "2026-09-04T10:00:00.000Z",
              status: "active",
            },
          ],
        },
        "t3-active",
      ),
    ).toBe("discord-newer-active");
  });

  it("falls back when the active T3 thread has no Discord link", () => {
    expect(__testing.pickLinkedDiscordThreadId([], "t3-active")).toBeNull();
    expect(__testing.pickLinkedDiscordThreadId({ links: [] }, "t3-active")).toBeNull();
  });
});

describe("buildDiscordMultipartForm", () => {
  it("uploads files as File parts so Discord keeps the filename", () => {
    const form = __testing.buildDiscordMultipartForm({
      body: { content: "hi", allowed_mentions: { parse: [] } },
      files: [
        {
          filename: "note.md",
          spoiler: false,
          bytes: new TextEncoder().encode("# hi\n"),
        },
      ],
    });
    const part = form.get("files[0]");
    expect(part).toBeInstanceOf(File);
    expect((part as File).name).toBe("note.md");
    expect(form.get("payload_json")).toBe(
      JSON.stringify({ content: "hi", allowed_mentions: { parse: [] } }),
    );
  });
});

describe("pickActiveLinkedDiscordThreadId", () => {
  it("ignores a tombstone when that is the only link", () => {
    expect(
      __testing.pickActiveLinkedDiscordThreadId(
        {
          version: 2,
          links: [
            {
              discordThreadId: "discord-tombstone",
              t3ThreadId: "t3-active",
              createdAt: "2026-09-04T09:00:00.000Z",
              status: "tombstone",
            },
          ],
        },
        "t3-active",
      ),
    ).toBeNull();
  });

  it("prefers the newest active link and skips blank ids", () => {
    expect(
      __testing.pickActiveLinkedDiscordThreadId(
        {
          links: [
            {
              discordThreadId: "   ",
              t3ThreadId: "t3-active",
              lastActivityAt: "2026-09-04T12:00:00.000Z",
              status: "active",
            },
            {
              discordThreadId: "discord-older-active",
              t3ThreadId: "t3-active",
              lastActivityAt: "2026-09-04T07:00:00.000Z",
              status: "active",
            },
            {
              discordThreadId: "discord-newer-active",
              t3ThreadId: "t3-active",
              lastActivityAt: "2026-09-04T10:00:00.000Z",
              status: "active",
            },
          ],
        },
        "t3-active",
      ),
    ).toBe("discord-newer-active");
  });
});

describe("decideDiscordPost", () => {
  it("posts to a linked Discord thread even when unlinked posts are off", () => {
    expect(
      __testing.decideDiscordPost({
        linkedDiscordThreadId: " thread-1 ",
        unlinkedPostsEnabled: false,
      }),
    ).toEqual({ action: "post", discordThreadId: "thread-1" });
  });

  it("skips an unlinked T3 thread unless the flag is on", () => {
    expect(
      __testing.decideDiscordPost({
        linkedDiscordThreadId: null,
        unlinkedPostsEnabled: false,
      }),
    ).toEqual({ action: "skip", reason: "not-discord-linked" });
    expect(
      __testing.decideDiscordPost({
        linkedDiscordThreadId: "  ",
        unlinkedPostsEnabled: false,
      }),
    ).toEqual({ action: "skip", reason: "not-discord-linked" });
    expect(__testing.SKIPPED_NOT_DISCORD_LINKED_SUMMARY).toContain(
      "not linked to a Discord thread",
    );
    expect(__testing.SKIPPED_NOT_DISCORD_LINKED_SUMMARY).toContain(
      "T3_DISCORD_POST_UNLINKED_THREADS=1",
    );
  });

  it("opens a thread for an unlinked T3 thread only when the flag is on", () => {
    expect(
      __testing.decideDiscordPost({
        linkedDiscordThreadId: null,
        unlinkedPostsEnabled: true,
      }),
    ).toEqual({ action: "open-thread" });
    expect(
      __testing.decideDiscordPost({
        linkedDiscordThreadId: " \n ",
        unlinkedPostsEnabled: true,
      }),
    ).toEqual({ action: "open-thread" });
  });
});

describe("unlinkedDiscordPostsEnabledFrom", () => {
  const enabledFile = "T3_DISCORD_POST_UNLINKED_THREADS=yes\n";

  it("stays off when the flag is unset", () => {
    expect(__testing.unlinkedDiscordPostsEnabledFrom(undefined, null)).toBe(false);
    expect(__testing.unlinkedDiscordPostsEnabledFrom(undefined, "OTHER=1\n")).toBe(false);
  });

  it("accepts 1, true, yes, and on", () => {
    for (const value of ["1", "TRUE", "yes", "on"]) {
      expect(__testing.unlinkedDiscordPostsEnabledFrom(value, null)).toBe(true);
    }
  });

  it("lets an explicit process value override the env file", () => {
    expect(__testing.unlinkedDiscordPostsEnabledFrom("false", enabledFile)).toBe(false);
    expect(__testing.unlinkedDiscordPostsEnabledFrom("0", enabledFile)).toBe(false);
    expect(__testing.unlinkedDiscordPostsEnabledFrom("", enabledFile)).toBe(false);
  });

  it("reads an enabled env file only when the process value is unset", () => {
    expect(__testing.unlinkedDiscordPostsEnabledFrom(undefined, enabledFile)).toBe(true);
    expect(
      __testing.unlinkedDiscordPostsEnabledFrom(
        undefined,
        'T3_DISCORD_POST_UNLINKED_THREADS="yes"\n',
      ),
    ).toBe(true);
  });

  it("rejects any other value", () => {
    expect(__testing.unlinkedDiscordPostsEnabledFrom("maybe", null)).toBe(false);
    expect(
      __testing.unlinkedDiscordPostsEnabledFrom(
        undefined,
        "T3_DISCORD_POST_UNLINKED_THREADS=maybe\n",
      ),
    ).toBe(false);
  });
});

describe("discord public thread name", () => {
  it("collapses whitespace, truncates to 100 characters, and replaces a blank title", () => {
    expect(__testing.discordThreadNameFromTitle("  alfa \n shop  ")).toBe("alfa shop");
    expect(__testing.discordThreadNameFromTitle("   \n\t")).toBe("T3 thread");
    const longTitle = `x${"y".repeat(120)}`;
    expect(__testing.discordThreadNameFromTitle(longTitle)).toBe(longTitle.slice(0, 100));
    expect(Array.from(__testing.discordThreadNameFromTitle("🙂".repeat(150))).length).toBe(100);
  });

  it("builds a public thread body", () => {
    expect(__testing.buildDiscordPublicThreadBody("T3 thread")).toEqual({
      name: "T3 thread",
      type: 11,
      auto_archive_duration: 1440,
    });
  });

  it("refuses a create-thread response that is the parent channel", () => {
    expect(__testing.discordThreadIdFromCreateResponse({ id: "thread-9" }, "channel-1")).toBe(
      "thread-9",
    );
    expect(() =>
      __testing.discordThreadIdFromCreateResponse({ id: "channel-1" }, "channel-1"),
    ).toThrow(/top-level Discord channel message/);
    expect(() => __testing.discordThreadIdFromCreateResponse({ id: "  " }, "channel-1")).toThrow(
      /no thread id|top-level Discord channel message/,
    );
    expect(() =>
      __testing.discordThreadIdFromCreateResponse(
        { id: "thread-9", parent_id: "other-channel" },
        "channel-1",
      ),
    ).toThrow(/different channel/);
  });

  it("refuses to use the parent channel as the message destination", () => {
    expect(__testing.assertDiscordThreadDestination(" thread-1 ", "channel-1")).toBe("thread-1");
    expect(() => __testing.assertDiscordThreadDestination("channel-1", "channel-1")).toThrow(
      /top-level Discord channel message/,
    );
  });
});

describe("isUnknownDiscordChannel", () => {
  it("matches Discord's unknown-channel error and ignores other codes", () => {
    expect(
      __testing.isUnknownDiscordChannel(
        new Error(
          'Discord create message failed (404): {"message":"Unknown Channel","code":10003}',
        ),
      ),
    ).toBe(true);
    expect(
      __testing.isUnknownDiscordChannel(
        new Error('Discord create message failed (403): {"message":"Missing Access","code":50001}'),
      ),
    ).toBe(false);
    expect(
      __testing.isUnknownDiscordChannel(
        new Error(
          'Discord create message failed (403): {"message":"Unknown Channel","code":50001}',
        ),
      ),
    ).toBe(false);
    expect(__testing.isUnknownDiscordChannel(new Error("Unknown Channel"))).toBe(false);
    expect(
      __testing.isUnknownDiscordChannel(
        new Error(
          'Discord create message failed (404): {"message":"Unknown Channel","code":"10003"}',
        ),
      ),
    ).toBe(true);
  });
});

describe("discord post thread side store", () => {
  const older = {
    t3ThreadId: "t3-1",
    discordThreadId: "discord-old",
    channelId: "channel-old",
    guildId: "guild-1",
    name: "Older",
    createdAt: "2026-10-01T00:00:00.000Z",
  };
  const newer = {
    t3ThreadId: "t3-1",
    discordThreadId: "discord-new",
    channelId: "channel-new",
    guildId: "guild-1",
    name: "Newer",
    createdAt: "2026-10-02T00:00:00.000Z",
  };

  async function withTempDir<T>(run: (directory: string) => Promise<T>): Promise<T> {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "discord-post-threads-"));
    try {
      return await run(directory);
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  }

  it("round-trips and reuses the newest thread even when its channel changed", async () => {
    await withTempDir(async (directory) => {
      await __testing.writeDiscordPostThreadStore(directory, [older, newer]);
      const read = await __testing.readDiscordPostThreadStore(directory);
      expect(read).toEqual({ ok: true, threads: [older, newer] });
      if (!read.ok) return;
      expect(__testing.pickStoredDiscordPostThread(read.threads, "t3-1")).toEqual(newer);
      const sameTime = { ...older, discordThreadId: "discord-later", createdAt: newer.createdAt };
      expect(__testing.pickStoredDiscordPostThread([newer, sameTime], "t3-1")).toEqual(sameTime);
      expect(__testing.planStoredDiscordPostThread({ store: read, t3ThreadId: "t3-1" })).toEqual({
        action: "reuse",
        record: newer,
      });
      expect(
        __testing.planStoredDiscordPostThread({ store: read, t3ThreadId: "t3-missing" }),
      ).toEqual({ action: "create" });
    });
  });

  it("treats a missing or whitespace file as an empty map", async () => {
    await withTempDir(async (directory) => {
      expect(await __testing.readDiscordPostThreadStore(directory)).toEqual({
        ok: true,
        threads: [],
      });
      const file = NodePath.join(directory, "discord-post-threads.json");
      NodeFS.writeFileSync(file, "  \n");
      expect(await __testing.readDiscordPostThreadStore(directory)).toEqual({
        ok: true,
        threads: [],
      });
      expect(NodeFS.readFileSync(file, "utf8")).toBe("  \n");
    });
  });

  it("fails closed on a corrupt, unsupported, or invalid file and does not rewrite it", async () => {
    await withTempDir(async (directory) => {
      const file = NodePath.join(directory, "discord-post-threads.json");
      const cases = [
        { raw: "{", reason: "unreadable" },
        { raw: JSON.stringify({ version: 2, threads: [] }), reason: "unsupported" },
        {
          raw: JSON.stringify({
            version: 1,
            threads: [{ ...newer, discordThreadId: " " }],
          }),
          reason: "invalid entry",
        },
      ] as const;
      for (const entry of cases) {
        NodeFS.writeFileSync(file, entry.raw);
        const read = await __testing.readDiscordPostThreadStore(directory);
        expect(read).toEqual({ ok: false, reason: entry.reason });
        expect(NodeFS.readFileSync(file, "utf8")).toBe(entry.raw);
        expect(__testing.planStoredDiscordPostThread({ store: read, t3ThreadId: "t3-1" })).toEqual({
          action: "fail",
          reason: entry.reason,
        });
      }
    });
  });

  it("treats a non-missing read error as unreadable and does not open another thread", async () => {
    await withTempDir(async (directory) => {
      const file = NodePath.join(directory, "discord-post-threads.json");
      const raw = JSON.stringify({ version: 1, threads: [newer] });
      NodeFS.mkdirSync(file);
      const read = await __testing.readDiscordPostThreadStore(directory);
      expect(read).toEqual({ ok: false, reason: "unreadable" });
      expect(__testing.planStoredDiscordPostThread({ store: read, t3ThreadId: "t3-1" })).toEqual({
        action: "fail",
        reason: "unreadable",
      });
      expect(NodeFS.statSync(file).isDirectory()).toBe(true);

      if (typeof process.getuid === "function" && process.getuid() === 0) return;
      NodeFS.rmSync(file, { recursive: true, force: true });
      NodeFS.writeFileSync(file, raw);
      NodeFS.chmodSync(file, 0);
      try {
        const blocked = await __testing.readDiscordPostThreadStore(directory);
        expect(blocked).toEqual({ ok: false, reason: "unreadable" });
        expect(
          __testing.planStoredDiscordPostThread({ store: blocked, t3ThreadId: "t3-1" }),
        ).toEqual({ action: "fail", reason: "unreadable" });
      } finally {
        NodeFS.chmodSync(file, 0o644);
      }
      expect(NodeFS.readFileSync(file, "utf8")).toBe(raw);
    });
  });

  it("keeps a created thread only after the map row is saved", async () => {
    await withTempDir(async (directory) => {
      __testing.clearDiscordPostThreadMemory();
      const deleted: Array<string> = [];
      const record = { ...newer, t3ThreadId: "t3-saved", discordThreadId: "discord-saved" };
      try {
        await expect(
          __testing.saveCreatedDiscordPostThread({
            dataDir: directory,
            record,
            deleteThread: (discordThreadId) => {
              deleted.push(discordThreadId);
              return Promise.resolve();
            },
          }),
        ).resolves.toBe("discord-saved");
        expect(deleted).toEqual([]);
        expect(__testing.rememberedDiscordPostThreadId("t3-saved")).toBe("discord-saved");
        expect(await __testing.readDiscordPostThreadStore(directory)).toEqual({
          ok: true,
          threads: [record],
        });
      } finally {
        __testing.clearDiscordPostThreadMemory();
      }
    });
  });

  it("deletes a created thread and does not remember it when the map cannot be saved", async () => {
    await withTempDir(async (directory) => {
      const blocked = NodePath.join(directory, "not-a-directory");
      const raw = `${JSON.stringify({ version: 1, threads: [older, newer] }, null, 2)}\n`;
      NodeFS.writeFileSync(blocked, raw);
      const deleted: Array<string> = [];
      __testing.clearDiscordPostThreadMemory();
      try {
        await expect(
          __testing.saveCreatedDiscordPostThread({
            dataDir: blocked,
            record: { ...newer, t3ThreadId: "t3-created", discordThreadId: "discord-created" },
            deleteThread: (discordThreadId) => {
              deleted.push(discordThreadId);
              return Promise.resolve();
            },
          }),
        ).rejects.toThrow(/could not be saved; refusing to post/);
        expect(deleted).toEqual(["discord-created"]);
        expect(__testing.rememberedDiscordPostThreadId("t3-created")).toBeNull();
        expect(NodeFS.readFileSync(blocked, "utf8")).toBe(raw);

        deleted.length = 0;
        await expect(
          __testing.saveCreatedDiscordPostThread({
            dataDir: blocked,
            record: { ...newer, t3ThreadId: "t3-created", discordThreadId: "discord-created" },
            deleteThread: () => Promise.reject(new Error("delete failed")),
          }),
        ).rejects.toThrow(/deleting the new thread failed/);
        expect(__testing.rememberedDiscordPostThreadId("t3-created")).toBeNull();
        expect(NodeFS.readFileSync(blocked, "utf8")).toBe(raw);
      } finally {
        __testing.clearDiscordPostThreadMemory();
      }
    });
  });
});

describe("lookupActiveLinkedDiscordThread", () => {
  it("treats a missing links file as unlinked and any other read error as unreadable", async () => {
    expect(__testing.activeDiscordLinkFromFile({ status: "missing" }, "t3-1")).toEqual({
      status: "ready",
      discordThreadId: null,
    });
    expect(__testing.activeDiscordLinkFromFile({ status: "unreadable" }, "t3-1")).toEqual({
      status: "unreadable",
    });
    expect(__testing.activeDiscordLinkFromFile({ status: "ok", text: " \n" }, "t3-1")).toEqual({
      status: "ready",
      discordThreadId: null,
    });

    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "discord-links-"));
    const previous = process.env.T3_DISCORD_BOT_DATA_DIR;
    process.env.T3_DISCORD_BOT_DATA_DIR = directory;
    try {
      await expect(__testing.lookupActiveLinkedDiscordThread("t3-1")).resolves.toEqual({
        status: "ready",
        discordThreadId: null,
      });
      const file = NodePath.join(directory, "links.json");
      const raw = JSON.stringify({
        version: 2,
        links: [
          {
            discordThreadId: "discord-live",
            t3ThreadId: "t3-1",
            status: "active",
            createdAt: "2026-10-01T00:00:00.000Z",
          },
        ],
      });
      NodeFS.writeFileSync(file, raw);
      await expect(__testing.lookupActiveLinkedDiscordThread("t3-1")).resolves.toEqual({
        status: "ready",
        discordThreadId: "discord-live",
      });
      NodeFS.rmSync(file);
      NodeFS.mkdirSync(file);
      await expect(__testing.lookupActiveLinkedDiscordThread("t3-1")).resolves.toEqual({
        status: "unreadable",
      });
      expect(NodeFS.statSync(file).isDirectory()).toBe(true);
      if (typeof process.getuid !== "function" || process.getuid() !== 0) {
        NodeFS.rmSync(file, { recursive: true, force: true });
        NodeFS.writeFileSync(file, raw);
        NodeFS.chmodSync(file, 0);
        try {
          await expect(__testing.lookupActiveLinkedDiscordThread("t3-1")).resolves.toEqual({
            status: "unreadable",
          });
        } finally {
          NodeFS.chmodSync(file, 0o644);
        }
        expect(NodeFS.readFileSync(file, "utf8")).toBe(raw);
      }
    } finally {
      if (previous === undefined) delete process.env.T3_DISCORD_BOT_DATA_DIR;
      else process.env.T3_DISCORD_BOT_DATA_DIR = previous;
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });
});
