import { describe, expect, it } from "vite-plus/test";

import {
  buildTodayRecapPrompt,
  chunkTodayRecapContent,
  extractLatestAssistantText,
  formatTodayRecapThreadTitle,
  formatTodayRecapWorking,
  TODAY_RECAP_SUBCOMMAND,
  utcDateStamp,
} from "./todayRecap.ts";

describe("today recap helpers", () => {
  it("keeps the slash subcommand name Discord-safe", () => {
    expect(TODAY_RECAP_SUBCOMMAND).toBe("today-recap");
    expect(TODAY_RECAP_SUBCOMMAND.length).toBeLessThanOrEqual(32);
  });

  it("stamps UTC dates from ISO timestamps", () => {
    expect(utcDateStamp("2026-08-18T14:21:46.000Z")).toBe("2026-08-18");
    expect(utcDateStamp("2026-08-18")).toBe("2026-08-18");
  });

  it("names the recap thread after the channel's project", () => {
    expect(formatTodayRecapThreadTitle({ shortName: "scanner", date: "2026-08-18" })).toBe(
      "today recap scanner 2026-08-18",
    );
  });

  it("replaces Discord's deferred thinking spinner with a working status", () => {
    expect(formatTodayRecapWorking({ shortName: "scanner", date: "2026-08-26" })).toBe(
      "Writing today's recap of `scanner` (2026-08-26 UTC)…",
    );
  });

  it("scopes the prompt to the calling channel's repo and the recap format", () => {
    const prompt = buildTodayRecapPrompt({
      shortName: "scanner",
      date: "2026-08-18",
      parentChannelId: "1176897071815610458",
    });

    expect(prompt).toContain("`scanner`");
    expect(prompt).toContain("<#1176897071815610458>");
    expect(prompt).toContain("2026-08-18");
    expect(prompt).toContain("GitHub's UTC calendar day 2026-08-18");
    expect(prompt).toContain("Read-only");
    expect(prompt).toContain("do not open a PR");
    expect(prompt).toContain("opened that day and still open");
    expect(prompt).toContain("not the rest of the open backlog");
    expect(prompt).toContain("no change");
    expect(prompt).toContain("[PR #N](github-url) (fix)");
    expect(prompt).toContain("(feat)");
    expect(prompt).toContain("## 🟢 MERGED");
    expect(prompt).toContain("## 🔴 CLOSED");
    expect(prompt).toContain("## 🟠 OPEN");
    expect(prompt).toContain("Related PRs");
    expect(prompt).toContain("heading PR's description");
    expect(prompt).toContain('Do not write "landed today"');
    expect(prompt).toContain("gh pr list");
    expect(prompt).toContain("closed PR with no connection");
    expect(prompt).toContain("Do not use ### type headings");
    expect(prompt).not.toContain("landed today`");
    expect(prompt).not.toContain("### fix");
    expect(prompt).not.toContain("### feat");
    expect(prompt).not.toContain("configurator");
  });

  it("splits long recaps on blank lines so a PR block stays in one message", () => {
    const prA = `[PR #1880](https://github.com/macs-holding/scanner/pull/1880) (feat)\nBauhaus packing materials were hardcoded.`;
    const prB = `[PR #2273](https://github.com/macs-holding/scanner/pull/2273) (fix)\n${"x".repeat(1700)}`;
    const recap = `## 🟢 MERGED\n\n${prA}\n\n## 🟠 OPEN\n\n${prB}`;
    const chunks = chunkTodayRecapContent(recap, 1800);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toContain("PR #1880");
    expect(chunks[0]).not.toContain("PR #2273");
    expect(chunks[1]).toContain("PR #2273");
    expect(chunks[1]).not.toContain("PR #1880");
    expect(chunks.every((chunk) => chunk.length <= 1800)).toBe(true);
  });

  it("takes the last non-empty assistant message as the recap body", () => {
    expect(
      extractLatestAssistantText([
        { role: "user", text: "recap" },
        { role: "assistant", text: "draft" },
        { role: "assistant", text: "no change" },
      ]),
    ).toBe("no change");
    expect(extractLatestAssistantText([{ role: "user", text: "recap" }])).toBeNull();
    expect(extractLatestAssistantText([{ role: "assistant", text: "  " }])).toBeNull();
  });
});
