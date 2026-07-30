import { describe, expect, it } from "vite-plus/test";

import {
  appendDiscordPrAttributionFooter,
  buildDiscordThreadJumpUrl,
  buildOmegentThreadMessageUrl,
  buildT3WebThreadUrl,
  DISCORD_PR_ATTRIBUTION_MARKER,
  ensureDiscordPrAttributionFooters,
  formatDiscordPrAttributionFooter,
  newlyObservedPullRequestUrls,
  pickT3ThreadUrlForGithubRepo,
  prBodyHasDiscordAttribution,
  starterDisplayName,
  starterUserId,
  toT3PublicShortThreadUrl,
  withT3ThreadLink,
} from "./discordPrAttribution.ts";

describe("formatDiscordPrAttributionFooter", () => {
  it("formats starter profile URL + full thread jump link", () => {
    expect(
      formatDiscordPrAttributionFooter({
        starterDisplayName: "joshuadima",
        starterUserId: "593167616273809448",
        threadTitle: "Open Random PR Test",
        threadJumpUrl:
          "https://discord.com/channels/1083767712431480922/1531376362399465595/1531376362399465595",
      }),
    ).toBe(
      "opened by [joshuadima](https://discord.com/users/593167616273809448) in chat thread **Discord** · [Open Random PR Test](https://discord.com/channels/1083767712431480922/1531376362399465595/1531376362399465595)",
    );
  });

  it("omits broken/truncated thread links", () => {
    expect(
      formatDiscordPrAttributionFooter({
        starterDisplayName: "joshuadima",
        starterUserId: "593167616273809448",
        threadTitle: "Thread",
        threadJumpUrl: "https://discord.com/channels",
      }),
    ).toBe(
      "opened by [joshuadima](https://discord.com/users/593167616273809448) in chat thread **Discord**",
    );
  });

  it("escapes markdown brackets in names/titles", () => {
    const footer = formatDiscordPrAttributionFooter({
      starterDisplayName: "a[b]c",
      starterUserId: "1",
      threadTitle: "Title [x]",
      threadJumpUrl: "https://discord.com/channels/1/2/3",
    });
    expect(footer).toContain("[a\\[b\\]c](https://discord.com/users/1)");
    expect(footer).toContain("[Title \\[x\\]](https://discord.com/channels/1/2/3)");
  });

  it("appends T3 thread link when provided", () => {
    expect(
      formatDiscordPrAttributionFooter({
        starterDisplayName: "patroza",
        starterUserId: "1",
        threadTitle: "Thread",
        threadJumpUrl: "https://discord.com/channels/1/2/3",
        t3ThreadUrl: "https://t3vm.tail.example.ts.net/?thread=abc",
      }),
    ).toContain(" · [T3](https://t3vm.tail.example.ts.net/?thread=abc)");
  });
});

describe("T3 thread URL helpers", () => {
  it("builds full and short t3 thread URLs", () => {
    expect(buildT3WebThreadUrl("https://t3vm.tail86038f.ts.net/", "tid-1")).toBe(
      "https://t3vm.tail86038f.ts.net/?thread=tid-1",
    );
    expect(toT3PublicShortThreadUrl("https://t3vm.tail86038f.ts.net/?thread=tid-1")).toBe(
      "https://t3vm/?thread=tid-1",
    );
    expect(
      pickT3ThreadUrlForGithubRepo({
        fullUrl: "https://t3vm.tail86038f.ts.net/?thread=tid-1",
        repoIsPrivate: true,
      }),
    ).toBe("https://t3vm.tail86038f.ts.net/?thread=tid-1");
    expect(
      pickT3ThreadUrlForGithubRepo({
        fullUrl: "https://t3vm.tail86038f.ts.net/?thread=tid-1",
        repoIsPrivate: false,
      }),
    ).toBe("https://t3vm/?thread=tid-1");
    expect(
      pickT3ThreadUrlForGithubRepo({
        fullUrl: "https://t3vm.tail86038f.ts.net/?thread=tid-1",
        repoIsPrivate: null,
      }),
    ).toBe("https://t3vm/?thread=tid-1");
  });

  it("builds Omegent message deep links on the short t3vm host", () => {
    expect(
      buildOmegentThreadMessageUrl({
        webUiBaseUrl: "https://t3vm.tail86038f.ts.net/",
        threadId: "tid-1",
        messageId: "msg-1",
      }),
    ).toBe("https://t3vm/?thread=tid-1#message-msg-1");
    // No web UI base → still emit a usable short t3vm link.
    expect(
      buildOmegentThreadMessageUrl({
        webUiBaseUrl: undefined,
        threadId: "tid-1",
        messageId: "msg-1",
      }),
    ).toBe("https://t3vm/?thread=tid-1#message-msg-1");
    expect(
      buildOmegentThreadMessageUrl({
        webUiBaseUrl: "https://t3vm.tail86038f.ts.net/",
        threadId: "tid-1",
        messageId: "",
      }),
    ).toBeNull();
  });

  it("withT3ThreadLink is idempotent", () => {
    const base =
      "opened by [x](https://discord.com/users/1) in chat thread **Discord** · [t](https://discord.com/channels/1/2/3)";
    const once = withT3ThreadLink(base, "https://t3vm/?thread=1");
    expect(once).toBe(`${base} · [T3](https://t3vm/?thread=1)`);
    expect(withT3ThreadLink(once, "https://t3vm/?thread=1")).toBe(once);
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
    const repoPrivate = new Map<string, string>([["repos/o/r", "true"]]);
    const patched: string[] = [];
    const writtenBodies: string[] = [];

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
      t3FullThreadUrl: "https://t3vm.tail.example.ts.net/?thread=t1",
      execFile: async (_file, args) => {
        const path = String(args[1] ?? "");
        if (args.includes("--jq")) {
          const jq = String(args[args.indexOf("--jq") + 1] ?? "");
          if (jq.includes(".private")) {
            return { stdout: repoPrivate.get(path) ?? "false", stderr: "" };
          }
          if (!bodies.has(path)) {
            throw new Error(`not found: ${path}`);
          }
          return { stdout: bodies.get(path) ?? "", stderr: "" };
        }
        if (args.includes("PATCH")) {
          patched.push(path);
          // body written via temp file; just record path
          writtenBodies.push(path);
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
