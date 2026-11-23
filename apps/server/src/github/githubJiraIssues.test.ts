import {
  IssueTrackerKind,
  ProjectId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import {
  ThreadIssueService,
  type LinkThreadIssueInput,
} from "../orchestration-v2/ThreadIssueService.ts";
import { githubPullRequestKey, selectMainPullRequestThread } from "./GitHubPrBridge.ts";
import {
  extractGitHubJiraIssueKeys,
  linkJiraIssuesToThread,
  selectJiraLinkedThread,
} from "./githubJiraIssues.ts";

const SITE_HOST = "acme.atlassian.net";
const PR_URL = "https://github.com/acme/widgets/pull/42";

function thread(input: {
  readonly id: string;
  readonly jiraKeys?: ReadonlyArray<string>;
  readonly jiraHost?: string;
  readonly prLinked?: boolean;
  readonly archived?: boolean;
  readonly sideChat?: boolean;
  readonly subagent?: boolean;
}) {
  const id = ThreadId.make(input.id);
  return {
    id,
    archivedAt: input.archived ? DateTime.makeUnsafe("2026-11-20T00:00:00.000Z") : null,
    createdAt: DateTime.makeUnsafe("2026-11-01T00:00:00.000Z"),
    lineage: {
      parentThreadId: null,
      relationshipToParent: input.subagent ? ("subagent" as const) : null,
      rootThreadId: id,
      ...(input.sideChat ? { sideChat: true } : {}),
    },
    pullRequests: input.prLinked
      ? [
          {
            host: "github.com",
            repository: "acme/widgets",
            number: 42,
            url: PR_URL,
            source: "agent" as const,
            linkedAt: "2026-11-02T00:00:00.000Z",
            snapshot: null,
            stack: null,
          },
        ]
      : [],
    branchPullRequest: null,
    issues: (input.jiraKeys ?? []).map((key) => ({
      tracker: IssueTrackerKind.make("jira"),
      host: input.jiraHost ?? SITE_HOST,
      scope: key.split("-")[0]!,
      key,
      projectId: ProjectId.make("project-1"),
      url: `https://${SITE_HOST}/browse/${key}`,
      source: "agent" as const,
      linkedAt: "2026-11-02T00:00:00.000Z",
      displayKey: key,
      title: key,
    })),
  } satisfies Partial<OrchestrationV2ThreadShell>;
}

describe("extractGitHubJiraIssueKeys", () => {
  it("counts bare keys only for the repo's jiraProjects, links for any project", () => {
    const invocation = {
      pullRequestTitle: "SA-12: fix the scanner (CFG-7, UTF-8)",
      prompt: "also see https://acme.atlassian.net/browse/OPS-3 and sa-99",
    };
    expect(extractGitHubJiraIssueKeys(invocation, [])).toEqual(["OPS-3"]);
    expect(extractGitHubJiraIssueKeys(invocation, ["sa"])).toEqual(["SA-12", "OPS-3"]);
  });

  it("reads keys from the comment as well as the title, first seen first, once each", () => {
    expect(
      extractGitHubJiraIssueKeys(
        { pullRequestTitle: "Refactor", prompt: "Continue SA-5, then SA-4 and SA-5 again" },
        ["SA"],
      ),
    ).toEqual(["SA-5", "SA-4"]);
  });
});

describe("selectJiraLinkedThread", () => {
  it("skips archived threads, side chats, subagents, and links on another Jira site", () => {
    const threads = [
      thread({ id: "archived", jiraKeys: ["SA-1"], archived: true }),
      thread({ id: "side", jiraKeys: ["SA-1"], sideChat: true }),
      thread({ id: "sub", jiraKeys: ["SA-1"], subagent: true }),
      thread({ id: "other-site", jiraKeys: ["SA-1"], jiraHost: "other.atlassian.net" }),
      thread({ id: "live", jiraKeys: ["SA-1"] }),
    ];
    const selected = selectJiraLinkedThread(threads, ["SA-1"], SITE_HOST);
    expect(selected._tag === "linked" && selected.thread.id).toBe("live");
  });

  it("does not guess when the keys lead to more than one thread", () => {
    const threads = [
      thread({ id: "a", jiraKeys: ["SA-1"] }),
      thread({ id: "b", jiraKeys: ["SA-2"] }),
    ];
    expect(selectJiraLinkedThread(threads, ["SA-1", "SA-2"], SITE_HOST)).toEqual({
      _tag: "ambiguous",
      threadIds: ["a", "b"],
    });
  });
});

describe("selectMainPullRequestThread", () => {
  const key = githubPullRequestKey({
    repository: "acme/widgets",
    pullRequestNumber: 42,
    pullRequestUrl: PR_URL,
  });
  const jira = { issueKeys: ["SA-1"], siteHost: SITE_HOST };

  it("keeps the thread already linked to the PR over a Jira-linked one", () => {
    const selected = selectMainPullRequestThread(
      [thread({ id: "jira", jiraKeys: ["SA-1"] }), thread({ id: "pr", prLinked: true })],
      key,
      jira,
    );
    expect(selected).toMatchObject({ thread: { id: "pr" }, via: "pull-request" });
  });

  it("joins the Jira-linked thread when no thread has the PR", () => {
    const selected = selectMainPullRequestThread(
      [thread({ id: "jira", jiraKeys: ["SA-1"] }), thread({ id: "unrelated" })],
      key,
      jira,
    );
    expect(selected).toMatchObject({ thread: { id: "jira" }, via: "jira" });
  });

  it("falls through to provisioning when the Jira keys are ambiguous", () => {
    const selected = selectMainPullRequestThread(
      [thread({ id: "a", jiraKeys: ["SA-1"] }), thread({ id: "b", jiraKeys: ["SA-1"] })],
      key,
      jira,
    );
    expect(selected).toEqual({ thread: null, via: null });
  });
});

describe("linkJiraIssuesToThread", () => {
  const recordLinks = (siteUrl: string | undefined) =>
    Effect.gen(function* () {
      const linked: Array<LinkThreadIssueInput> = [];
      yield* linkJiraIssuesToThread({
        threadId: ThreadId.make("thread-1"),
        projectId: ProjectId.make("project-1"),
        issueKeys: ["SA-1", "CFG-22"],
        siteUrl,
      }).pipe(
        Effect.provideService(
          ThreadIssueService,
          ThreadIssueService.of({
            link: (input) =>
              Effect.sync(() => linked.push(input)).pipe(Effect.as({ alreadyLinked: false })),
            unlink: () => Effect.die("unused"),
            linkedThreads: () => Effect.die("unused"),
          }),
        ),
      );
      return linked;
    });

  it.effect("links each key under the Jira site the Jira bridge uses", () =>
    Effect.gen(function* () {
      const linked = yield* recordLinks("https://Acme.atlassian.net/");
      expect(linked.map((input) => [input.ref, input.url])).toEqual([
        [
          {
            tracker: "jira",
            host: SITE_HOST,
            scope: "SA",
            key: "SA-1",
            projectId: "project-1",
          },
          "https://Acme.atlassian.net/browse/SA-1",
        ],
        [
          {
            tracker: "jira",
            host: SITE_HOST,
            scope: "CFG",
            key: "CFG-22",
            projectId: "project-1",
          },
          "https://Acme.atlassian.net/browse/CFG-22",
        ],
      ]);
    }),
  );

  it.effect("links nothing without a Jira site, since a link must name its host", () =>
    Effect.gen(function* () {
      expect(yield* recordLinks(undefined)).toEqual([]);
    }),
  );
});
