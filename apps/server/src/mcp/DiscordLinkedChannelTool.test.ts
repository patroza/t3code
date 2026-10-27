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

describe("resolveDiscordPostDestination", () => {
  it("prefers a linked Discord thread over its parent channel", () => {
    expect(__testing.resolveDiscordPostDestination("channel-1", "thread-1")).toBe("thread-1");
  });

  it("uses the repository channel when no Discord thread is linked", () => {
    expect(__testing.resolveDiscordPostDestination("channel-1", null)).toBe("channel-1");
  });
});
