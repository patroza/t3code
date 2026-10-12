// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { jiraBareKeyProjectsForWorkspaceRoots, __testing } from "./DiscordLinkedChannelTool.ts";

describe("jiraBareKeyProjectsForWorkspaceRoots", () => {
  it("reads prefixes for the matching host project", async () => {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-jira-prefixes-"));
    const aliasesPath = NodePath.join(dir, "aliases.yaml");
    await NodeFSP.writeFile(
      aliasesPath,
      [
        "skunkworks: /tmp/skunkworks",
        "macs-scanner:",
        "  workspaceRoot: /tmp/scanner",
        "  jiraProjects: SA",
        "macs-configurator:",
        "  workspaceRoot: /tmp/configurator",
        "  jiraProjects: CFG",
        "",
      ].join("\n"),
      "utf8",
    );
    expect(jiraBareKeyProjectsForWorkspaceRoots(["/tmp/scanner/"], aliasesPath)).toEqual(["SA"]);
    expect(
      jiraBareKeyProjectsForWorkspaceRoots(["/tmp/scanner", "/tmp/configurator"], aliasesPath),
    ).toEqual(["SA", "CFG"]);
    expect(jiraBareKeyProjectsForWorkspaceRoots(["/tmp/skunkworks"], aliasesPath)).toEqual([]);
    expect(jiraBareKeyProjectsForWorkspaceRoots(["/tmp/missing"], aliasesPath)).toEqual([]);
  });
});

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
  });
});

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
      shortName: "example-project",
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
