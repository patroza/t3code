import { describe, expect, it } from "vite-plus/test";

import {
  buildThreadAttributeSearchTerms,
  threadAttributeSearchMatches,
  threadMatchesAttributeQuery,
} from "./threadAttributeSearch.ts";

const sample = {
  title: "Fix gate SA-123 for multi-user claims",
  branch: "pr/4521-identity-search",
  originSource: {
    channel: "discord" as const,
    personId: "patroza",
    username: "patroza",
    location: {
      issueKey: "SA-123",
      number: 4521,
      kind: "pr" as const,
    },
  },
  participantSummaries: [
    {
      personId: "patroza",
      username: "patroza",
      name: "Patrick Roza",
      firstChannel: "discord" as const,
    },
    {
      personId: "julius",
      username: "julius",
      firstChannel: "desktop" as const,
    },
  ],
  extraTerms: ["t3-code"],
};

describe("buildThreadAttributeSearchTerms", () => {
  it("includes identity handles and channels", () => {
    const terms = buildThreadAttributeSearchTerms(sample);
    expect(terms).toEqual(
      expect.arrayContaining([
        "patroza",
        "@patroza",
        "patroza@discord",
        "@discord",
        "discord",
        "julius",
        "@julius",
        "julius@desktop",
        "@desktop",
        "desktop",
        "patrick roza",
      ]),
    );
  });

  it("includes PR and Jira tokens", () => {
    const terms = buildThreadAttributeSearchTerms(sample);
    expect(terms).toEqual(
      expect.arrayContaining(["#4521", "4521", "pr/4521", "pr-4521", "sa-123"]),
    );
  });

  it("includes title and branch", () => {
    const terms = buildThreadAttributeSearchTerms(sample);
    expect(terms).toEqual(
      expect.arrayContaining(["fix gate sa-123 for multi-user claims", "pr/4521-identity-search"]),
    );
  });
});

describe("threadMatchesAttributeQuery", () => {
  it.each([
    ["@patroza"],
    ["patroza@discord"],
    ["@desktop"],
    ["#4521"],
    ["4521"],
    ["SA-123"],
    ["sa-123"],
    ["julius"],
    ["multi-user"],
  ])("matches %s", (query) => {
    expect(threadMatchesAttributeQuery(sample, query)).toBe(true);
  });

  it("rejects unrelated queries", () => {
    expect(threadMatchesAttributeQuery(sample, "@theo")).toBe(false);
    expect(threadMatchesAttributeQuery(sample, "#9999")).toBe(false);
    expect(threadMatchesAttributeQuery(sample, "ZZ-1")).toBe(false);
  });

  it("empty query matches all", () => {
    expect(threadMatchesAttributeQuery(sample, "  ")).toBe(true);
  });
});

describe("threadAttributeSearchMatches", () => {
  it("matches partial username prefixes", () => {
    const terms = buildThreadAttributeSearchTerms(sample);
    expect(threadAttributeSearchMatches(terms, "@patr")).toBe(true);
  });
});
