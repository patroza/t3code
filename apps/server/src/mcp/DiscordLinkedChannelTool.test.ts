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
  it("extracts t3 short names from channel topics", () => {
    expect(__testing.parseTopicShortName("ops t3-example-project channel")).toBe("example-project");
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

  it("falls back when the active T3 thread has no Discord link", () => {
    expect(__testing.pickLinkedDiscordThreadId([], "t3-active")).toBeNull();
    expect(__testing.pickLinkedDiscordThreadId({ links: [] }, "t3-active")).toBeNull();
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
