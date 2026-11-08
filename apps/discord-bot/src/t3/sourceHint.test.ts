import { describe, expect, it } from "vite-plus/test";

import { discordSourceHint } from "./sourceHint.ts";

describe("discordSourceHint", () => {
  it("builds a discord hint with actor + location for map resolution", () => {
    expect(
      discordSourceHint({
        authorId: "95218063095377920",
        authorUsername: "patroza",
        guildId: "guild-1",
        channelId: "channel-1",
        discordThreadId: "thread-1",
      }),
    ).toEqual({
      channel: "discord",
      actor: { platformId: "95218063095377920", displayName: "patroza" },
      location: {
        guildId: "guild-1",
        channelId: "channel-1",
        threadId: "thread-1",
      },
    });
  });

  it("always stamps channel discord even when author is missing", () => {
    expect(discordSourceHint({})).toEqual({ channel: "discord" });
  });
});
