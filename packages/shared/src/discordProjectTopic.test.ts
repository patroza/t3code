import type { RepositoryIdentity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  githubRepositoryRefsOf,
  parseTopicGithubRepository,
  parseTopicProjectBinding,
  parseTopicShortName,
  selectProjectForGithubRepository,
  topicHasProjectBinding,
} from "./discordProjectTopic.ts";

function identity(
  input: Partial<RepositoryIdentity> & Pick<RepositoryIdentity, "canonicalKey">,
): RepositoryIdentity {
  return {
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: `https://${input.canonicalKey}.git`,
    },
    ...input,
  };
}

describe("parseTopicShortName", () => {
  it("prefers omegent-link- project tags and still reads legacy t3- tags", () => {
    expect(parseTopicShortName("omegent-link-example-project")).toBe("example-project");
    expect(parseTopicShortName("OMEGENT-LINK-Example-Project")).toBe("example-project");
    expect(parseTopicShortName("t3-example-project")).toBe("example-project");
    expect(parseTopicShortName("omegent-link-scanner t3-other")).toBe("scanner");
    expect(parseTopicShortName("omegent-example-project")).toBeNull();
    expect(parseTopicShortName("omegent-ips")).toBeNull();
    expect(parseTopicShortName("t3-ips")).toBeNull();
    expect(parseTopicShortName("notes omegent-ips t3-example")).toBe("example");
  });

  it("does not read a GitHub repository tag as the short name github", () => {
    expect(parseTopicShortName("omegent-link-github:Macs-Holding/Scanner")).toBeNull();
    expect(parseTopicShortName("omegent-link-github:acme/app omegent-link-scanner")).toBe(
      "scanner",
    );
  });
});

describe("parseTopicProjectBinding", () => {
  it("reads a GitHub org/repo tag and prefers it over a short name", () => {
    expect(parseTopicGithubRepository("ops omegent-link-github:Macs-Holding/Scanner")).toEqual({
      owner: "macs-holding",
      repo: "scanner",
    });
    expect(
      parseTopicProjectBinding("omegent-link-github:acme/app omegent-link-scanner t3-other"),
    ).toEqual({
      kind: "github",
      repository: { owner: "acme", repo: "app" },
    });
    expect(parseTopicProjectBinding("omegent-link-scanner")).toEqual({
      kind: "shortName",
      shortName: "scanner",
    });
    expect(parseTopicProjectBinding("omegent-link-github:acme/app/extra")).toBeNull();
    expect(parseTopicProjectBinding("omegent-link-github:")).toBeNull();
    expect(topicHasProjectBinding("t3-scanner")).toBe(true);
    expect(topicHasProjectBinding("no tag")).toBe(false);
  });
});

describe("selectProjectForGithubRepository", () => {
  const scanner = {
    title: "Scanner",
    repositoryIdentity: identity({
      canonicalKey: "github.com/macs-holding/scanner",
      provider: "github",
      owner: "macs-holding",
      name: "scanner",
    }),
  };
  const fork = {
    title: "T3 fork",
    repositoryIdentity: identity({
      canonicalKey: "github.com/pingdotgg/t3code",
      provider: "github",
      owner: "pingdotgg",
      name: "t3code",
      origin: { canonicalKey: "github.com/patroza/t3code", displayName: "patroza/t3code" },
      remotes: [
        {
          remoteName: "upstream",
          remoteUrl: "https://github.com/pingdotgg/t3code.git",
          canonicalKey: "github.com/pingdotgg/t3code",
          provider: "github",
          owner: "pingdotgg",
          name: "t3code",
        },
        {
          remoteName: "origin",
          remoteUrl: "https://github.com/patroza/t3code.git",
          canonicalKey: "github.com/patroza/t3code",
          provider: "github",
          owner: "patroza",
          name: "t3code",
        },
      ],
    }),
  };

  it("matches the project's own repository ahead of a remote", () => {
    expect(
      selectProjectForGithubRepository([fork, scanner], { owner: "macs-holding", repo: "scanner" }),
    ).toMatchObject({ kind: "match", project: scanner, rank: "primary" });
    expect(
      selectProjectForGithubRepository([fork], { owner: "patroza", repo: "t3code" }),
    ).toMatchObject({ kind: "match", project: fork, rank: "origin" });
    expect(
      selectProjectForGithubRepository([fork], { owner: "pingdotgg", repo: "t3code" }),
    ).toMatchObject({ kind: "match", rank: "primary" });
  });

  it("does not treat a GitLab path as that GitHub repository", () => {
    const gitlab = {
      repositoryIdentity: identity({
        canonicalKey: "gitlab.com/macs-holding/scanner",
        provider: "gitlab",
        owner: "macs-holding",
        name: "scanner",
      }),
    };
    expect(
      selectProjectForGithubRepository([gitlab], { owner: "macs-holding", repo: "scanner" }).kind,
    ).toBe("none");
  });

  it("reports more than one primary checkout", () => {
    const other = { ...scanner, title: "Scanner copy" };
    const selected = selectProjectForGithubRepository([scanner, other], {
      owner: "macs-holding",
      repo: "scanner",
    });
    expect(selected.kind).toBe("ambiguous");
    if (selected.kind === "ambiguous") {
      expect(selected.projects.map((project) => project.title)).toEqual([
        "Scanner",
        "Scanner copy",
      ]);
    }
  });

  it("lists the GitHub repositories a checkout answers to", () => {
    expect(githubRepositoryRefsOf(fork.repositoryIdentity)).toEqual([
      { owner: "pingdotgg", repo: "t3code" },
      { owner: "patroza", repo: "t3code" },
    ]);
    expect(githubRepositoryRefsOf(null)).toEqual([]);
  });
});
