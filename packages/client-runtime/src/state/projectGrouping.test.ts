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
});
