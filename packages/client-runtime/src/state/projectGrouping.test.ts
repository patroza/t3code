import { describe, expect, it } from "@effect/vitest";

import { deriveProjectGroupLabel } from "./projectGrouping.ts";

const repositoryIdentity = (owner: string, name: string) => ({
  canonicalKey: `github.com/${owner}/${name}`,
  displayName: `${owner}/${name}`,
  name,
  owner,
  locator: {
    source: "git-remote" as const,
    remoteName: "origin",
    remoteUrl: `git@github.com:${owner}/${name}.git`,
  },
});

describe("deriveProjectGroupLabel", () => {
  it("prefers the short repository name over the owner-qualified display name", () => {
    const project = {
      title: "Custom title",
      repositoryIdentity: repositoryIdentity("pingdotgg", "t3code"),
    };

    expect(deriveProjectGroupLabel({ representative: project, members: [project] })).toBe("t3code");
  });

  it("falls back to the display name when a repository name is unavailable", () => {
    const { name: _name, ...identityWithoutName } = repositoryIdentity("macs-holding", "internal");
    const project = {
      title: "Custom title",
      repositoryIdentity: identityWithoutName,
    };

    expect(deriveProjectGroupLabel({ representative: project, members: [project] })).toBe(
      "macs-holding/internal",
    );
  });

  it("falls back to the representative title when there is no repository identity", () => {
    const project = {
      title: "Local sandbox",
      repositoryIdentity: null,
    };

    expect(deriveProjectGroupLabel({ representative: project, members: [project] })).toBe(
      "Local sandbox",
    );
  });

  it("falls back to the representative title when members disagree on repo names", () => {
    const left = {
      title: "Workspace title",
      repositoryIdentity: repositoryIdentity("pingdotgg", "t3code"),
    };
    const right = {
      title: "Workspace title",
      repositoryIdentity: repositoryIdentity("other", "different"),
    };

    expect(deriveProjectGroupLabel({ representative: left, members: [left, right] })).toBe(
      "Workspace title",
    );
  });
});
