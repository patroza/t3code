import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  VcsCreateWorktreeInput,
  VcsStatusInput,
  GitPreparePullRequestThreadInput,
  GitPreparePullRequestThreadResult,
  GitRunStackedActionResult,
  GitRunStackedActionInput,
  GitActionProgressEvent,
  GitCommandError,
  GitResolvePullRequestResult,
  VcsStatusLocalResult,
} from "./git.ts";

const decodeCreateWorktreeInput = Schema.decodeUnknownSync(VcsCreateWorktreeInput);
const decodeVcsStatusInput = Schema.decodeUnknownSync(VcsStatusInput);
const decodePreparePullRequestThreadInput = Schema.decodeUnknownSync(
  GitPreparePullRequestThreadInput,
);
const decodePreparePullRequestThreadResult = Schema.decodeUnknownSync(
  GitPreparePullRequestThreadResult,
);
const decodeRunStackedActionInput = Schema.decodeUnknownSync(GitRunStackedActionInput);
const decodeRunStackedActionResult = Schema.decodeUnknownSync(GitRunStackedActionResult);
const decodeActionProgressEvent = Schema.decodeUnknownSync(GitActionProgressEvent);
const decodeGitCommandError = Schema.decodeUnknownSync(Schema.toCodecJson(GitCommandError));
const decodeResolvePullRequestResult = Schema.decodeUnknownSync(GitResolvePullRequestResult);
const decodeVcsStatusLocalResult = Schema.decodeUnknownSync(VcsStatusLocalResult);

describe("VcsStatusInput", () => {
  it("accepts cwd-only input as full-mode compatible", () => {
    const parsed = decodeVcsStatusInput({ cwd: "/repo" });
    expect(parsed.cwd).toBe("/repo");
    expect(parsed.mode).toBeUndefined();
  });

  it("accepts list mode for high-cardinality list subscriptions", () => {
    const parsed = decodeVcsStatusInput({ cwd: "/repo/worktree", mode: "list" });
    expect(parsed.mode).toBe("list");
  });
});

describe("GitCommandError", () => {
  it("decodes an unknown failure reason as absent", () => {
    const error = decodeGitCommandError({
      _tag: "GitCommandError",
      operation: "GitVcsDriver.createWorktree",
      command: "git",
      cwd: "/repo",
      detail: "git worktree add failed",
      reason: "added_by_a_newer_server",
    });

    expect(error.reason).toBeUndefined();
    expect(error.message).toBe(
      "Git command failed in GitVcsDriver.createWorktree (/repo): git worktree add failed",
    );
  });
});

describe("VcsCreateWorktreeInput", () => {
  it("accepts omitted newRefName for existing-refName worktrees", () => {
    const parsed = decodeCreateWorktreeInput({
      cwd: "/repo",
      refName: "feature/existing",
      path: "/tmp/worktree",
    });

    expect(parsed.newRefName).toBeUndefined();
    expect(parsed.refName).toBe("feature/existing");
  });

  it("accepts baseRefName metadata for a new worktree ref", () => {
    const parsed = decodeCreateWorktreeInput({
      cwd: "/repo",
      refName: "0123456789abcdef",
      newRefName: "feature/new",
      baseRefName: "origin/main",
      path: "/tmp/worktree",
    });

    expect(parsed.baseRefName).toBe("origin/main");
  });

  it("accepts deferring dependency installation to asynchronous project setup", () => {
    const parsed = decodeCreateWorktreeInput({
      cwd: "/repo",
      refName: "main",
      deferDependencyInstall: true,
      path: "/tmp/worktree",
    });

    expect(parsed.deferDependencyInstall).toBe(true);
  });
});

describe("GitPreparePullRequestThreadInput", () => {
  it("accepts pull request references and mode", () => {
    const parsed = decodePreparePullRequestThreadInput({
      cwd: "/repo",
      reference: "#42",
      mode: "worktree",
    });

    expect(parsed.reference).toBe("#42");
    expect(parsed.mode).toBe("worktree");
  });
});

