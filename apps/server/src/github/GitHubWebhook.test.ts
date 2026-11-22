// @effect-diagnostics nodeBuiltinImport:off -- Effect's Crypto has no createHmac or generateKeyPairSync.
import * as NodeBuffer from "node:buffer";
import * as NodeCrypto from "node:crypto";
import {
  ProjectId,
  SourceControlProviderKind,
  ThreadId,
  type ThreadPullRequestLinkSource,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import {
  buildGitHubTurnPrompt,
  githubPullRequestKey,
  hasRequiredGitHubPermission,
  isGitHubRepositoryAllowed,
  matchesGitHubRepository,
  selectPullRequestThread,
} from "./GitHubPrBridge.ts";
import {
  defaultGitHubThreadMode,
  type GitHubIssueCommentWebhook,
  type GitHubPullRequestReviewCommentWebhook,
  parseGitHubPrInvocation,
  parseGitHubReviewCommentInvocation,
  parseGitHubThreadMode,
} from "./GitHubWebhookPayload.ts";
import { createGitHubAppJwt, verifyGitHubWebhookSignature } from "./GitHubWebhookSecurity.ts";

function webhook(body = "@t3-code investigate the failing check"): GitHubIssueCommentWebhook {
  return {
    action: "created",
    installation: { id: 11 },
    repository: {
      id: 22,
      full_name: "acme/widgets",
      html_url: "https://github.com/acme/widgets",
    },
    issue: {
      number: 42,
      title: "Fix widgets",
      html_url: "https://github.com/acme/widgets/pull/42",
      pull_request: {},
    },
    comment: {
      id: 33,
      body,
      html_url: "https://github.com/acme/widgets/pull/42#issuecomment-33",
      user: { id: 44, login: "octocat", type: "User" },
    },
    sender: { id: 44, login: "octocat", type: "User" },
  };
}

function reviewCommentWebhook(
  body = "@t3-code please fix this null check",
): GitHubPullRequestReviewCommentWebhook {
  return {
    action: "created",
    installation: { id: 11 },
    repository: {
      id: 22,
      full_name: "acme/widgets",
      html_url: "https://github.com/acme/widgets",
    },
    pull_request: {
      number: 42,
      title: "Fix widgets",
      html_url: "https://github.com/acme/widgets/pull/42",
    },
    comment: {
      id: 3_628_634_093,
      body,
      html_url: "https://github.com/acme/widgets/pull/42#discussion_r3628634093",
      path: "src/widget.ts",
      line: 88,
      original_line: 88,
      side: "RIGHT",
      diff_hunk:
        "@@ -80,6 +80,10 @@ export function load() {\n+  const value = maybeNull()\n+  return value.name",
      commit_id: "abc123def456",
      user: { id: 44, login: "octocat", type: "User" },
    },
    sender: { id: 44, login: "octocat", type: "User" },
  };
}

describe("GitHub PR webhook", () => {
  it("verifies the raw webhook body signature", () => {
    const secret = "development-secret";
    const body = JSON.stringify(webhook());
    const signature = `sha256=${NodeCrypto.createHmac("sha256", secret).update(body).digest("hex")}`;

    expect(verifyGitHubWebhookSignature({ secret, body, signature })).toBe(true);
    expect(verifyGitHubWebhookSignature({ secret, body: `${body} `, signature })).toBe(false);
    expect(verifyGitHubWebhookSignature({ secret, body, signature: "sha256=bad" })).toBe(false);
  });

  it("parses an explicit PR invocation and preserves requester provenance", () => {
    const invocation = parseGitHubPrInvocation(webhook(), "t3-code");

    expect(invocation).toEqual({
      installationId: 11,
      repositoryId: 22,
      repository: "acme/widgets",
      pullRequestNumber: 42,
      pullRequestTitle: "Fix widgets",
      pullRequestUrl: "https://github.com/acme/widgets/pull/42",
      commentId: 33,
      commentUrl: "https://github.com/acme/widgets/pull/42#issuecomment-33",
      replyToCommentId: 33,
      commentSurface: "issue",
      actorId: 44,
      actorLogin: "octocat",
      prompt: "investigate the failing check",
      reviewContext: null,
    });
    const prompt = buildGitHubTurnPrompt(invocation!);
    expect(prompt.startsWith("<!--\n## GitHub pull request context")).toBe(true);
    expect(prompt).toContain(
      "\n\nFrom GH [octocat](https://github.com/octocat) on [PR #42](https://github.com/acme/widgets/pull/42#issuecomment-33): investigate the failing check",
    );
    expect(prompt).toContain("GitHub requester: octocat (id 44)");
    expect(prompt).toContain("Comment surface: issue");
    expect(prompt).toContain("Thread mode: sibling");
    expect(buildGitHubTurnPrompt(invocation!, { discordLinkRequested: true })).toContain(
      "T3 Discord link requested from GitHub: yes",
    );
    expect(buildGitHubTurnPrompt(invocation!, { threadMode: "main" })).toContain(
      "Thread mode: main",
    );
    expect(prompt).toContain(
      "Comment: https://github.com/acme/widgets/pull/42#issuecomment-33 (id 33)",
    );
    expect(prompt).not.toContain("## Request");
  });

  it("parses an inline review-comment invocation with file/line/diff context", () => {
    const invocation = parseGitHubReviewCommentInvocation(reviewCommentWebhook(), "t3-code");

    expect(invocation).toEqual({
      installationId: 11,
      repositoryId: 22,
      repository: "acme/widgets",
      pullRequestNumber: 42,
      pullRequestTitle: "Fix widgets",
      pullRequestUrl: "https://github.com/acme/widgets/pull/42",
      commentId: 3_628_634_093,
      commentUrl: "https://github.com/acme/widgets/pull/42#discussion_r3628634093",
      replyToCommentId: 3_628_634_093,
      commentSurface: "review",
      actorId: 44,
      actorLogin: "octocat",
      prompt: "please fix this null check",
      reviewContext: {
        path: "src/widget.ts",
        line: 88,
        originalLine: 88,
        side: "RIGHT",
        diffHunk:
          "@@ -80,6 +80,10 @@ export function load() {\n+  const value = maybeNull()\n+  return value.name",
        commitId: "abc123def456",
      },
    });

    // Nested replies must anchor the bot response to the top-level review comment.
    const nested = parseGitHubReviewCommentInvocation(
      {
        ...reviewCommentWebhook("@t3-code follow up"),
        comment: {
          ...reviewCommentWebhook().comment,
          id: 99,
          body: "@t3-code follow up",
          html_url: "https://github.com/acme/widgets/pull/42#discussion_r99",
          in_reply_to_id: 3_628_634_093,
        },
      },
      "t3-code",
    );
    expect(nested?.commentId).toBe(99);
    expect(nested?.replyToCommentId).toBe(3_628_634_093);

    const prompt = buildGitHubTurnPrompt(invocation!);
    expect(prompt).toContain("Comment surface: review");
    expect(prompt).toContain("File: src/widget.ts");
    expect(prompt).toContain("Line: 88");
    expect(prompt).toContain("Side: RIGHT");
    expect(prompt).toContain("```diff");
    expect(prompt).toContain("return value.name");
    expect(prompt).toContain("inline review thread");
    expect(prompt).toContain(
      "From GH [octocat](https://github.com/octocat) on [PR #42](https://github.com/acme/widgets/pull/42#discussion_r3628634093): please fix this null check",
    );
  });

  it("parses thread mode flags; unspecified leaves mode null for surface defaults", () => {
    expect(parseGitHubThreadMode("main-thread finish the remaining tests")).toEqual({
      mode: "main",
      prompt: "finish the remaining tests",
    });
    expect(parseGitHubThreadMode("--thread main implement the plan")).toEqual({
      mode: "main",
      prompt: "implement the plan",
    });
    expect(parseGitHubThreadMode("--main-thread why is this red")).toEqual({
      mode: "main",
      prompt: "why is this red",
    });
    expect(parseGitHubThreadMode("what's the semaphore for?")).toEqual({
      mode: null,
      prompt: "what's the semaphore for?",
    });
    expect(parseGitHubThreadMode("--thread sibling explain this")).toEqual({
      mode: "sibling",
      prompt: "explain this",
    });
    expect(parseGitHubThreadMode("sibling-thread quick question")).toEqual({
      mode: "sibling",
      prompt: "quick question",
    });
    expect(parseGitHubThreadMode("main-thread")).toEqual({
      mode: "main",
      prompt: "",
    });
  });

  it("defaults conversation to main and inline review to sibling", () => {
    expect(defaultGitHubThreadMode("issue")).toBe("main");
    expect(defaultGitHubThreadMode("review")).toBe("sibling");
  });

  it("ignores non-mentions, empty prompts, issue comments, and bots", () => {
    expect(parseGitHubPrInvocation(webhook("please investigate"), "t3-code")).toBeNull();
    expect(parseGitHubPrInvocation(webhook("@t3-code"), "t3-code")).toBeNull();
    expect(
      parseGitHubPrInvocation(
        { ...webhook(), issue: { ...webhook().issue, pull_request: undefined } },
        "t3-code",
      ),
    ).toBeNull();
    expect(
      parseGitHubPrInvocation(
        { ...webhook(), sender: { id: 55, login: "robot", type: "Bot" } },
        "t3-code",
      ),
    ).toBeNull();
  });

  it("ignores non-mentions, empty prompts, and bots on review comments", () => {
    expect(
      parseGitHubReviewCommentInvocation(reviewCommentWebhook("please fix"), "t3-code"),
    ).toBeNull();
    expect(
      parseGitHubReviewCommentInvocation(reviewCommentWebhook("@t3-code"), "t3-code"),
    ).toBeNull();
    expect(
      parseGitHubReviewCommentInvocation(
        { ...reviewCommentWebhook(), action: "edited" },
        "t3-code",
      ),
    ).toBeNull();
    expect(
      parseGitHubReviewCommentInvocation(
        {
          ...reviewCommentWebhook(),
          sender: { id: 55, login: "robot", type: "Bot" },
        },
        "t3-code",
      ),
    ).toBeNull();
  });

  it("matches GitHub webhook repositories to project repository identities", () => {
    expect(
      matchesGitHubRepository(
        {
          canonicalKey: "github.com/example-org/example-repo",
          locator: {
            source: "git-remote",
            remoteName: "origin",
            remoteUrl: "git@github.com:example-org/example-repo.git",
          },
          provider: SourceControlProviderKind.make("github"),
          owner: "patroza",
          name: "example-repo",
        },
        "Example-Org/Example-Repo",
      ),
    ).toBe(true);
    expect(
      matchesGitHubRepository(
        {
          canonicalKey: "github.com/patroza/t3code",
          locator: {
            source: "git-remote",
            remoteName: "origin",
            remoteUrl: "git@github.com:patroza/t3code.git",
          },
          provider: SourceControlProviderKind.make("github"),
          owner: "patroza",
          name: "t3code",
        },
        "example-org/example-repo",
      ),
    ).toBe(false);
  });

  it("matches a fork against its origin as well as the primary upstream remote", () => {
    // A fork checkout's primary identity is `upstream`; the fork itself is the identity's
    // origin, so webhooks from the fork only match through it.
    const forkIdentity = {
      canonicalKey: "github.com/pingdotgg/t3code",
      locator: {
        source: "git-remote" as const,
        remoteName: "upstream",
        remoteUrl: "https://github.com/pingdotgg/t3code.git",
      },
      provider: SourceControlProviderKind.make("github"),
      owner: "pingdotgg",
      name: "t3code",
      origin: {
        canonicalKey: "github.com/example-org/example-repo",
        remoteUrl: "https://github.com/example-org/example-repo.git",
      },
    };

    expect(matchesGitHubRepository(forkIdentity, "example-org/example-repo")).toBe(true);
    expect(matchesGitHubRepository(forkIdentity, "pingdotgg/t3code")).toBe(true);
    expect(matchesGitHubRepository(forkIdentity, "someone/unrelated")).toBe(false);
  });

  it("ignores non-GitHub remotes when matching", () => {
    expect(
      matchesGitHubRepository(
        {
          canonicalKey: "gitlab.com/example-org/example-repo",
          locator: {
            source: "git-remote",
            remoteName: "origin",
            remoteUrl: "git@gitlab.com:example-org/example-repo.git",
          },
          provider: SourceControlProviderKind.make("gitlab"),
          owner: "example-org",
          name: "example-repo",
          origin: {
            canonicalKey: "gitlab.com/example-org/example-repo",
            remoteUrl: "git@gitlab.com:example-org/example-repo.git",
          },
        },
        "example-org/example-repo",
      ),
    ).toBe(false);
  });

  it("checks the repository allowlist case-insensitively", () => {
    expect(isGitHubRepositoryAllowed(new Set(), "acme/widgets")).toBe(true);
    expect(isGitHubRepositoryAllowed(new Set(["acme/widgets"]), "Acme/Widgets")).toBe(true);
    expect(isGitHubRepositoryAllowed(new Set(["acme/widgets"]), "acme/other")).toBe(false);
  });

  it("allows every repository under an owner/* entry", () => {
    const allowed = new Set(["patroza/*", "macs-holding/*"]);
    expect(isGitHubRepositoryAllowed(allowed, "patroza/effect")).toBe(true);
    expect(isGitHubRepositoryAllowed(allowed, "Patroza/T3code")).toBe(true);
    expect(isGitHubRepositoryAllowed(allowed, "macs-holding/scanner")).toBe(true);
    expect(isGitHubRepositoryAllowed(allowed, "effect-app/libs")).toBe(false);
    expect(isGitHubRepositoryAllowed(allowed, "patroza")).toBe(false);
    expect(isGitHubRepositoryAllowed(allowed, "patroza/")).toBe(false);
    expect(isGitHubRepositoryAllowed(new Set(["acme/widgets", "patroza/*"]), "acme/widgets")).toBe(
      true,
    );
    expect(isGitHubRepositoryAllowed(new Set(["acme/widgets", "patroza/*"]), "acme/other")).toBe(
      false,
    );
  });

  it("orders GitHub repository permissions", () => {
    expect(hasRequiredGitHubPermission("write", "write")).toBe(true);
    expect(hasRequiredGitHubPermission("admin", "write")).toBe(true);
    expect(hasRequiredGitHubPermission("triage", "write")).toBe(false);
    expect(hasRequiredGitHubPermission("unknown", "read")).toBe(false);
  });

  it("creates a GitHub App JWT with a valid RSA signature", () => {
    const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });
    const jwt = createGitHubAppJwt({
      appId: "123",
      privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      nowSeconds: 1_700_000_000,
    });
    const [header, payload, signature] = jwt.split(".");

    expect(
      NodeCrypto.verify(
        "RSA-SHA256",
        NodeBuffer.Buffer.from(`${header}.${payload}`),
        publicKey,
        NodeBuffer.Buffer.from(signature!, "base64url"),
      ),
    ).toBe(true);
    expect(
      JSON.parse(NodeBuffer.Buffer.from(payload!, "base64url").toString("utf8")),
    ).toMatchObject({ iss: "123", iat: 1_699_999_940, exp: 1_700_000_540 });
  });
});

