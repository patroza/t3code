import { describe, expect, it } from "vite-plus/test";

import {
  discordThreadJumpUrl,
  FAVORITE_MISSING_DESTINATION_MESSAGE,
  formatFavoriteAck,
  formatFavoritePost,
  formatFavoritePostError,
  parseDiscordChannelId,
  resolveFavoriteDestination,
} from "./favorite.ts";

describe("parseDiscordChannelId", () => {
  it("accepts snowflakes, mentions, and jump URLs", () => {
    expect(parseDiscordChannelId("1402982606877757440")).toBe("1402982606877757440");
    expect(parseDiscordChannelId("<#1402982606877757440>")).toBe("1402982606877757440");
    expect(
      parseDiscordChannelId("https://discord.com/channels/1083767712431480922/1402982606877757440"),
    ).toBe("1402982606877757440");
    expect(
      parseDiscordChannelId(
        "https://discord.com/channels/1083767712431480922/1551740169399439392/1551752078940966964",
      ),
    ).toBe("1551740169399439392");
  });

  it("rejects empty and non-channel values", () => {
    expect(parseDiscordChannelId("")).toBeNull();
    expect(parseDiscordChannelId("  ")).toBeNull();
    expect(parseDiscordChannelId(null)).toBeNull();
    expect(parseDiscordChannelId("not-a-channel")).toBeNull();
  });
});

describe("favorite post + destination", () => {
  it("builds a jump URL and optional title line", () => {
    expect(discordThreadJumpUrl("1083767712431480922", "1551740169399439392")).toBe(
      "https://discord.com/channels/1083767712431480922/1551740169399439392",
    );
    expect(
      formatFavoritePost({
        guildId: "1083767712431480922",
        threadId: "1551740169399439392",
        threadName: "Discord",
      }),
    ).toBe("Discord\nhttps://discord.com/channels/1083767712431480922/1551740169399439392");
    expect(
      formatFavoritePost({
        guildId: "1083767712431480922",
        threadId: "1551740169399439392",
      }),
    ).toBe("https://discord.com/channels/1083767712431480922/1551740169399439392");
  });

  it("prefers option, then stored, then identity map", () => {
    expect(
      resolveFavoriteDestination({
        optionChannelId: "1",
        storedChannelId: "2",
        identityChannelId: "3",
      }),
    ).toEqual({ kind: "option", channelId: "1" });
    expect(
      resolveFavoriteDestination({
        storedChannelId: "2",
        identityChannelId: "3",
      }),
    ).toEqual({ kind: "stored", channelId: "2" });
    expect(resolveFavoriteDestination({ identityChannelId: "3" })).toEqual({
      kind: "identity",
      channelId: "3",
    });
    expect(resolveFavoriteDestination({})).toEqual({ kind: "missing" });
  });

  it("formats acks and post failures", () => {
    expect(
      formatFavoriteAck({
        destinationChannelId: "1402982606877757440",
        saved: false,
        posted: true,
      }),
    ).toBe("Sent to <#1402982606877757440>");
    expect(
      formatFavoriteAck({
        destinationChannelId: "1402982606877757440",
        saved: true,
        posted: false,
      }),
    ).toContain("Saved <#1402982606877757440>");
    expect(FAVORITE_MISSING_DESTINATION_MESSAGE).toContain("/favorite channel:");
    expect(formatFavoritePostError("9", new Error("Missing Access"))).toContain("Missing Access");
  });
});
