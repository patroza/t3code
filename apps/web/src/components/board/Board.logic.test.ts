import { EnvironmentId, ProjectId, type VcsStatusResult } from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { describe, expect, it } from "vite-plus/test";
import {
  BOARD_ARCHIVE_DROPPABLE_ID,
  BOARD_SETTLED_COLUMN_DROPPABLE_ID,
  BOARD_TRASH_DROPPABLE_ID,
  BOARD_UNSETTLE_DROPPABLE_ID,
  boardWorktreeGroupDragId,
  boardWorktreeKey,
  buildBoardColumns,
  buildBoardProjectFilterPredicate,
  countBoardColumnThreads,
  deriveBoardColumn,
  parseBoardWorktreeGroupDragId,
  resolveBoardDropIntent,
  sliceBoardSettledItems,
  sortBoardThreads,
  type BoardColumnItem,
  type BoardColumnInput,
} from "./Board.logic";

const localEnvironmentId = EnvironmentId.make("environment-local");
const remoteEnvironmentId = EnvironmentId.make("environment-remote");

function columnThreadIds<T extends { readonly id: string }>(
  items: readonly BoardColumnItem<T>[],
): string[] {
  return items.flatMap((item) =>
    item.kind === "thread" ? [item.thread.id] : item.threads.map((thread) => thread.id),
  );
}

function makeGitStatus(overrides: Partial<VcsStatusResult> = {}): VcsStatusResult {
  return {
    isRepo: true,
    hasPrimaryRemote: true,
    isDefaultRef: false,
    refName: "feature/board",
    hasWorkingTreeChanges: false,
    workingTree: { files: [], insertions: 0, deletions: 0 },
    hasUpstream: true,
    aheadCount: 0,
    behindCount: 0,
    pr: null,
    ...overrides,
  };
}

function makePr(state: "open" | "closed" | "merged"): NonNullable<VcsStatusResult["pr"]> {
  return {
    number: 42,
    title: "Board view",
    url: "https://github.com/example/repo/pull/42",
    baseRef: "main",
    headRef: "feature/board",
    state,
  };
}

function makeColumnInput(overrides: Partial<BoardColumnInput> = {}): BoardColumnInput {
  return {
    threadStatusLabel: null,
    interactionMode: "default",
    isSettled: false,
    latestTurnCompletedAt: null,
    readySessionUpdatedAt: null,
    lastVisitedAt: null,
    threadBranch: "feature/board",
    hasDedicatedWorktree: false,
    hasWorkingThreadForWorktree: false,
    gitStatus: makeGitStatus(),
    ...overrides,
  };
}