const PR_URL = "https://github.com/acme/widgets/pull/42";

function candidate(input: {
  readonly id: string;
  readonly createdAt: string;
  readonly link?: { readonly number?: number; readonly source: ThreadPullRequestLinkSource };
  readonly branchNumber?: number;
  readonly archived?: boolean;
  readonly subagent?: boolean;
}) {
  const id = ThreadId.make(input.id);
  return {
    id,
    archivedAt: input.archived ? DateTime.makeUnsafe("2026-07-23T00:00:00.000Z") : null,
    createdAt: DateTime.makeUnsafe(input.createdAt),
    lineage: {
      parentThreadId: null,
      relationshipToParent: input.subagent ? ("subagent" as const) : null,
      rootThreadId: id,
    },
    pullRequests:
      input.link === undefined
        ? []
        : [
            {
              host: "github.com",
              repository: "acme/widgets",
              number: input.link.number ?? 42,
              url: `https://github.com/acme/widgets/pull/${input.link.number ?? 42}`,
              source: input.link.source,
              linkedAt: "2026-07-22T00:00:00.000Z",
              snapshot: null,
              stack: null,
            },
          ],
    branchPullRequest:
      input.branchNumber === undefined
        ? null
        : {
            projectId: ProjectId.make("project-1"),
            repository: "acme/widgets",
            number: input.branchNumber,
            url: `https://github.com/acme/widgets/pull/${input.branchNumber}`,
          },
  };
}

