import { describe, expect, it } from "vite-plus/test";

import {
  extractJiraIssueKeys,
  extractJiraIssueKeysFromDiscordMessage,
  formatJiraLinksForDiscord,
  jiraBrowseUrl,
  mergeJiraIssueKeys,
  normalizeJiraIssueKey,
  resolveJiraBrowseBaseUrl,
} from "./jiraLinks.ts";

describe("normalizeJiraIssueKey", () => {
  it("uppercases valid keys", () => {
    expect(normalizeJiraIssueKey("proj-367")).toBe("PROJ-367");
    expect(normalizeJiraIssueKey("ACV2-642")).toBe("ACV2-642");
  });

  it("rejects invalid shapes", () => {
    expect(normalizeJiraIssueKey("EXAMPLE-PROJECT-API-JW")).toBeNull();
    expect(normalizeJiraIssueKey("not-a-key")).toBeNull();
    expect(normalizeJiraIssueKey("A-1")).toBeNull();
  });
});

describe("resolveJiraBrowseBaseUrl", () => {
  it("keeps classic atlassian site roots", () => {
    expect(resolveJiraBrowseBaseUrl("https://example.atlassian.net/")).toBe(
      "https://example.atlassian.net",
    );
    expect(resolveJiraBrowseBaseUrl("https://example.atlassian.net/browse/PROJ-1")).toBe(
      "https://example.atlassian.net",
    );
  });

  it("rejects API gateway URLs that are not browse sites", () => {
    expect(
      resolveJiraBrowseBaseUrl(
        "https://api.atlassian.com/ex/jira/a6978c4b-b79e-4b1f-83ea-c537c2b19316",
      ),
    ).toBeUndefined();
  });
});

describe("extractJiraIssueKeys", () => {
  it("extracts bare keys in first-seen order without duplicates", () => {
    expect(extractJiraIssueKeys("Please look at PROJ-367 then PROJ-400 and PROJ-367 again")).toEqual([
      "PROJ-367",
      "PROJ-400",
    ]);
  });

  it("extracts keys from browse URLs and selectedIssue params", () => {
    const text = [
      "https://example.atlassian.net/browse/PROJ-100",
      "also https://example.atlassian.net/jira/software/c/projects/SA/boards/1?selectedIssue=PROJ-200",
      "and PROJ-100 again",
    ].join(" ");
    expect(extractJiraIssueKeys(text)).toEqual(["PROJ-100", "PROJ-200"]);
  });

  it("reads embeds as well as content", () => {
    expect(
      extractJiraIssueKeysFromDiscordMessage({
        content: "ping",
        embeds: [
          {
            url: "https://example.atlassian.net/browse/PROJ-50",
            title: "PROJ-50 Fix packing",
          },
        ],
      }),
    ).toEqual(["PROJ-50"]);
  });
});

describe("mergeJiraIssueKeys", () => {
  it("appends only new keys in order", () => {
    expect(mergeJiraIssueKeys(["PROJ-1", "PROJ-2"], ["PROJ-2", "PROJ-3", "proj-1"])).toEqual([
      "PROJ-1",
      "PROJ-2",
      "PROJ-3",
    ]);
  });
});

describe("formatJiraLinksForDiscord", () => {
  it("renders markdown links when browse base is set", () => {
    expect(formatJiraLinksForDiscord(["PROJ-367"], "https://example.atlassian.net")).toBe(
      ["**Jira**", "• [PROJ-367](https://example.atlassian.net/browse/PROJ-367)"].join("\n"),
    );
  });

  it("falls back to bare keys without a browse base", () => {
    expect(formatJiraLinksForDiscord(["PROJ-367"], undefined)).toBe(
      ["**Jira**", "• `PROJ-367`"].join("\n"),
    );
  });

  it("returns null for empty key lists", () => {
    expect(formatJiraLinksForDiscord([], "https://example.atlassian.net")).toBeNull();
  });
});

describe("jiraBrowseUrl", () => {
  it("builds browse URLs", () => {
    expect(jiraBrowseUrl("https://example.atlassian.net", "proj-367")).toBe(
      "https://example.atlassian.net/browse/PROJ-367",
    );
  });
});
