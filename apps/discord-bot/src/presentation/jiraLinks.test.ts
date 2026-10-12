import { describe, expect, it } from "vite-plus/test";

import {
  extractJiraIssueKeys,
  extractJiraIssueKeysFromDiscordMessage,
  formatJiraLinksForDiscord,
  jiraBrowseUrl,
  jiraIssueKeysAfterExcludingSentryFalsePositives,
  jiraIssueKeysMaskedBySentryContext,
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
    expect(extractJiraIssueKeys("Please look at SA-367 then CFG-400 and SA-367 again")).toEqual([
      "SA-367",
      "CFG-400",
    ]);
  });

  it("ignores Jira-shaped tokens that are not a known project", () => {
    expect(
      extractJiraIssueKeys(
        "GPT-6 is not a ticket. Also SHA-256, EAN-13, and GPT-6.1. See SA-465 and CFG-12.",
      ),
    ).toEqual(["SA-465", "CFG-12"]);
  });

  it("keeps a key from an Atlassian URL even when the project is not allowlisted", () => {
    expect(
      extractJiraIssueKeys(
        "bare OTHER-9 vs https://example.atlassian.net/browse/OTHER-9 and GPT-6",
      ),
    ).toEqual(["OTHER-9"]);
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

  it("does not treat sentry.io short ids as Jira keys", () => {
    expect(extractJiraIssueKeys("see https://macs-scanner.sentry.io/issues/SCANNER-313/")).toEqual(
      [],
    );
    expect(
      extractJiraIssueKeysFromDiscordMessage({
        author: { username: "Sentry", bot: true },
        content: "",
        embeds: [
          {
            title: "T3 did not become ready after a server restart",
            url: "https://macs-scanner.sentry.io/issues/7506163172/",
            footer: { text: "SCANNER-313" },
          },
        ],
      }),
    ).toEqual([]);
  });

  it("still extracts Atlassian keys next to a Sentry embed", () => {
    expect(
      extractJiraIssueKeysFromDiscordMessage({
        author: { username: "Sentry", bot: true },
        content: "also https://example.atlassian.net/browse/PROJ-9",
        embeds: [
          {
            url: "https://macs-scanner.sentry.io/issues/7506163172/",
            footer: { text: "SCANNER-313" },
          },
        ],
      }),
    ).toEqual(["PROJ-9"]);
  });
});

describe("sentry-masked Jira false positives", () => {
  it("returns an allowlisted Sentry short id so stored Jira keys can be dropped", () => {
    expect(
      jiraIssueKeysMaskedBySentryContext({
        author: { username: "Sentry", bot: true },
        embeds: [
          {
            url: "https://macs-scanner.sentry.io/issues/7506163172/",
            footer: { text: "SA-313" },
          },
        ],
      }),
    ).toEqual(["SA-313"]);
    expect(
      jiraIssueKeysMaskedBySentryContext({
        author: { username: "Sentry", bot: true },
        embeds: [
          {
            url: "https://macs-scanner.sentry.io/issues/7506163172/",
            footer: { text: "SCANNER-313" },
          },
        ],
      }),
    ).toEqual([]);
  });

  it("drops stored Sentry short ids unless they were also extracted as real Jira", () => {
    expect(
      jiraIssueKeysAfterExcludingSentryFalsePositives(
        ["SCANNER-313", "PROJ-1"],
        ["PROJ-1"],
        ["SCANNER-313"],
      ),
    ).toEqual(["PROJ-1"]);
    expect(
      jiraIssueKeysAfterExcludingSentryFalsePositives(
        ["SCANNER-313"],
        ["SCANNER-313"],
        ["SCANNER-313"],
      ),
    ).toEqual(["SCANNER-313"]);
  });

  it("drops a stored key that is not a known project and was not extracted again", () => {
    expect(jiraIssueKeysAfterExcludingSentryFalsePositives(["GPT-6", "SA-465"], [], [])).toEqual([
      "SA-465",
    ]);
    expect(jiraIssueKeysAfterExcludingSentryFalsePositives(["GPT-6"], ["OTHER-9"], [])).toEqual([
      "OTHER-9",
    ]);
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
