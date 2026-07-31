import { describe, expect, it } from "vite-plus/test";

import {
  assignPullRequestAssignees,
  formatAssignSlashReply,
  parseAssignGithubOption,
  resolveAssignGithubLogin,
} from "./prAssign.ts";

describe("parseAssignGithubOption", () => {
  it("treats empty, @me, me, self as self", () => {
    expect(parseAssignGithubOption(undefined)).toEqual({ kind: "self" });
    expect(parseAssignGithubOption(null)).toEqual({ kind: "self" });
    expect(parseAssignGithubOption("")).toEqual({ kind: "self" });
    expect(parseAssignGithubOption("  ")).toEqual({ kind: "self" });
    expect(parseAssignGithubOption("@me")).toEqual({ kind: "self" });
    expect(parseAssignGithubOption("ME")).toEqual({ kind: "self" });
    expect(parseAssignGithubOption("self")).toEqual({ kind: "self" });
  });

  it("accepts logins with or without @", () => {
    expect(parseAssignGithubOption("MindfulLearner")).toEqual({
      kind: "login",
      login: "MindfulLearner",
    });
    expect(parseAssignGithubOption("@MindfulLearner")).toEqual({
      kind: "login",
      login: "MindfulLearner",
    });
  });

  it("rejects invalid logins", () => {
    expect(parseAssignGithubOption("-bad")).toMatchObject({ kind: "invalid" });
    expect(parseAssignGithubOption("has space")).toMatchObject({ kind: "invalid" });
  });
});

describe("resolveAssignGithubLogin", () => {
  const map = new Map<
    string,
    { readonly github?: { readonly login?: string | undefined } | undefined }
  >([
    ["111", { github: { login: "MindfulLearner" } }],
    ["222", {}],
  ]);

  it("returns explicit login without consulting the map", () => {
    expect(
      resolveAssignGithubLogin({
        githubOption: "@other-dev",
        requesterDiscordId: "111",
        resolveByDiscordId: (id) => map.get(id) ?? null,
      }),
    ).toEqual({ ok: true, login: "other-dev", source: "explicit" });
  });

  it("resolves @me via identity map", () => {
    expect(
      resolveAssignGithubLogin({
        githubOption: undefined,
        requesterDiscordId: "111",
        resolveByDiscordId: (id) => map.get(id) ?? null,
      }),
    ).toEqual({ ok: true, login: "MindfulLearner", source: "self" });
  });

  it("fails when unmapped or missing github login", () => {
    expect(
      resolveAssignGithubLogin({
        requesterDiscordId: "999",
        resolveByDiscordId: (id) => map.get(id) ?? null,
      }).ok,
    ).toBe(false);
    expect(
      resolveAssignGithubLogin({
        requesterDiscordId: "222",
        resolveByDiscordId: (id) => map.get(id) ?? null,
      }).ok,
    ).toBe(false);
  });
});

describe("assignPullRequestAssignees", () => {
  it("posts assignees for each valid PR and reports errors", async () => {
    const calls: string[][] = [];
    const results = await assignPullRequestAssignees({
      prUrls: [
        "https://github.com/acme/app/pull/12",
        "not-a-pr",
        "https://github.com/acme/app/pull/13",
      ],
      login: "MindfulLearner",
      execFile: async (_file, args) => {
        calls.push([...args]);
        if (args.includes("repos/acme/app/issues/13/assignees")) {
          throw new Error("HTTP 422: Validation Failed");
        }
        return { stdout: "", stderr: "" };
      },
    });

    expect(results).toEqual([
      { url: "https://github.com/acme/app/pull/12", status: "assigned" },
      { url: "not-a-pr", status: "skipped", detail: "not a github pull request url" },
      {
        url: "https://github.com/acme/app/pull/13",
        status: "error",
        detail: "HTTP 422: Validation Failed",
      },
    ]);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual([
      "api",
      "repos/acme/app/issues/12/assignees",
      "-X",
      "POST",
      "-f",
      "assignees[]=MindfulLearner",
    ]);
  });
});

describe("formatAssignSlashReply", () => {
  it("summarizes assigned and failed PRs", () => {
    const text = formatAssignSlashReply({
      login: "MindfulLearner",
      results: [
        { url: "https://github.com/a/b/pull/1", status: "assigned" },
        { url: "https://github.com/a/b/pull/2", status: "error", detail: "forbidden" },
      ],
    });
    expect(text).toContain("@MindfulLearner");
    expect(text).toContain("https://github.com/a/b/pull/1");
    expect(text).toContain("forbidden");
  });

  it("handles empty PR list", () => {
    expect(formatAssignSlashReply({ login: "x", results: [] })).toContain(
      "No linked pull requests",
    );
  });
});
