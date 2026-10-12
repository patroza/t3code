import { describe, expect, it } from "vite-plus/test";

import {
  EXPORT_HISTORY_CAP,
  EXPORT_HISTORY_PAGE_SIZE,
  EXPORT_MARKDOWN_NAME,
  exportHistoryTarget,
  exportInteractionContent,
  initialExportHistoryCursor,
  nextExportHistoryCursor,
  parseExportCount,
  renderThreadExport,
  type DiscordExportMessage,
} from "./threadExport.ts";

const BOT_ID = "1526694335431577700";
const JOSHUA_ID = "593167616273809448";
const PATRICK_ID = "95218063095377920";

function message(
  overrides: Partial<DiscordExportMessage> & Pick<DiscordExportMessage, "id" | "author">,
): DiscordExportMessage {
  return {
    content: "",
    timestamp: "2026-10-12T09:01:00.000Z",
    ...overrides,
  };
}

describe("parseExportCount", () => {
  it("copies the whole chat when count is omitted", () => {
    expect(parseExportCount(undefined)).toEqual({ scope: "all" });
    expect(parseExportCount(null)).toEqual({ scope: "all" });
    expect(parseExportCount("")).toEqual({ scope: "all" });
    expect(exportHistoryTarget({ scope: "all" })).toBe(EXPORT_HISTORY_CAP);
  });

  it("accepts a whole number in range and rejects the rest", () => {
    expect(parseExportCount(1)).toEqual({ scope: "latest", count: 1 });
    expect(parseExportCount("12")).toEqual({ scope: "latest", count: 12 });
    expect(parseExportCount(EXPORT_HISTORY_CAP)).toEqual({
      scope: "latest",
      count: EXPORT_HISTORY_CAP,
    });
    expect(exportHistoryTarget({ scope: "latest", count: 12 })).toBe(12);
    expect(parseExportCount(0)).toBeNull();
    expect(parseExportCount(EXPORT_HISTORY_CAP + 1)).toBeNull();
    expect(parseExportCount(1.5)).toBeNull();
    expect(parseExportCount("latest")).toBeNull();
    expect(parseExportCount(true)).toBeNull();
  });
});

describe("export history paging", () => {
  it("starts with one Discord page, or fewer when count is small", () => {
    expect(initialExportHistoryCursor(20)).toEqual({ limit: 20 });
    expect(initialExportHistoryCursor(EXPORT_HISTORY_CAP)).toEqual({
      limit: EXPORT_HISTORY_PAGE_SIZE,
    });
  });

  it("walks older pages until a short page or the cap", () => {
    expect(
      nextExportHistoryCursor({
        target: EXPORT_HISTORY_CAP,
        collected: 100,
        pageCount: 100,
        pageLimit: 100,
        oldestId: "100",
      }),
    ).toEqual({ limit: 100, before: "100" });
    expect(
      nextExportHistoryCursor({
        target: EXPORT_HISTORY_CAP,
        collected: 4980,
        pageCount: 100,
        pageLimit: 100,
        oldestId: "4980",
      }),
    ).toEqual({ limit: 20, before: "4980" });
    expect(
      nextExportHistoryCursor({
        target: EXPORT_HISTORY_CAP,
        collected: 40,
        pageCount: 40,
        pageLimit: 100,
        oldestId: "40",
      }),
    ).toBe("end");
    expect(
      nextExportHistoryCursor({
        target: 50,
        collected: 50,
        pageCount: 50,
        pageLimit: 50,
        oldestId: "50",
      }),
    ).toBe("maybe-truncated");
    expect(
      nextExportHistoryCursor({
        target: EXPORT_HISTORY_CAP,
        collected: 100,
        pageCount: 100,
        pageLimit: 100,
        oldestId: undefined,
      }),
    ).toBe("end");
  });
});