describe("GitHub PR thread selection", () => {
  const key = githubPullRequestKey({
    repository: "Acme/Widgets",
    pullRequestNumber: 42,
    pullRequestUrl: PR_URL,
  });

  it("joins the thread that opened the PR over older explicit and branch-only links", () => {
    const selected = selectPullRequestThread(
      [
        candidate({ id: "branch-only", createdAt: "2026-07-20T00:00:00.000Z", branchNumber: 42 }),
        candidate({
          id: "linked",
          createdAt: "2026-07-20T00:00:00.000Z",
          link: { source: "manual" },
        }),
        candidate({
          id: "opener",
          createdAt: "2026-07-21T00:00:00.000Z",
          link: { source: "created" },
        }),
      ],
      key,
    );
    expect(selected?.id).toBe("opener");
  });

  it("prefers an explicit link to a branch match, then the oldest thread", () => {
    expect(
      selectPullRequestThread(
        [
          candidate({ id: "sibling", createdAt: "2026-07-19T00:00:00.000Z", branchNumber: 42 }),
          candidate({
            id: "newer",
            createdAt: "2026-07-22T00:00:00.000Z",
            link: { source: "agent" },
          }),
          candidate({
            id: "older",
            createdAt: "2026-07-21T00:00:00.000Z",
            link: { source: "agent" },
          }),
        ],
        key,
      )?.id,
    ).toBe("older");
  });

  it("ignores other PRs, dismissed links, archived threads, and subagents", () => {
    expect(
      selectPullRequestThread(
        [
          candidate({ id: "other-pr", createdAt: "2026-07-20T00:00:00.000Z", branchNumber: 41 }),
          candidate({
            id: "dismissed",
            createdAt: "2026-07-20T00:00:00.000Z",
            link: { source: "stack-dismissed" },
          }),
          candidate({
            id: "archived",
            createdAt: "2026-07-20T00:00:00.000Z",
            link: { source: "created" },
            archived: true,
          }),
          candidate({
            id: "child",
            createdAt: "2026-07-20T00:00:00.000Z",
            link: { source: "created" },
            subagent: true,
          }),
        ],
        key,
      ),
    ).toBeNull();
  });
});
