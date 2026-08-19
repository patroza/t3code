import { describe, expect, it } from "vite-plus/test";

import {
  buildTodayRecapPrompt,
  formatTodayRecapAck,
  formatTodayRecapThreadTitle,
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

  it("acks who asked and which repo/day", () => {
    expect(
      formatTodayRecapAck({
        displayName: "joshuadima",
        shortName: "scanner",
        date: "2026-08-18",
      }),
    ).toBe("**joshuadima** asked for today's recap of `scanner` (2026-08-18 UTC).");
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
    expect(prompt).toContain("[PR #N](github-url)");
    expect(prompt).toContain("bare URL");
    expect(prompt).toContain("## 🟢 MERGED");
    expect(prompt).toContain("## 🔴 CLOSED");
    expect(prompt).toContain("## 🟠 OPEN");
    expect(prompt).toContain("### fix");
    expect(prompt).toContain("### feat");
    expect(prompt).not.toContain("configurator");
  });
});