describe("renderThreadExport", () => {
  it("labels humans user-n and calls the bot omegent", () => {
    const markdown = renderThreadExport({
      botUserId: BOT_ID,
      messages: [
        message({
          id: "200",
          timestamp: "2026-10-12T09:02:00.000Z",
          content: `Yes. See <@${JOSHUA_ID}>.`,
          author: { id: BOT_ID, username: "Omegent", global_name: "Omegent", bot: true },
        }),
        message({
          id: "100",
          timestamp: "2026-10-12T09:01:00.000Z",
          content: "attached .md got removed last week right?",
          author: {
            id: JOSHUA_ID,
            username: "joshuadima",
            global_name: "Joshua Dimaunahan",
            bot: false,
          },
        }),
      ],
    });

    expect(markdown).toContain("Participants: user-1, omegent");
    expect(markdown).toContain("user-1 — 2026-10-12 09:01 UTC");
    expect(markdown).not.toContain("Joshua Dimaunahan");
    expect(markdown).toContain("attached .md got removed last week right?");
    expect(markdown).toContain("omegent — 2026-10-12 09:02 UTC");
    expect(markdown).toContain("Yes. See user-1.");
    expect(markdown).not.toContain(JOSHUA_ID);
    expect(markdown).not.toContain("joshuadima");
    expect(markdown).not.toContain("Omegent");
    expect(markdown.indexOf("09:01")).toBeLessThan(markdown.indexOf("09:02"));
  });

  it("hides a display name that is the username and rewrites handles and profile urls", () => {
    const markdown = renderThreadExport({
      botUserId: BOT_ID,
      messages: [
        message({
          id: "100",
          content:
            "ping <@!95218063095377920> and https://discord.com/users/95218063095377920 @joshuadima",
          author: { id: JOSHUA_ID, username: "joshuadima", global_name: "joshuadima" },
          mentions: [{ id: PATRICK_ID, username: "patroza", global_name: "Patrick Roza" }],
        }),
        message({
          id: "101",
          content: "ask Patrick Roza about role <@&123> in <#456> :smile: <@123456789012345678>",
          author: { id: PATRICK_ID, username: "patroza", global_name: "Patrick Roza" },
        }),
      ],
    });

    expect(markdown).toContain("user-1 — ");
    expect(markdown).toContain("Participants: user-1, user-2");
    expect(markdown).toContain("ping user-2 and user-2 user-1");
    expect(markdown).toContain("ask user-2 about role role in channel :smile: user");
    expect(markdown).not.toContain("Patrick Roza");
    expect(markdown).not.toContain("joshuadima");
    expect(markdown).not.toContain("patroza");
    expect(markdown).not.toContain(PATRICK_ID);
    expect(markdown).not.toContain(JOSHUA_ID);
  });

  it("keeps a short word that merely shares letters with a username", () => {
    const markdown = renderThreadExport({
      botUserId: BOT_ID,
      messages: [
        message({
          id: "100",
          content: "markdown is fine",
          author: { id: JOSHUA_ID, username: "mark", global_name: "Joshua" },
        }),
      ],
    });

    expect(markdown).toContain("markdown is fine");
    expect(markdown).toContain("user-1 — ");
    expect(markdown).not.toContain("Joshua");
  });

  it("notes replies, files, and stickers without attachment urls", () => {
    const markdown = renderThreadExport({
      botUserId: BOT_ID,
      messages: [
        message({
          id: "100",
          content: "",
          author: { id: JOSHUA_ID, username: "joshuadima", global_name: "Joshua Dimaunahan" },
          attachments: [
            {
              filename: `shot-${JOSHUA_ID}.png`,
            },
          ],
          sticker_items: [{ name: "wave" }],
        }),
        message({
          id: "101",
          content: "replying",
          author: { id: BOT_ID, username: "Omegent", bot: true },
          referenced_message: {
            author: { id: JOSHUA_ID, username: "joshuadima", global_name: "Joshua Dimaunahan" },
          },
        }),
      ],
    });

    expect(markdown).toContain(`[file: shot-user-1.png]\n[sticker: wave]`);
    expect(markdown).toContain("omegent — 2026-10-12 09:01 UTC (reply to user-1)");
    expect(markdown).not.toContain("cdn.discord");
    expect(markdown).not.toContain(JOSHUA_ID);
  });

  it("labels other bots separately and includes embed text", () => {
    const markdown = renderThreadExport({
      botUserId: BOT_ID,
      messages: [
        message({
          id: "100",
          content: "",
          embeds: [{ title: "Build failed", description: "see @joshuadima" }],
          author: {
            id: "999000000000000001",
            username: "getsentry",
            global_name: "Sentry",
            bot: true,
          },
          mentions: [{ id: JOSHUA_ID, username: "joshuadima", global_name: "Joshua Dimaunahan" }],
        }),
      ],
    });

    expect(markdown).toContain("bot-1 — ");
    expect(markdown).not.toContain("Sentry");
    expect(markdown).toContain("Build failed");
    expect(markdown).toContain("see user-1");
    expect(markdown).not.toContain("getsentry");
    expect(markdown).not.toContain("joshuadima");
  });

  it("says when the channel has no messages", () => {
    expect(renderThreadExport({ botUserId: BOT_ID, messages: [] })).toContain(
      "No messages to export.",
    );
  });

  it("says when older messages were left out", () => {
    const messages = [
      message({
        id: "100",
        content: "hi",
        author: { id: JOSHUA_ID, username: "joshuadima", global_name: "Joshua Dimaunahan" },
      }),
    ];
    const whole = renderThreadExport({ botUserId: BOT_ID, messages });
    expect(whole).toContain(
      "1 message. Discord usernames, display names, and user ids are omitted.",
    );
    expect(whole).not.toContain("left out");

    const truncated = renderThreadExport({ botUserId: BOT_ID, messages, truncated: true });
    expect(truncated).toContain(
      "Latest 1 message. Older messages were left out. Discord usernames, display names, and user ids are omitted.",
    );
  });
});

describe("exportInteractionContent", () => {
  it("returns the transcript when it fits in a Discord message", () => {
    expect(exportInteractionContent("# Chat export\n")).toBe("# Chat export\n");
  });

  it("points at the file when the transcript is too long to paste inline", () => {
    const content = exportInteractionContent("x".repeat(2001));
    expect(content).toContain(EXPORT_MARKDOWN_NAME);
    expect(content.length).toBeLessThanOrEqual(2000);
    expect(content).not.toContain("xxx");
  });
});
