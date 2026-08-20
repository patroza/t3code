import { describe, expect, it } from "vite-plus/test";

import {
  applySentryShortIdToIssueUrl,
  discordMessageLooksLikeSentry,
  extractSentryIssueUrls,
  extractSentryIssueUrlsFromDiscordMessage,
  formatLinkedSentryWorkItemsBlock,
  formatSentryLinksForDiscord,
  mergeSentryIssueUrls,
  normalizeSentryIssueUrl,
  sentryIssueLabelFromUrl,
  sentryShortIdFromText,
} from "./sentryLinks.ts";

const SCANNER_SENTRY_URL = "https://macs-scanner.sentry.io/issues/SCANNER-313";
const NUMERIC_SENTRY_URL = "https://macs-scanner.sentry.io/issues/7506163172";

describe("normalizeSentryIssueUrl", () => {
  it("canonicalizes org subdomain issue URLs", () => {
    expect(normalizeSentryIssueUrl(`${SCANNER_SENTRY_URL}/?project=1#events`)).toBe(
      SCANNER_SENTRY_URL,
    );
    expect(normalizeSentryIssueUrl("http://De.Sentry.io/issues/ABC-1/")).toBe(
      "https://de.sentry.io/issues/ABC-1",
    );
  });

  it("rejects non-sentry hosts", () => {
    expect(normalizeSentryIssueUrl("https://example.atlassian.net/browse/SCANNER-313")).toBeNull();
    expect(normalizeSentryIssueUrl("https://example.com/sentry.io/issues/1")).toBeNull();
  });
});

describe("extractSentryIssueUrls", () => {
  it("finds sentry.io links including short ids in the path", () => {
    expect(
      extractSentryIssueUrls(`see ${SCANNER_SENTRY_URL}/ and also ${NUMERIC_SENTRY_URL}/`),
    ).toEqual([SCANNER_SENTRY_URL, NUMERIC_SENTRY_URL]);
  });
});

describe("discordMessageLooksLikeSentry / extract from Discord", () => {
  it("detects Sentry bot embeds with a sentry.io url and short-id footer", () => {
    const message = {
      author: { username: "Sentry", bot: true },
      content: "",
      embeds: [
        {
          title: "T3 did not become ready after a server restart",
          url: `${NUMERIC_SENTRY_URL}/`,
          footer: { text: "SCANNER-313" },
        },
      ],
    };
    expect(discordMessageLooksLikeSentry(message)).toBe(true);
    expect(extractSentryIssueUrlsFromDiscordMessage(message)).toEqual([SCANNER_SENTRY_URL]);
  });

  it("detects a pasted sentry.io link from a human", () => {
    expect(
      discordMessageLooksLikeSentry({
        author: { username: "patroza" },
        content: `what happened here? ${SCANNER_SENTRY_URL}`,
      }),
    ).toBe(true);
  });

  it("does not treat ordinary messages as Sentry", () => {
    expect(
      discordMessageLooksLikeSentry({
        author: { username: "patroza" },
        content: "please look at PROJ-367",
      }),
    ).toBe(false);
  });
});

describe("formatSentryLinksForDiscord", () => {
  it("renders markdown links labelled with the issue id", () => {
    expect(sentryIssueLabelFromUrl(SCANNER_SENTRY_URL)).toBe("SCANNER-313");
    expect(formatSentryLinksForDiscord([`${NUMERIC_SENTRY_URL}/`, SCANNER_SENTRY_URL])).toBe(
      [
        "**Sentry**",
        `• [7506163172](${NUMERIC_SENTRY_URL})`,
        `• [SCANNER-313](${SCANNER_SENTRY_URL})`,
      ].join("\n"),
    );
  });

  it("returns null for empty lists", () => {
    expect(formatSentryLinksForDiscord([])).toBeNull();
    expect(mergeSentryIssueUrls(["x"], [SCANNER_SENTRY_URL])).toEqual([SCANNER_SENTRY_URL]);
  });
});

describe("sentry short ids on numeric issue URLs", () => {
  it("reads the qualified short id from a Sentry footer", () => {
    expect(sentryShortIdFromText("SCANNER-313")).toBe("SCANNER-313");
    expect(sentryShortIdFromText("SCANNER-313 via Scanner API • Today at 12:55 PM")).toBe(
      "SCANNER-313",
    );
    expect(sentryShortIdFromText("please look at PROJ-367")).toBeNull();
  });

  it("rewrites numeric /issues/N paths", () => {
    expect(applySentryShortIdToIssueUrl(NUMERIC_SENTRY_URL, "SCANNER-313")).toBe(
      SCANNER_SENTRY_URL,
    );
    expect(applySentryShortIdToIssueUrl(SCANNER_SENTRY_URL, "OTHER-1")).toBe(SCANNER_SENTRY_URL);
  });

  it("formats durable agent-turn URLs", () => {
    expect(formatLinkedSentryWorkItemsBlock([`${NUMERIC_SENTRY_URL}/`, SCANNER_SENTRY_URL])).toBe(
      `sentry: ${NUMERIC_SENTRY_URL} ${SCANNER_SENTRY_URL}`,
    );
    expect(formatLinkedSentryWorkItemsBlock([])).toBeNull();
  });
});