describe("GitPreparePullRequestThreadResult", () => {
  it("defaults legacy responses to the pull request head", () => {
    const parsed = decodePreparePullRequestThreadResult({
      pullRequest: {
        number: 42,
        title: "PR threads",
        url: "https://github.com/pingdotgg/codething-mvp/pull/42",
        baseBranch: "main",
        headBranch: "feature/pr-threads",
        state: "open",
      },
      branch: "feature/pr-threads",
      worktreePath: "/tmp/pr-threads",
    });

    expect(parsed.isOnPullRequestHead).toBe(true);
  });
});

describe("GitRunStackedActionInput", () => {
  it("accepts explicit stacked actions and requires a client-provided actionId", () => {
    const parsed = decodeRunStackedActionInput({
      actionId: "action-1",
      cwd: "/repo",
      action: "create_pr",
    });

    expect(parsed.actionId).toBe("action-1");
    expect(parsed.action).toBe("create_pr");
    expect(parsed.disableCommitSigning).toBeUndefined();
  });

  it("accepts a per-attempt commit-signing override", () => {
    const parsed = decodeRunStackedActionInput({
      actionId: "action-2",
      cwd: "/repo",
      action: "commit",
      disableCommitSigning: true,
    });

    expect(parsed.disableCommitSigning).toBe(true);
  });
});

describe("GitActionProgressEvent", () => {
  it("defaults omitted failure classifications for older action-failure payloads", () => {
    const parsed = decodeActionProgressEvent({
      actionId: "action-1",
      cwd: "/repo",
      action: "commit",
      kind: "action_failed",
      phase: "commit",
      message: "Commit failed.",
    });

    expect(parsed).toMatchObject({
      kind: "action_failed",
      failureKind: "unknown",
    });
  });

  it("accepts action failures with an unknown classification", () => {
    const parsed = decodeActionProgressEvent({
      actionId: "action-1",
      cwd: "/repo",
      action: "commit",
      kind: "action_failed",
      phase: "commit",
      message: "Commit failed.",
      failureKind: "unknown",
    });

    expect(parsed.kind).toBe("action_failed");
    if (parsed.kind === "action_failed") {
      expect(parsed.failureKind).toBe("unknown");
    }
  });

  it("accepts classified commit-signing failures", () => {
    const parsed = decodeActionProgressEvent({
      actionId: "action-2",
      cwd: "/repo",
      action: "commit_push",
      kind: "action_failed",
      phase: "commit",
      message: "Commit failed.",
      failureKind: "commit_signing_failed",
    });

    expect(parsed).toMatchObject({
      kind: "action_failed",
      failureKind: "commit_signing_failed",
    });
  });
});

describe("GitCommandError", () => {
  const baseError = {
    _tag: "GitCommandError",
    operation: "GitVcsDriver.commit.commit",
    command: "git",
    cwd: "/repo",
    detail: "Git command exited with a non-zero status.",
  } as const;

  it("defaults omitted failure classifications for older command-error payloads", () => {
    expect(decodeGitCommandError(baseError).failureKind).toBe("unknown");
  });

  it("accepts errors with an unknown classification", () => {
    expect(
      decodeGitCommandError({
        ...baseError,
        failureKind: "unknown",
      }).failureKind,
    ).toBe("unknown");
  });

  it("accepts classified commit-signing errors", () => {
    expect(
      decodeGitCommandError({
        ...baseError,
        failureKind: "commit_signing_failed",
      }).failureKind,
    ).toBe("commit_signing_failed");
  });

  it("preserves leading and trailing whitespace in file paths", () => {
    const parsed = decodeRunStackedActionInput({
      actionId: "action-1",
      cwd: "/repo",
      action: "commit",
      filePaths: [" leading.txt", "trailing.txt "],
    });

    expect(parsed.filePaths).toEqual([" leading.txt", "trailing.txt "]);
  });
});
