// @effect-diagnostics nodeBuiltinImport:off
import type { ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { normalizeThreadLinkInput, type ThreadLink } from "./ThreadLinkStore.ts";
import {
  normalizeGitHubPullRequestRef,
  normalizeJiraIssueKey,
  resolveUniqueT3ThreadIdForWorkItems,
  serverWorkItemsPathFromStateSqlite,
} from "./ServerWorkItemJoin.ts";

function discordLink(t3ThreadId: string, status: "active" | "tombstone" = "active"): ThreadLink {
  return normalizeThreadLinkInput({
    discordThreadId: `discord-${t3ThreadId}`,
    t3ThreadId: t3ThreadId as ThreadId,
    projectId: "project-1" as ProjectId,
    channelId: "channel-1",
    guildId: "guild-1",
    createdAt: "2026-07-30T00:00:00.000Z",
    status,
  });
}

describe("ServerWorkItemJoin", () => {
  it("normalizes keys and PR refs", () => {
    expect(normalizeJiraIssueKey("sa-401")).toBe("SA-401");
    expect(normalizeJiraIssueKey("UTF-8")).toBeNull();
    expect(normalizeGitHubPullRequestRef("https://github.com/Acme/Repo/pull/9")).toBe(
      "github.com/acme/repo/pull/9",
    );
  });

  it("joins unique server store hits and fails closed on ambiguity", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "work-item-join-"));
    const filePath = NodePath.join(dir, "thread-work-items.json");
    NodeFS.writeFileSync(
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

  it("never joins a server work-item thread that already has an active Discord link", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "work-item-join-"));
    const filePath = NodePath.join(dir, "thread-work-items.json");
    NodeFS.writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        records: [
          {
            threadId: "t-pr",
            jiraIssueKeys: [],
            githubPullRequests: ["https://github.com/acme/repo/pull/9"],
          },
        ],
      }),
    );

    expect(
      resolveUniqueT3ThreadIdForWorkItems({
        jiraIssueKeys: [],
        prUrls: ["https://github.com/acme/repo/pull/9"],
        discordLinks: [discordLink("t-pr")],
        serverWorkItemsPath: filePath,
      }),
    ).toBeNull();

    expect(
      resolveUniqueT3ThreadIdForWorkItems({
        jiraIssueKeys: [],
        prUrls: ["https://github.com/acme/repo/pull/9"],
        discordLinks: [discordLink("t-pr", "tombstone")],
        serverWorkItemsPath: filePath,
      }),
    ).toBe("t-pr");
  });
});
