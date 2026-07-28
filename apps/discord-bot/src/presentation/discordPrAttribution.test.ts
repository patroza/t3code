import { describe, expect, it } from "vite-plus/test";

import {
  appendDiscordPrAttributionFooter,
  buildDiscordThreadJumpUrl,
  DISCORD_PR_ATTRIBUTION_MARKER,
  ensureDiscordPrAttributionFooters,
  formatDiscordPrAttributionFooter,
  newlyObservedPullRequestUrls,
  prBodyHasDiscordAttribution,
  starterDisplayName,
  starterUserId,
} from "./discordPrAttribution.ts";

describe("formatDiscordPrAttributionFooter", () => {
  it("formats starter + thread title + jump link", () => {
    expect(
      formatDiscordPrAttributionFooter({
        starterDisplayName: "joshuadima",
        starterUserId: "593167616273809448",
        threadTitle: "Open Random PR Test",
        threadJumpUrl:
          "https://discord.com/channels/1083767712431480922/1531376362399465595/1531376362399465595",
      }),
    ).toBe(
      "opened by [joshuadima](593167616273809448) in chat thread **Discord** · [Open Random PR Test](https://discord.com/channels/1083767712431480922/1531376362399465595/1531376362399465595)",
    );
  });

  it("escapes markdown brackets in names/titles", () => {
    const footer = formatDiscordPrAttributionFooter({
      starterDisplayName: "a[b]c",
      starterUserId: "1",
      threadTitle: "Title [x]",
      threadJumpUrl: "https://discord.com/channels/1/2/3",
    });
    expect(footer).toContain("[a\\[b\\]c](1)");
    expect(footer).toContain("[Title \\[x\\]](https://discord.com/channels/1/2/3)");
  });
});

describe("buildDiscordThreadJumpUrl", () => {
  it("prefers message id when provided", () => {
    expect(
      buildDiscordThreadJumpUrl({
        guildId: "g",
        discordThreadId: "t",
        messageId: "m",
      }),
    ).toBe("https://discord.com/channels/g/t/m");
  });

  it("falls back to thread id as message id", () => {
    expect(
      buildDiscordThreadJumpUrl({
        guildId: "g",
        discordThreadId: "t",
        messageId: null,
      }),
    ).toBe("https://discord.com/channels/g/t/t");
  });
});

describe("starter helpers", () => {
  it("prefers displayName over username", () => {
    expect(
      starterDisplayName({
        id: "m1",
        author: { id: "u1", username: "user", displayName: "Display" },
      }),
    ).toBe("Display");
    expect(starterUserId({ id: "m1", author: { id: "u1" } })).toBe("u1");
  });

  it("handles missing starter", () => {
    expect(starterDisplayName(null)).toBe("unknown");
    expect(starterUserId(null)).toBeNull();
  });
});

describe("prBodyHasDiscordAttribution / appendDiscordPrAttributionFooter", () => {
  const footer = formatDiscordPrAttributionFooter({
    starterDisplayName: "joshuadima",
    starterUserId: "593167616273809448",
    threadTitle: "Thread",
    threadJumpUrl: "https://discord.com/channels/1/2/3",
  });

  it("detects existing footer marker", () => {
    expect(prBodyHasDiscordAttribution(`hello\n${DISCORD_PR_ATTRIBUTION_MARKER}\n`)).toBe(true);
    expect(prBodyHasDiscordAttribution("## Summary\n- stuff")).toBe(false);
  });

  it("appends footer with separator when missing", () => {
    expect(appendDiscordPrAttributionFooter("## Summary\n- a", footer)).toBe(
      `## Summary\n- a\n\n---\n\n${footer}\n`,
    );
  });

  it("returns null when already present (idempotent)", () => {
    const body = `## Summary\n\n---\n\n${footer}\n`;
    expect(appendDiscordPrAttributionFooter(body, footer)).toBeNull();
  });

  it("works on empty body", () => {
    expect(appendDiscordPrAttributionFooter("", footer)).toBe(`${footer}\n`);
  });
});

describe("newlyObservedPullRequestUrls", () => {
  it("returns only new canonical PR urls", () => {
    expect(
      newlyObservedPullRequestUrls(
        ["https://github.com/owner/repo/pull/1"],
        [
          "https://github.com/owner/repo/pull/1/files",
          "https://github.com/owner/repo/pull/2",
          "https://example.com/not-a-pr",
        ],
      ),
    ).toEqual(["https://github.com/owner/repo/pull/2"]);
  });
});

describe("ensureDiscordPrAttributionFooters", () => {
  it("patches missing footers and skips ones already present", async () => {
    const bodies = new Map<string, string>([
      ["repos/o/r/pulls/1", "## Summary\n- a\n"],
      [
        "repos/o/r/pulls/2",
        `## Summary\n\n---\n\nopened by [x](1) ${DISCORD_PR_ATTRIBUTION_MARKER} [t](https://discord.com/channels/1/2/3)\n`,
      ],
    ]);
    const patched: string[] = [];

    const results = await ensureDiscordPrAttributionFooters({
      prUrls: [
        "https://github.com/o/r/pull/1",
        "https://github.com/o/r/pull/2",
        "https://github.com/o/r/pull/3",
      ],
      footer: formatDiscordPrAttributionFooter({
        starterDisplayName: "joshuadima",
        starterUserId: "593167616273809448",
        threadTitle: "Open Random PR Test",
        threadJumpUrl: "https://discord.com/channels/1/2/3",
      }),
      execFile: async (_file, args) => {
        const path = String(args[1] ?? "");
        if (args.includes("--jq")) {
          if (!bodies.has(path)) {
            throw new Error(`not found: ${path}`);
          }
          return { stdout: bodies.get(path) ?? "", stderr: "" };
        }
        if (args.includes("PATCH")) {
          patched.push(path);
          return { stdout: "", stderr: "" };
        }
        throw new Error(`unexpected gh args: ${args.join(" ")}`);
      },
    });

    expect(results).toEqual([
      { url: "https://github.com/o/r/pull/1", status: "updated" },
      { url: "https://github.com/o/r/pull/2", status: "already_present" },
      {
        url: "https://github.com/o/r/pull/3",
        status: "error",
        detail: "not found: repos/o/r/pulls/3",
      },
    ]);
    expect(patched).toEqual(["repos/o/r/pulls/1"]);
  });
});
