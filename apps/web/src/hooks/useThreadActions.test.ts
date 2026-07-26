import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  deleteThreadTargetsSequentially,
  getWorktreeRemovalAction,
  ThreadArchiveBlockedError,
} from "./useThreadActions";

const environmentId = EnvironmentId.make("environment-1");

describe("ThreadArchiveBlockedError", () => {
  it("keeps the blocked thread context with the fixed message", () => {
    const error = new ThreadArchiveBlockedError({
      environmentId,
      threadId: ThreadId.make("thread-1"),
    });

    expect(error).toMatchObject({
      environmentId: "environment-1",
      threadId: "thread-1",
    });
    expect(error.message).toBe("Cannot archive a running thread.");
  });
});

describe("deleteThreadTargetsSequentially", () => {
  const targets = [
    { environmentId, threadId: ThreadId.make("thread-1") },
    { environmentId, threadId: ThreadId.make("thread-2") },
    { environmentId, threadId: ThreadId.make("thread-3") },
  ] as const;

  it("makes shared-worktree cleanup eligible only for the final target", async () => {
    const cleanupEligibleTargets: string[] = [];

    const result = await deleteThreadTargetsSequentially(targets, async (target, opts) => {
      if (opts.deletedThreadKeys.size === targets.length - 1) {
        cleanupEligibleTargets.push(scopedThreadKey(target));
      }
      return { _tag: "Success" } as const;
    });

    expect(result).toBeNull();
    expect(cleanupEligibleTargets).toEqual([scopedThreadKey(targets[2])]);
  });

  it("does not discount a target whose deletion failed", async () => {
    const deletedKeySnapshots: string[][] = [];
    const failure = { _tag: "Failure", reason: "delete failed" } as const;
    const deleteTarget = vi.fn(
      async (
        target: (typeof targets)[number],
        opts: { deletedThreadKeys: ReadonlySet<string> },
      ) => {
        deletedKeySnapshots.push([...opts.deletedThreadKeys]);
        return target === targets[1] ? failure : ({ _tag: "Success" } as const);
      },
    );

    const result = await deleteThreadTargetsSequentially(targets, deleteTarget);

    expect(result).toBe(failure);
    expect(deleteTarget).toHaveBeenCalledTimes(2);
    expect(deletedKeySnapshots).toEqual([[], [scopedThreadKey(targets[0])]]);
  });
});

describe("getWorktreeRemovalAction", () => {
  it("asks before removing an orphaned worktree when confirmation is enabled", () => {
    expect(
      getWorktreeRemovalAction({
        canRemoveWorktree: true,
        confirmWorktreeRemoval: true,
      }),
    ).toBe("confirm");
  });

  it("removes an orphaned worktree directly when confirmation is disabled", () => {
    expect(
      getWorktreeRemovalAction({
        canRemoveWorktree: true,
        confirmWorktreeRemoval: false,
      }),
    ).toBe("remove");
  });

  it("does not remove a worktree that is still in use", () => {
    expect(
      getWorktreeRemovalAction({
        canRemoveWorktree: false,
        confirmWorktreeRemoval: false,
      }),
    ).toBe("skip");
  });
});