describe("deriveBoardColumn", () => {
  it("puts attention status pills in review ahead of working or merged lifecycle state", () => {
    const gitStatus = makeGitStatus({ pr: makePr("merged") });
    expect(
      deriveBoardColumn(makeColumnInput({ threadStatusLabel: "Pending Approval", gitStatus })),
    ).toBe("review");
    expect(
      deriveBoardColumn(makeColumnInput({ threadStatusLabel: "Awaiting Input", gitStatus })),
    ).toBe("review");
    expect(
      deriveBoardColumn(
        makeColumnInput({
          interactionMode: "plan",
          threadStatusLabel: "Plan Ready",
          gitStatus,
        }),
      ),
    ).toBe("review");
    expect(deriveBoardColumn(makeColumnInput({ threadStatusLabel: "Completed", gitStatus }))).toBe(
      "review",
    );
  });

  it("puts working and connecting status pills in working, even with a merged PR", () => {
    const gitStatus = makeGitStatus({ pr: makePr("merged") });
    expect(deriveBoardColumn(makeColumnInput({ threadStatusLabel: "Working", gitStatus }))).toBe(
      "working",
    );
    expect(deriveBoardColumn(makeColumnInput({ threadStatusLabel: "Connecting", gitStatus }))).toBe(
      "working",
    );
  });

  it("defaults to review while git status is unloaded or the cwd is not a repo", () => {
    expect(deriveBoardColumn(makeColumnInput({ gitStatus: null }))).toBe("review");
    expect(
      deriveBoardColumn(makeColumnInput({ gitStatus: makeGitStatus({ isRepo: false }) })),
    ).toBe("review");
  });

  it("ignores git status from a shared cwd checked out on a different branch", () => {
    const gitStatus = makeGitStatus({
      refName: "someone-elses-branch",
      hasWorkingTreeChanges: true,
      pr: makePr("open"),
    });
    expect(deriveBoardColumn(makeColumnInput({ gitStatus }))).toBe("review");
  });

  it("applies git status from a dedicated worktree regardless of ref name", () => {
    const gitStatus = makeGitStatus({ refName: "detached-head", hasWorkingTreeChanges: true });
    expect(deriveBoardColumn(makeColumnInput({ hasDedicatedWorktree: true, gitStatus }))).toBe(
      "review",
    );
  });

  it("puts a branch ahead of upstream in review", () => {
    expect(
      deriveBoardColumn(makeColumnInput({ gitStatus: makeGitStatus({ aheadCount: 2 }) })),
    ).toBe("review");
  });

  it("puts a never-pushed branch ahead of (or with unknown distance to) the default in review", () => {
    expect(
      deriveBoardColumn(
        makeColumnInput({
          gitStatus: makeGitStatus({ hasUpstream: false, aheadOfDefaultCount: 3 }),
        }),
      ),
    ).toBe("review");
    expect(
      deriveBoardColumn(makeColumnInput({ gitStatus: makeGitStatus({ hasUpstream: false }) })),
    ).toBe("review");
  });

  it("puts a clean fully pushed feature branch without a PR in published", () => {
    expect(deriveBoardColumn(makeColumnInput())).toBe("published");
  });

  it("puts an open PR with unpublished work in review", () => {
    const gitStatus = makeGitStatus({
      hasWorkingTreeChanges: true,
      pr: makePr("open"),
    });
    expect(deriveBoardColumn(makeColumnInput({ gitStatus }))).toBe("review");
  });

  it("does not move a sibling thread to review for a dirty worktree that is still working", () => {
    const gitStatus = makeGitStatus({
      hasWorkingTreeChanges: true,
      pr: makePr("open"),
    });
    expect(
      deriveBoardColumn(
        makeColumnInput({
          hasDedicatedWorktree: true,
          hasWorkingThreadForWorktree: true,
          gitStatus,
        }),
      ),
    ).toBe("published");
  });

  it("still moves locally-ahead siblings to review while their worktree is working", () => {
    expect(
      deriveBoardColumn(
        makeColumnInput({
          hasDedicatedWorktree: true,
          hasWorkingThreadForWorktree: true,
          gitStatus: makeGitStatus({ aheadCount: 1, pr: makePr("open") }),
        }),
      ),
    ).toBe("review");
  });

  it("puts a clean open PR in published", () => {
    expect(
      deriveBoardColumn(makeColumnInput({ gitStatus: makeGitStatus({ pr: makePr("open") }) })),
    ).toBe("published");
  });

  it("keeps an unsettled merged PR in published instead of guessing settled", () => {
    expect(
      deriveBoardColumn(makeColumnInput({ gitStatus: makeGitStatus({ pr: makePr("merged") }) })),
    ).toBe("published");
  });

  it("lets the settled flag win regardless of git or completion state", () => {
    expect(deriveBoardColumn(makeColumnInput({ isSettled: true, gitStatus: null }))).toBe(
      "settled",
    );
    expect(
      deriveBoardColumn(
        makeColumnInput({
          isSettled: true,
          gitStatus: makeGitStatus({ hasWorkingTreeChanges: true, aheadCount: 1 }),
        }),
      ),
    ).toBe("settled");
    expect(
      deriveBoardColumn(makeColumnInput({ isSettled: true, threadStatusLabel: "Completed" })),
    ).toBe("settled");
  });

  it("puts an unseen turn completion in review regardless of git state", () => {
    const unseen = {
      latestTurnCompletedAt: "2026-07-22T10:00:00.000Z",
      lastVisitedAt: "2026-07-22T09:00:00.000Z",
    };
    expect(deriveBoardColumn(makeColumnInput({ ...unseen, gitStatus: null }))).toBe("review");
    expect(
      deriveBoardColumn(
        makeColumnInput({ ...unseen, gitStatus: makeGitStatus({ pr: makePr("merged") }) }),
      ),
    ).toBe("review");
  });

  it("keeps a working status pill in working even with an unseen completion", () => {
    expect(
      deriveBoardColumn(
        makeColumnInput({
          threadStatusLabel: "Working",
          latestTurnCompletedAt: "2026-07-22T10:00:00.000Z",
          lastVisitedAt: "2026-07-22T09:00:00.000Z",
        }),
      ),
    ).toBe("working");
  });

  it("keeps a visited ready session in review when its latest turn summary is unavailable", () => {
    expect(
      deriveBoardColumn(
        makeColumnInput({
          latestTurnCompletedAt: null,
          readySessionUpdatedAt: "2026-07-22T03:45:04.819Z",
          lastVisitedAt: "2026-07-22T03:45:04.819Z",
          gitStatus: null,
        }),
      ),
    ).toBe("review");
  });

  it("lets in-flight git work outrank a seen completion", () => {
    const seen = {
      latestTurnCompletedAt: "2026-07-22T09:00:00.000Z",
      lastVisitedAt: "2026-07-22T10:00:00.000Z",
    };
    expect(
      deriveBoardColumn(
        makeColumnInput({ ...seen, gitStatus: makeGitStatus({ hasWorkingTreeChanges: true }) }),
      ),
    ).toBe("review");
    expect(deriveBoardColumn(makeColumnInput({ ...seen }))).toBe("published");
  });

  it("keeps a plan-only thread's column off its worktree's git state", () => {
    // This git state would classify as published; a plan-mode thread does not
    // own it (the implementation thread does), so the plan thread stays in
    // review until settled.
    const badgelessPlan = {
      interactionMode: "plan" as const,
      threadStatusLabel: null,
      hasDedicatedWorktree: true,
      gitStatus: makeGitStatus({ pr: makePr("open") }),
    };
    expect(
      deriveBoardColumn(makeColumnInput({ ...badgelessPlan, interactionMode: "default" })),
    ).toBe("published");
    expect(deriveBoardColumn(makeColumnInput(badgelessPlan))).toBe("review");
    expect(deriveBoardColumn(makeColumnInput({ ...badgelessPlan, isSettled: true }))).toBe(
      "settled",
    );
  });

  it("puts a clean default branch in review", () => {
    const gitStatus = makeGitStatus({ refName: "main", isDefaultRef: true });
    expect(deriveBoardColumn(makeColumnInput({ threadBranch: "main", gitStatus }))).toBe("review");
  });
});

