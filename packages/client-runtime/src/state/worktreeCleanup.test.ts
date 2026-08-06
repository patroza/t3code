import { describe, expect, it, vi } from "vite-plus/test";

import {
  formatWorktreePathForDisplay,
  runArchiveWithWorktreeCleanup,
  type ArchiveWorktreeCleanupCandidate,
  type WorktreeCleanupConfirmation,
  type WorktreeCleanupOutcome,
} from "./worktreeCleanup.ts";

const candidate: ArchiveWorktreeCleanupCandidate = {
  worktreePath: "/tmp/worktrees/repo/feature-1",
  branch: "feature-1",
};

function makeFlow(overrides?: {
  readonly previewCandidate?: () => Promise<ArchiveWorktreeCleanupCandidate | null>;
  readonly removalPolicy?: "confirm" | "remove";
  readonly confirmation?: WorktreeCleanupConfirmation<{ readonly _tag: "Failure" }> | null;
  readonly archiveSucceeds?: boolean;
  readonly cleanupOutcome?: WorktreeCleanupOutcome;
}) {
  const confirmRemoval =
    overrides?.confirmation === null
      ? null
      : vi.fn(async () => overrides?.confirmation ?? { kind: "confirmed" as const });
  const archive = vi.fn(async () => ({
    _tag: overrides?.archiveSucceeds === false ? ("Failure" as const) : ("Success" as const),
  }));
  const cleanup = vi.fn(
    async (): Promise<WorktreeCleanupOutcome> =>
      overrides?.cleanupOutcome ?? { kind: "done", status: "removed" },
  );
  const onCleanupFailed = vi.fn();
  const onCleanupRetained = vi.fn();
  const run = () =>
    runArchiveWithWorktreeCleanup({
      previewCandidate: overrides?.previewCandidate ?? (async () => candidate),
      removalPolicy: overrides?.removalPolicy ?? "confirm",
      confirmRemoval,
      archive,
      isArchiveSuccess: (result) => result._tag === "Success",
      cleanup,
      onCleanupFailed,
      onCleanupRetained,
    });
  return { run, confirmRemoval, archive, cleanup, onCleanupFailed, onCleanupRetained };
}

