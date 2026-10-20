import { describe, expect, it } from "vite-plus/test";

import { buildUnsignedCommitRetryInput } from "./gitActions.ts";

describe("buildUnsignedCommitRetryInput", () => {
  it("preserves the requested action, custom message, and files while removing featureBranch", () => {
    const filePaths = ["src/a.ts", "src/b.ts"];

    expect(
      buildUnsignedCommitRetryInput({
        action: "commit_push_pr",
        commitMessage: "feat: preserve this message",
        featureBranch: true,
        filePaths,
      }),
    ).toEqual({
      action: "commit_push_pr",
      commitMessage: "feat: preserve this message",
      filePaths,
      disableCommitSigning: true,
    });
  });

  it("leaves generated commit messages absent so they may be regenerated", () => {
    expect(
      buildUnsignedCommitRetryInput({
        action: "commit",
        featureBranch: true,
      }),
    ).toEqual({
      action: "commit",
      disableCommitSigning: true,
    });
  });
});
