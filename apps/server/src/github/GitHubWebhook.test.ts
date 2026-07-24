import * as NodeBuffer from "node:buffer";
import * as NodeCrypto from "node:crypto";
import { describe, expect, it } from "@effect/vitest";

import {
  buildGitHubTurnPrompt,
  discoverGitHubTargetTurnId,
  githubFinalAnswerText,
  githubFinalAnswerWithStats,
  hasRequiredGitHubPermission,
  isGitHubRepositoryAllowed,
  liveWorktreeRef,
  matchesGitHubRepository,
  resolveGitHubBridgeTurnOutcome,
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
    expect(
      buildGitHubTurnPrompt(invocation!, {
        stackContext: {
          source: "github",
          stackNumber: 7,
          baseBranch: "main",
          pullRequests: [
            { number: 41, headBranch: "feature-core", headSha: "abc" },
            { number: 42, headBranch: "feature-ui", headSha: "def" },
          ],
        },
      }),
    ).toContain(
      "GitHub stack: #7\nStack base: main\nStack PRs (bottom to top): #41 feature-core -> #42 feature-ui (requested)",
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

  it("uses the live worktree branch when the thread projection is stale", () => {
    expect(
      liveWorktreeRef(
        {
          branch: "merged-parent-branch",
          worktreePath: "/worktrees/feature",
        },
        {
          isRepo: true,
          refName: "stacked-pr-branch",
        },
      ),
    ).toEqual({
      cwd: "/worktrees/feature",
      refName: "stacked-pr-branch",
    });
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
          provider: "github",
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
          provider: "github",
          owner: "patroza",
          name: "t3code",
        },
        "example-org/example-repo",
      ),
    ).toBe(false);
  });

  it("matches a fork against every remote, not just the primary one", () => {
    // A fork checkout keeps `origin` on the fork and `upstream` on the repository it
    // was forked from. The identity's primary fields describe `upstream`, so webhooks
    // from `origin` only match through the remotes list.
    const forkIdentity = {
      canonicalKey: "github.com/pingdotgg/t3code",
      locator: {
        source: "git-remote" as const,
        remoteName: "upstream",
        remoteUrl: "https://github.com/pingdotgg/t3code.git",
      },
      provider: "github",
      owner: "pingdotgg",
      name: "t3code",
      remotes: [
        {
          remoteName: "origin",
          remoteUrl: "https://github.com/example-org/example-repo.git",
          canonicalKey: "github.com/example-org/example-repo",
          provider: "github",
          owner: "patroza",
          name: "example-repo",
        },
        {
          remoteName: "upstream",
          remoteUrl: "https://github.com/pingdotgg/t3code.git",
          canonicalKey: "github.com/pingdotgg/t3code",
          provider: "github",
          owner: "pingdotgg",
          name: "t3code",
        },
      ],
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
          provider: "gitlab",
          owner: "patroza",
          name: "example-repo",
          remotes: [
            {
              remoteName: "origin",
              remoteUrl: "git@gitlab.com:example-org/example-repo.git",
              canonicalKey: "gitlab.com/example-org/example-repo",
              provider: "gitlab",
              owner: "patroza",
              name: "example-repo",
            },
          ],
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

function message(input: {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly turnId: string | null;
  readonly streaming?: boolean;
}) {
  return {
    id: input.id,
    role: input.role,
    text: input.text,
    turnId: input.turnId,
    streaming: input.streaming ?? false,
    createdAt: "2026-07-22T00:00:00.000Z",
    updatedAt: "2026-07-22T00:00:00.000Z",
  };
}

function threadFixture(input: {
  readonly messages: ReadonlyArray<ReturnType<typeof message>>;
  readonly latestTurn?: {
    readonly turnId: string;
    readonly state: "running" | "completed" | "interrupted" | "error";
  } | null;
  readonly session?: {
    readonly status:
      | "running"
      | "ready"
      | "starting"
      | "idle"
      | "interrupted"
      | "stopped"
      | "error";
    readonly activeTurnId: string | null;
  } | null;
  readonly checkpoints?: ReadonlyArray<{ readonly turnId: string }>;
  readonly modelSelection?: {
    readonly instanceId: string;
    readonly model: string;
    readonly options?: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }>;
  };
  readonly activities?: ReadonlyArray<{
    readonly kind: string;
    readonly turnId: string | null;
    readonly payload: unknown;
  }>;
}) {
  return {
    id: "thread-1",
    projectId: "project-1",
    title: "PR #1",
    modelSelection: input.modelSelection ?? {
      instanceId: "codex",
      model: "gpt-5.4",
      options: [],
    },
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    branch: "feature",
    worktreePath: "/tmp/wt",
    latestTurn:
      input.latestTurn === undefined
        ? null
        : input.latestTurn === null
          ? null
          : {
              turnId: input.latestTurn.turnId,
              state: input.latestTurn.state,
              requestedAt: "2026-07-22T00:00:00.000Z",
              startedAt: "2026-07-22T00:00:00.000Z",
              completedAt: input.latestTurn.state === "running" ? null : "2026-07-22T00:01:00.000Z",
              assistantMessageId: null,
            },
    createdAt: "2026-07-22T00:00:00.000Z",
    updatedAt: "2026-07-22T00:01:00.000Z",
    archivedAt: null,
    deletedAt: null,
    messages: input.messages,
    proposedPlans: [],
    activities: input.activities ?? [],
    checkpoints: (input.checkpoints ?? []).map((checkpoint) => ({
      turnId: checkpoint.turnId,
      checkpointTurnCount: 1,
      checkpointRef: null,
      status: "ready" as const,
      files: [],
      assistantMessageId: null,
      completedAt: "2026-07-22T00:01:00.000Z",
    })),
    session:
      input.session === undefined
        ? null
        : input.session === null
          ? null
          : {
              status: input.session.status,
              providerName: "codex",
              providerInstanceId: "codex",
              providerSessionId: null,
              providerThreadId: null,
              activeTurnId: input.session.activeTurnId,
              lastError: null,
              updatedAt: "2026-07-22T00:01:00.000Z",
              runtimeMode: "full-access" as const,
            },
  } as never;
}

describe("GitHub PR response bridge turn resolution", () => {
  it("discovers the target turn from the dispatched user message", () => {
    const thread = threadFixture({
      messages: [
        message({ id: "u0", role: "user", text: "prior", turnId: null }),
        message({ id: "a0", role: "assistant", text: "prior answer", turnId: "turn-0" }),
        message({ id: "u1", role: "user", text: "From GH: plan", turnId: null }),
        message({ id: "a1", role: "assistant", text: "working", turnId: "turn-1" }),
        message({ id: "a2", role: "assistant", text: "final plan body", turnId: "turn-1" }),
      ],
      latestTurn: { turnId: "turn-1", state: "completed" },
    });

    expect(
      discoverGitHubTargetTurnId(thread, {
        userMessageId: "u1",
        previousTurnId: "turn-0",
        knownTargetTurnId: null,
      }),
    ).toBe("turn-1");
    expect(githubFinalAnswerText(thread, "turn-1")).toBe("final plan body");
  });

  it("finalizes a completed target turn even when latestTurn is wiped null", () => {
    const thread = threadFixture({
      messages: [
        message({ id: "u1", role: "user", text: "From GH: plan", turnId: null }),
        message({
          id: "a1",
          role: "assistant",
          text: "Implementation plan added and pushed.",
          turnId: "turn-1",
        }),
      ],
      latestTurn: null,
      session: { status: "ready", activeTurnId: null },
      checkpoints: [{ turnId: "turn-1" }],
    });

    expect(
      resolveGitHubBridgeTurnOutcome(thread, {
        userMessageId: "u1",
        previousTurnId: null,
        knownTargetTurnId: "turn-1",
      }),
    ).toEqual({
      _tag: "terminal",
      status: "completed",
      body: "Implementation plan added and pushed.\n\n_`gpt-5.4`_",
      targetTurnId: "turn-1",
    });
  });

  it("does not post a later Discord wake-up answer for an earlier GitHub turn", () => {
    const thread = threadFixture({
      messages: [
        message({ id: "u1", role: "user", text: "From GH: plan", turnId: null }),
        message({
          id: "a1",
          role: "assistant",
          text: "Original GH final answer with the real plan details.",
          turnId: "turn-1",
        }),
        message({ id: "u2", role: "user", text: "repeat", turnId: null }),
        message({
          id: "a2",
          role: "assistant",
          text: "Wake-up re-summary that should not replace the GH answer.",
          turnId: "turn-2",
        }),
      ],
      latestTurn: { turnId: "turn-2", state: "completed" },
      session: { status: "ready", activeTurnId: null },
    });

    const outcome = resolveGitHubBridgeTurnOutcome(thread, {
      userMessageId: "u1",
      previousTurnId: null,
      knownTargetTurnId: "turn-1",
    });
    expect(outcome).toEqual({
      _tag: "terminal",
      status: "completed",
      // Stats omit duration when latestTurn is a different turn; model still attaches.
      body: "Original GH final answer with the real plan details.\n\n_`gpt-5.4`_",
      targetTurnId: "turn-1",
    });
    expect(githubFinalAnswerText(thread)).toBe(
      "Wake-up re-summary that should not replace the GH answer.",
    );
  });

  it("appends model, effort, duration, and token stats to completed GitHub answers", () => {
    const thread = threadFixture({
      messages: [
        message({ id: "u1", role: "user", text: "From GH: plan", turnId: null }),
        message({
          id: "a1",
          role: "assistant",
          text: "Ship it.",
          turnId: "turn-1",
        }),
      ],
      latestTurn: { turnId: "turn-1", state: "completed" },
      modelSelection: {
        instanceId: "codex",
        model: "gpt-5.4",
        options: [
          { id: "reasoningEffort", value: "high" },
          { id: "fastMode", value: true },
        ],
      },
      activities: [
        {
          kind: "context-window.updated",
          turnId: "turn-1",
          payload: {
            usedTokens: 5000,
            lastInputTokens: 1200,
            lastOutputTokens: 340,
            durationMs: 45_000,
          },
        },
      ],
    });

    expect(githubFinalAnswerWithStats(thread, "turn-1")).toBe(
      "Ship it.\n\n_`gpt-5.4` · effort high · fast · 45s · ↑1.2k ↓340_",
    );
    expect(
      resolveGitHubBridgeTurnOutcome(thread, {
        userMessageId: "u1",
        previousTurnId: null,
        knownTargetTurnId: "turn-1",
      }),
    ).toMatchObject({
      _tag: "terminal",
      status: "completed",
      body: "Ship it.\n\n_`gpt-5.4` · effort high · fast · 45s · ↑1.2k ↓340_",
      targetTurnId: "turn-1",
    });
  });

  it("keeps waiting while the target turn is still running", () => {
    const thread = threadFixture({
      messages: [
        message({ id: "u1", role: "user", text: "From GH: plan", turnId: null }),
        message({
          id: "a1",
          role: "assistant",
          text: "still working",
          turnId: "turn-1",
          streaming: true,
        }),
      ],
      latestTurn: { turnId: "turn-1", state: "running" },
      session: { status: "running", activeTurnId: "turn-1" },
    });

    expect(
      resolveGitHubBridgeTurnOutcome(thread, {
        userMessageId: "u1",
        previousTurnId: null,
        knownTargetTurnId: null,
      }),
    ).toEqual({ _tag: "waiting" });
  });

  it("legacy delivery without userMessageId pins the first turn after previous, not a later wake-up", () => {
    const thread = threadFixture({
      messages: [
        message({ id: "a0", role: "assistant", text: "prior", turnId: "turn-0" }),
        message({ id: "u1", role: "user", text: "From GH: implement", turnId: null }),
        message({
          id: "a1",
          role: "assistant",
          text: "Original implement answer that the stuck delivery must post.",
          turnId: "turn-1",
        }),
        message({ id: "u2", role: "user", text: "From GH: repeat the result?", turnId: null }),
        message({
          id: "a2",
          role: "assistant",
          text: "Wake-up restatement that must not be double-posted by the stuck delivery.",
          turnId: "turn-2",
        }),
      ],
      latestTurn: { turnId: "turn-2", state: "completed" },
      session: { status: "ready", activeTurnId: null },
      checkpoints: [{ turnId: "turn-1" }, { turnId: "turn-2" }],
    });

    expect(
      discoverGitHubTargetTurnId(thread, {
        userMessageId: null,
        previousTurnId: "turn-0",
        knownTargetTurnId: null,
      }),
    ).toBe("turn-1");

    expect(
      resolveGitHubBridgeTurnOutcome(thread, {
        userMessageId: null,
        previousTurnId: "turn-0",
        knownTargetTurnId: null,
      }),
    ).toEqual({
      _tag: "terminal",
      status: "completed",
      // Stats omit duration when latestTurn is a different turn; model still attaches.
      body: "Original implement answer that the stuck delivery must post.\n\n_`gpt-5.4`_",
      targetTurnId: "turn-1",
    });
  });

  it("legacy delivery recovers the original turn when previousTurnId is outside the message window", () => {
    const thread = threadFixture({
      messages: [
        // previous turn-0 dropped from the detail window
        message({
          id: "a1",
          role: "assistant",
          text: "Implement answer retained after truncation.",
          turnId: "turn-1",
        }),
        message({
          id: "a2",
          role: "assistant",
          text: "Later wake-up answer.",
          turnId: "turn-2",
        }),
      ],
      latestTurn: { turnId: "turn-2", state: "completed" },
      session: { status: "ready", activeTurnId: null },
    });

    expect(
      discoverGitHubTargetTurnId(thread, {
        userMessageId: null,
        previousTurnId: "turn-0",
        knownTargetTurnId: null,
      }),
    ).toBe("turn-1");
  });

  it("new wake-up delivery with userMessageId still targets only its own turn", () => {
    const thread = threadFixture({
      messages: [
        message({ id: "a0", role: "assistant", text: "prior", turnId: "turn-0" }),
        message({
          id: "a1",
          role: "assistant",
          text: "Original implement answer.",
          turnId: "turn-1",
        }),
        message({ id: "u2", role: "user", text: "From GH: repeat", turnId: null }),
        message({
          id: "a2",
          role: "assistant",
          text: "Wake-up restatement for the new delivery only.",
          turnId: "turn-2",
        }),
      ],
      latestTurn: { turnId: "turn-2", state: "completed" },
      session: { status: "ready", activeTurnId: null },
    });

    expect(
      resolveGitHubBridgeTurnOutcome(thread, {
        userMessageId: "u2",
        previousTurnId: "turn-1",
        knownTargetTurnId: null,
      }),
    ).toEqual({
      _tag: "terminal",
      status: "completed",
      body: "Wake-up restatement for the new delivery only.\n\n_`gpt-5.4` · 1m_",
      targetTurnId: "turn-2",
    });
  });
});