describe("sortBoardThreads", () => {
  const byUpdatedAt = (thread: { updatedAt: string }) => thread.updatedAt;

  it("orders by the selected timestamp descending", () => {
    const sorted = sortBoardThreads(
      [
        { id: "thread-1", updatedAt: "2026-07-20T10:00:00.000Z" },
        { id: "thread-2", updatedAt: "2026-07-21T10:00:00.000Z" },
        { id: "thread-3", updatedAt: "2026-07-19T10:00:00.000Z" },
      ],
      byUpdatedAt,
    );
    expect(sorted.map((thread) => thread.id)).toEqual(["thread-2", "thread-1", "thread-3"]);
  });

  it("breaks timestamp ties by thread id", () => {
    const sorted = sortBoardThreads(
      [
        { id: "thread-b", updatedAt: "2026-07-20T10:00:00.000Z" },
        { id: "thread-a", updatedAt: "2026-07-20T10:00:00.000Z" },
      ],
      byUpdatedAt,
    );
    expect(sorted.map((thread) => thread.id)).toEqual(["thread-a", "thread-b"]);
  });

  it("sorts invalid timestamps last", () => {
    const sorted = sortBoardThreads(
      [
        { id: "thread-1", updatedAt: "not-a-date" },
        { id: "thread-2", updatedAt: "2026-07-20T10:00:00.000Z" },
      ],
      byUpdatedAt,
    );
    expect(sorted.map((thread) => thread.id)).toEqual(["thread-2", "thread-1"]);
  });
});

