import { describe, expect, it } from "@effect/vitest";
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import {
  normalizeGitHubPullRequestRef,
  normalizeJiraIssueKey,
  resolveUniqueT3ThreadIdForWorkItems,
  serverWorkItemsPathFromStateSqlite,
} from "./ServerWorkItemJoin.ts";

describe("ServerWorkItemJoin", () => {
  it("normalizes keys and PR refs", () => {
    expect(normalizeJiraIssueKey("sa-401")).toBe("SA-401");
    expect(normalizeJiraIssueKey("UTF-8")).toBeNull();
    expect(normalizeGitHubPullRequestRef("https://github.com/Acme/Repo/pull/9")).toBe(
      "github.com/acme/repo/pull/9",
    );
  });

  it("joins unique server store hits and fails closed on ambiguity", () => {
    const dir = NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "work-item-join-"));
    const filePath = NodePath.join(dir, "thread-work-items.json");
    NodeFs.writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        records: [
          {
            threadId: "t-jira",
            jiraIssueKeys: ["SA-401"],
            githubPullRequests: [],
            sources: ["jira-webhook"],
            updatedAt: "2026-07-30T00:00:00.000Z",
          },
          {
            threadId: "t-other",
            jiraIssueKeys: ["SA-402"],
            githubPullRequests: ["github.com/acme/repo/pull/1"],
            sources: ["github-webhook"],
            updatedAt: "2026-07-30T00:00:00.000Z",
          },
        ],
      }),
    );

    expect(
      resolveUniqueT3ThreadIdForWorkItems({
        jiraIssueKeys: ["SA-401"],
        prUrls: [],
        discordLinks: [],
        serverWorkItemsPath: filePath,
      }),
    ).toBe("t-jira");

    expect(
      resolveUniqueT3ThreadIdForWorkItems({
        jiraIssueKeys: ["SA-401", "SA-402"],
        prUrls: [],
        discordLinks: [],
        serverWorkItemsPath: filePath,
      }),
    ).toBeNull();

    expect(serverWorkItemsPathFromStateSqlite("/var/lib/t3/userdata/state.sqlite")).toBe(
      "/var/lib/t3/userdata/thread-work-items.json",
    );
  });
});
