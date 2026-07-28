import { describe, expect, it } from "vite-plus/test";

import {
  extractPullRequestUrls,
  extractPullRequestUrlsFromDiscordMessage,
  formatPullRequestLabel,
  formatPullRequestLinksForDiscord,
  mergePullRequestUrls,
  sortPullRequestUrlsForDisplay,
  normalizeGithubRepoSlug,
  normalizePullRequestUrl,
} from "./prLinks.ts";

describe("normalizePullRequestUrl", () => {
  it("canonicalizes GitHub PR URLs", () => {
    expect(normalizePullRequestUrl("https://github.com/pingdotgg/t3code/pull/42")).toEqual({
      url: "https://github.com/pingdotgg/t3code/pull/42",
      owner: "pingdotgg",
      repo: "t3code",
      number: 42,
      repoSlug: "pingdotgg/t3code",
    });
  });

  it("strips subpaths, query, hash, and www; lowercases owner/repo", () => {
    expect(
      normalizePullRequestUrl(
        "https://www.GitHub.com/PingDotGG/T3Code/pull/7/files?w=1#discussion_r1",
      ),
    ).toEqual({
      url: "https://github.com/pingdotgg/t3code/pull/7",
      owner: "pingdotgg",
      repo: "t3code",
      number: 7,
      repoSlug: "pingdotgg/t3code",
    });
  });

  it("rejects non-PR URLs", () => {
    expect(normalizePullRequestUrl("https://github.com/pingdotgg/t3code/issues/1")).toBeNull();
    expect(normalizePullRequestUrl("https://gitlab.com/foo/bar/-/merge_requests/1")).toBeNull();
    expect(normalizePullRequestUrl("not a url")).toBeNull();
  });
});

describe("normalizeGithubRepoSlug", () => {
  it("accepts owner/repo and github URLs", () => {
    expect(normalizeGithubRepoSlug("Example-Org/Configurator")).toBe("example-org/configurator");
    expect(normalizeGithubRepoSlug("https://github.com/example-org/scanner.git")).toBe(
      "example-org/scanner",
    );
  });
});

describe("formatPullRequestLabel", () => {
  const pr = {
    owner: "example-org",
    repo: "configurator",
    number: 123,
    repoSlug: "example-org/configurator",
  };

  it("uses PR #N when channel repo matches or is unknown", () => {
    expect(formatPullRequestLabel(pr, "example-org/configurator")).toBe("PR #123");
    expect(formatPullRequestLabel(pr, null)).toBe("PR #123");
    expect(formatPullRequestLabel(pr, undefined)).toBe("PR #123");
  });

  it("prefixes owner/repo when the PR is from another channel repo", () => {
    expect(formatPullRequestLabel(pr, "example-org/scanner")).toBe(
      "example-org/configurator PR #123",
    );
  });
});

describe("extractPullRequestUrls", () => {
  it("extracts URLs in first-seen order without duplicates", () => {
    const text = [
      "see https://github.com/acme/widgets/pull/42",
      "and https://github.com/acme/widgets/pull/7/files",
      "and https://github.com/acme/widgets/pull/42 again",
      "plus **Draft PR:** https://github.com/example-org/scanner/pull/1950",
    ].join(" ");
    expect(extractPullRequestUrls(text)).toEqual([
      "https://github.com/acme/widgets/pull/42",
      "https://github.com/acme/widgets/pull/7",
      "https://github.com/example-org/scanner/pull/1950",
    ]);
  });

  it("reads embeds as well as content", () => {
    expect(
      extractPullRequestUrlsFromDiscordMessage({
        content: "ping",
        embeds: [
          {
            url: "https://github.com/acme/widgets/pull/9",
            title: "Fix packing",
          },
        ],
      }),
    ).toEqual(["https://github.com/acme/widgets/pull/9"]);
  });
});

describe("mergePullRequestUrls", () => {
  it("appends only new URLs in order", () => {
    expect(
      mergePullRequestUrls(
        ["https://github.com/a/b/pull/1", "https://github.com/a/b/pull/2"],
        [
          "https://github.com/a/b/pull/2/files",
          "https://github.com/a/b/pull/3",
          "https://github.com/A/B/pull/1",
        ],
      ),
    ).toEqual([
      "https://github.com/a/b/pull/1",
      "https://github.com/a/b/pull/2",
      "https://github.com/a/b/pull/3",
    ]);
  });
});

describe("formatPullRequestLinksForDiscord", () => {
  it("renders PR #N for same-repo PRs and prefixes foreign repos", () => {
    expect(
      formatPullRequestLinksForDiscord(
        [
          "https://github.com/example-org/scanner/pull/1950",
          "https://github.com/example-org/configurator/pull/123",
        ],
        { channelRepoSlug: "example-org/scanner" },
      ),
    ).toBe(
      [
        "**PRs**",
        "• [PR #1950](https://github.com/example-org/scanner/pull/1950)",
        "• [example-org/configurator PR #123](https://github.com/example-org/configurator/pull/123)",
      ].join("\n"),
    );
  });

  it("returns null for empty lists", () => {
    expect(formatPullRequestLinksForDiscord([])).toBeNull();
  });

  it("sorts current-project PRs above foreign repos while keeping first-seen order within groups", () => {
    expect(
      formatPullRequestLinksForDiscord(
        [
          "https://github.com/example-org/configurator/pull/10",
          "https://github.com/example-org/scanner/pull/2",
          "https://github.com/other/repo/pull/99",
          "https://github.com/example-org/scanner/pull/1",
          "https://github.com/example-org/configurator/pull/11",
        ],
        { channelRepoSlug: "example-org/scanner" },
      ),
    ).toBe(
      [
        "**PRs**",
        "• [PR #2](https://github.com/example-org/scanner/pull/2)",
        "• [PR #1](https://github.com/example-org/scanner/pull/1)",
        "• [example-org/configurator PR #10](https://github.com/example-org/configurator/pull/10)",
        "• [other/repo PR #99](https://github.com/other/repo/pull/99)",
        "• [example-org/configurator PR #11](https://github.com/example-org/configurator/pull/11)",
      ].join("\n"),
    );
  });
});

describe("sortPullRequestUrlsForDisplay", () => {
  it("leaves order unchanged when channel repo is unknown", () => {
    const urls = ["https://github.com/a/b/pull/1", "https://github.com/c/d/pull/2"];
    expect(sortPullRequestUrlsForDisplay(urls, null)).toEqual(urls);
  });
});