describe("buildBoardColumns", () => {
  it("sorts working threads by active session start (falling back to update time) and other columns by update time", () => {
    const threads = [
      {
        id: "thread-review-old",
        updatedAt: "2026-07-18T10:00:00.000Z",
        workingStartedAt: null,
      },
      {
        id: "thread-review-new",
        updatedAt: "2026-07-21T10:00:00.000Z",
        workingStartedAt: null,
      },
      {
        id: "thread-working-old",
        updatedAt: "2026-07-22T10:00:00.000Z",
        workingStartedAt: "2026-07-19T10:00:00.000Z",
      },
      {
        id: "thread-working-new",
        updatedAt: "2026-07-20T10:00:00.000Z",
        workingStartedAt: "2026-07-21T10:00:00.000Z",
      },
      {
        id: "thread-working-fallback",
        updatedAt: "2026-07-23T10:00:00.000Z",
        workingStartedAt: null,
      },
    ];
    const columns = buildBoardColumns(
      threads,
      (thread) => (thread.id.startsWith("thread-working") ? "working" : "review"),
      (thread) => thread.workingStartedAt,
    );
    expect(columnThreadIds(columns.review)).toEqual(["thread-review-new", "thread-review-old"]);
    expect(columnThreadIds(columns.working)).toEqual([
      "thread-working-fallback",
      "thread-working-new",
      "thread-working-old",
    ]);
    expect(columns.published).toEqual([]);
    expect(columns.settled).toEqual([]);
  });

  it("hosts shared groups in their earliest column and orders members by actual column then time", () => {
    const threads = [
      {
        id: "group-review-old",
        updatedAt: "2026-07-19T10:00:00.000Z",
        workingStartedAt: null,
        column: "review" as const,
        groupKey: "shared-worktree",
      },
      {
        id: "group-working-old",
        updatedAt: "2026-07-24T10:00:00.000Z",
        workingStartedAt: "2026-07-20T10:00:00.000Z",
        column: "working" as const,
        groupKey: "shared-worktree",
      },
      {
        id: "group-published",
        updatedAt: "2026-07-25T10:00:00.000Z",
        workingStartedAt: null,
        column: "published" as const,
        groupKey: "shared-worktree",
      },
      {
        id: "group-review-new",
        updatedAt: "2026-07-23T10:00:00.000Z",
        workingStartedAt: null,
        column: "review" as const,
        groupKey: "shared-worktree",
      },
      {
        id: "group-working-new",
        updatedAt: "2026-07-18T10:00:00.000Z",
        workingStartedAt: "2026-07-22T10:00:00.000Z",
        column: "working" as const,
        groupKey: "shared-worktree",
      },
    ];
    const columns = buildBoardColumns(
      threads,
      (thread) => thread.column,
      (thread) => thread.workingStartedAt,
      (thread) => thread.groupKey,
    );

    expect(columns.working).toEqual([
      {
        kind: "worktreeGroup",
        worktreeKey: "shared-worktree",
        threads: [threads[4], threads[1], threads[3], threads[0], threads[2]],
      },
    ]);
    expect(columns.review).toEqual([]);
    expect(columns.published).toEqual([]);
    expect(columns.settled).toEqual([]);
  });

  it("uses the earliest represented column rather than moving every group to working", () => {
    const threads = [
      {
        id: "standalone-working",
        updatedAt: "2026-07-22T10:00:00.000Z",
        column: "working" as const,
        groupKey: null,
      },
      {
        id: "group-settled",
        updatedAt: "2026-07-23T10:00:00.000Z",
        column: "settled" as const,
        groupKey: "later-group",
      },
      {
        id: "group-review",
        updatedAt: "2026-07-21T10:00:00.000Z",
        column: "review" as const,
        groupKey: "later-group",
      },
    ];
    const columns = buildBoardColumns(
      threads,
      (thread) => thread.column,
      () => null,
      (thread) => thread.groupKey,
    );

    expect(columns.working).toEqual([{ kind: "thread", thread: threads[0] }]);
    expect(columns.review).toEqual([
      {
        kind: "worktreeGroup",
        worktreeKey: "later-group",
        threads: [threads[2], threads[1]],
      },
    ]);
    expect(columns.settled).toEqual([]);
  });
});

describe("countBoardColumnThreads", () => {
  it("counts a worktree group as its member count", () => {
    const items: BoardColumnItem<{ readonly id: string }>[] = [
      { kind: "thread", thread: { id: "thread-1" } },
      {
        kind: "worktreeGroup",
        worktreeKey: "shared-worktree",
        threads: [{ id: "thread-2" }, { id: "thread-3" }],
      },
    ];
    expect(countBoardColumnThreads(items)).toBe(3);
    expect(countBoardColumnThreads([])).toBe(0);
  });
});