describe("runArchiveWithWorktreeCleanup", () => {
  it("prompts with the formatted final path segment when the thread is the final active reference", async () => {
    const flow = makeFlow();
    await flow.run();
    expect(flow.confirmRemoval).toHaveBeenCalledExactlyOnceWith({
      candidate,
      displayWorktreePath: "feature-1",
    });
  });

  it("does not prompt when the server preview reports a shared active worktree", async () => {
    const flow = makeFlow({ previewCandidate: async () => null });
    await flow.run();
    expect(flow.confirmRemoval).not.toHaveBeenCalled();
    expect(flow.archive).toHaveBeenCalledTimes(1);
    expect(flow.cleanup).not.toHaveBeenCalled();
  });

  it("does not prompt or clean up when no confirmation surface exists", async () => {
    const flow = makeFlow({ confirmation: null });
    await flow.run();
    expect(flow.archive).toHaveBeenCalledTimes(1);
    expect(flow.cleanup).not.toHaveBeenCalled();
  });

  it("removes the final active worktree without prompting when confirmation is disabled", async () => {
    const flow = makeFlow({ removalPolicy: "remove", confirmation: null });
    const outcome = await flow.run();
    expect(outcome).toEqual({ kind: "archived", result: { _tag: "Success" } });
    expect(flow.archive).toHaveBeenCalledTimes(1);
    expect(flow.cleanup).toHaveBeenCalledTimes(1);
    expect(flow.archive.mock.invocationCallOrder[0]).toBeLessThan(
      flow.cleanup.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("archives without cleanup when the user declines", async () => {
    const flow = makeFlow({ confirmation: { kind: "declined" } });
    const outcome = await flow.run();
    expect(outcome).toEqual({ kind: "archived", result: { _tag: "Success" } });
    expect(flow.archive).toHaveBeenCalledTimes(1);
    expect(flow.cleanup).not.toHaveBeenCalled();
  });

  it("archives and requests conditional cleanup when the user confirms", async () => {
    const flow = makeFlow({ confirmation: { kind: "confirmed" } });
    const outcome = await flow.run();
    expect(outcome).toEqual({ kind: "archived", result: { _tag: "Success" } });
    expect(flow.cleanup).toHaveBeenCalledTimes(1);
    expect(flow.onCleanupFailed).not.toHaveBeenCalled();
    expect(flow.onCleanupRetained).not.toHaveBeenCalled();
    // Cleanup runs only after the archive.
    expect(flow.archive.mock.invocationCallOrder[0]).toBeLessThan(
      flow.cleanup.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("skips cleanup when the archive itself failed", async () => {
    const flow = makeFlow({ archiveSucceeds: false });
    const outcome = await flow.run();
    expect(outcome).toEqual({ kind: "archived", result: { _tag: "Failure" } });
    expect(flow.cleanup).not.toHaveBeenCalled();
  });

  it("reports a cleanup failure as cleanup-only without failing the archive", async () => {
    const flow = makeFlow({
      cleanupOutcome: { kind: "failed", message: "git worktree remove failed" },
    });
    const outcome = await flow.run();
    expect(outcome).toEqual({ kind: "archived", result: { _tag: "Success" } });
    expect(flow.onCleanupFailed).toHaveBeenCalledExactlyOnceWith(
      "feature-1",
      "git worktree remove failed",
    );
  });

  it("reports a retained worktree when another thread became active after the preview", async () => {
    const flow = makeFlow({ cleanupOutcome: { kind: "done", status: "retained-active" } });
    await flow.run();
    expect(flow.onCleanupRetained).toHaveBeenCalledExactlyOnceWith("feature-1");
    expect(flow.onCleanupFailed).not.toHaveBeenCalled();
  });

  it("stays silent when the worktree was already missing", async () => {
    const flow = makeFlow({ cleanupOutcome: { kind: "done", status: "already-missing" } });
    await flow.run();
    expect(flow.onCleanupFailed).not.toHaveBeenCalled();
    expect(flow.onCleanupRetained).not.toHaveBeenCalled();
  });

  it("aborts without archiving when the confirmation surface fails", async () => {
    const flow = makeFlow({ confirmation: { kind: "aborted", result: { _tag: "Failure" } } });
    const outcome = await flow.run();
    expect(outcome).toEqual({ kind: "aborted", result: { _tag: "Failure" } });
    expect(flow.archive).not.toHaveBeenCalled();
    expect(flow.cleanup).not.toHaveBeenCalled();
  });

  it("sequential bulk archive prompts only when each worktree reaches its final active reference", async () => {
    // Two threads share one worktree; a third owns its own. Each archive
    // requests a fresh preview, so the shared worktree only prompts once the
    // earlier archive is already visible to the server.
    const activeByThread = new Map<string, { worktreePath: string; branch: string }>([
      ["t1", { worktreePath: "/wt/shared", branch: "shared" }],
      ["t2", { worktreePath: "/wt/shared", branch: "shared" }],
      ["t3", { worktreePath: "/wt/solo", branch: "solo" }],
    ]);
    const prompts: Array<string> = [];

    const archiveOne = (threadId: string) =>
      runArchiveWithWorktreeCleanup({
        previewCandidate: async () => {
          const target = activeByThread.get(threadId);
          if (!target) return null;
          const shared = [...activeByThread.entries()].some(
            ([otherId, other]) =>
              otherId !== threadId && other.worktreePath === target.worktreePath,
          );
          return shared ? null : target;
        },
        removalPolicy: "confirm",
        confirmRemoval: async ({ displayWorktreePath }) => {
          prompts.push(displayWorktreePath);
          return { kind: "declined" };
        },
        archive: async () => {
          activeByThread.delete(threadId);
          return { _tag: "Success" as const };
        },
        isArchiveSuccess: (result) => result._tag === "Success",
        cleanup: async () => ({ kind: "done", status: "removed" }),
        onCleanupFailed: () => {},
        onCleanupRetained: () => {},
      });

    await archiveOne("t1");
    await archiveOne("t2");
    await archiveOne("t3");

    // t1 shares with t2 (no prompt); t2 is the final shared reference and
    // t3 the only solo reference (both prompt).
    expect(prompts).toEqual(["shared", "solo"]);
  });
});

describe("formatWorktreePathForDisplay", () => {
  it("returns the final path segment across separators", () => {
    expect(formatWorktreePathForDisplay("/tmp/worktrees/repo/feature-1")).toBe("feature-1");
    expect(formatWorktreePathForDisplay("/tmp/worktrees/repo/feature-1/")).toBe("feature-1");
    expect(formatWorktreePathForDisplay("C:\\worktrees\\repo\\feature-1")).toBe("feature-1");
  });

  it("falls back to the trimmed input when no segment exists", () => {
    expect(formatWorktreePathForDisplay("   ")).toBe("   ");
    expect(formatWorktreePathForDisplay("///")).toBe("///");
  });
});