describe("sliceBoardSettledItems", () => {
  const thread = (id: string): BoardColumnItem<{ readonly id: string }> => ({
    kind: "thread",
    thread: { id },
  });
  const group = (
    worktreeKey: string,
    ...ids: string[]
  ): BoardColumnItem<{ readonly id: string }> => ({
    kind: "worktreeGroup",
    worktreeKey,
    threads: ids.map((id) => ({ id })),
  });

  it("returns the same array with no hidden count when the total fits the limit", () => {
    const items = [thread("thread-1"), group("shared-worktree", "thread-2", "thread-3")];
    const result = sliceBoardSettledItems(items, 3);
    expect(result.visibleItems).toBe(items);
    expect(result.hiddenThreadCount).toBe(0);
  });

  it("slices plain thread items at the limit", () => {
    const items = [thread("thread-1"), thread("thread-2"), thread("thread-3")];
    const result = sliceBoardSettledItems(items, 2);
    expect(columnThreadIds(result.visibleItems)).toEqual(["thread-1", "thread-2"]);
    expect(result.hiddenThreadCount).toBe(1);
  });

  it("includes a group straddling the limit whole and counts its members", () => {
    const items = [
      thread("thread-1"),
      group("shared-worktree", "thread-2", "thread-3", "thread-4"),
      thread("thread-5"),
    ];
    const result = sliceBoardSettledItems(items, 2);
    expect(result.visibleItems).toEqual([items[0], items[1]]);
    expect(result.hiddenThreadCount).toBe(1);
  });

  it("returns no visible items for a zero limit with non-empty input", () => {
    const items = [thread("thread-1"), thread("thread-2")];
    const result = sliceBoardSettledItems(items, 0);
    expect(result.visibleItems).toEqual([]);
    expect(result.hiddenThreadCount).toBe(2);
  });
});

describe("buildBoardProjectFilterPredicate", () => {
  const projectId = ProjectId.make("project-1");
  const otherProjectId = ProjectId.make("project-2");
  const snapshots = [
    {
      projectKey: "logical-project-1",
      memberProjectRefs: [
        scopeProjectRef(localEnvironmentId, projectId),
        scopeProjectRef(remoteEnvironmentId, projectId),
      ],
    },
  ];

  it("matches everything when no project is selected or the stored key no longer resolves", () => {
    const noSelection = buildBoardProjectFilterPredicate({ selectedProjectKey: null, snapshots });
    expect(noSelection({ environmentId: localEnvironmentId, projectId: otherProjectId })).toBe(
      true,
    );
    const staleSelection = buildBoardProjectFilterPredicate({
      selectedProjectKey: "removed-project",
      snapshots,
    });
    expect(staleSelection({ environmentId: localEnvironmentId, projectId: otherProjectId })).toBe(
      true,
    );
  });

  it("matches threads from any member project of the selected group", () => {
    const predicate = buildBoardProjectFilterPredicate({
      selectedProjectKey: "logical-project-1",
      snapshots,
    });
    expect(predicate({ environmentId: localEnvironmentId, projectId })).toBe(true);
    expect(predicate({ environmentId: remoteEnvironmentId, projectId })).toBe(true);
    expect(predicate({ environmentId: localEnvironmentId, projectId: otherProjectId })).toBe(false);
  });
});

describe("boardWorktreeKey", () => {
  it("returns null without a dedicated worktree", () => {
    expect(boardWorktreeKey({ environmentId: localEnvironmentId, worktreePath: null })).toBeNull();
    expect(boardWorktreeKey({ environmentId: localEnvironmentId, worktreePath: "   " })).toBeNull();
  });
});

describe("resolveBoardDropIntent", () => {
  it("maps the drop-zone droppables to their intents and everything else to null", () => {
    expect(resolveBoardDropIntent(BOARD_ARCHIVE_DROPPABLE_ID)).toBe("archive");
    expect(resolveBoardDropIntent(BOARD_TRASH_DROPPABLE_ID)).toBe("trash");
    expect(resolveBoardDropIntent(BOARD_UNSETTLE_DROPPABLE_ID)).toBe("unsettle");
    expect(resolveBoardDropIntent(BOARD_SETTLED_COLUMN_DROPPABLE_ID)).toBe("settle");
    expect(resolveBoardDropIntent("board-column-review")).toBeNull();
    expect(resolveBoardDropIntent(null)).toBeNull();
  });
});

describe("parseBoardWorktreeGroupDragId", () => {
  it("round-trips the worktree key through the group drag id and rejects thread drag ids", () => {
    const worktreeKey = boardWorktreeKey({
      environmentId: localEnvironmentId,
      worktreePath: "/wt",
    });
    expect(worktreeKey).not.toBeNull();
    const dragId = boardWorktreeGroupDragId(worktreeKey ?? "");

    expect(dragId).not.toBe(worktreeKey);
    expect(parseBoardWorktreeGroupDragId(dragId)).toBe(worktreeKey);
    expect(parseBoardWorktreeGroupDragId("environment-local thread-1")).toBeNull();
  });
});
