import { DndContext } from "@dnd-kit/core";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type { BoardDragClickGuard } from "./BoardDragClickGuard";
import { BoardWorktreeGroup, BoardWorktreeGroupDragOverlay } from "./BoardWorktreeGroup";

const environmentId = EnvironmentId.make("environment-local");

const noopDragClickGuard: BoardDragClickGuard = {
  startDrag: () => {},
  finishDrag: () => {},
  consumeSuppressedClick: () => false,
  dispose: () => {},
};

function renderGroup({
  branch = "t3code/session-dashboard-board",
  mostRecentCard = <div data-testid="most-recent-card" />,
  children = <div data-testid="older-card" />,
}: {
  branch?: string | null;
  mostRecentCard?: ReactNode;
  children?: ReactNode;
} = {}): string {
  return renderToStaticMarkup(
    <DndContext>
      <BoardWorktreeGroup
        worktreeKey={`${environmentId}\u0000/Users/tim/.t3/worktrees/t3code/board-wt`}
        threadRefs={[
          scopeThreadRef(environmentId, ThreadId.make("thread-1")),
          scopeThreadRef(environmentId, ThreadId.make("thread-2")),
        ]}
        worktreePath="/Users/tim/.t3/worktrees/t3code/board-wt"
        branch={branch}
        mostRecentCard={mostRecentCard}
        dragClickGuard={noopDragClickGuard}
      >
        {children}
      </BoardWorktreeGroup>
    </DndContext>,
  );
}

describe("BoardWorktreeGroup", () => {
  it("starts collapsed showing only the most recent card below the toggle", () => {
    const markup = renderGroup();

    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('<button type="button"');
    expect(markup).toContain('aria-label="Worktree t3code/session-dashboard-board"');
    expect(markup).toContain(">2<");
    expect(markup).toContain('data-testid="most-recent-card"');
    expect(markup).not.toContain('data-testid="older-card"');
  });

  it("labels the header with the branch name, falling back to the worktree name", () => {
    const withBranch = renderGroup({ mostRecentCard: null, children: null });
    expect(withBranch).toContain("t3code/session-dashboard-board");
    expect(withBranch).not.toContain("board-wt");

    const withoutBranch = renderGroup({ branch: null, mostRecentCard: null, children: null });
    expect(withoutBranch).toContain("board-wt");
  });
});

describe("BoardWorktreeGroupDragOverlay", () => {
  it("is hidden from assistive technology and shows the group label and count", () => {
    const markup = renderToStaticMarkup(
      <BoardWorktreeGroupDragOverlay
        worktreePath="/Users/tim/.t3/worktrees/t3code/board-wt"
        branch="t3code/session-dashboard-board"
        threadCount={3}
      />,
    );

    expect(markup).toContain('aria-hidden="true"');
    expect(markup).not.toContain("<button");
    expect(markup).toContain("t3code/session-dashboard-board");
    expect(markup).toContain(">3<");
  });

  it("reflects the pending drop intent so feedback is visible under the pointer", () => {
    const renderOverlay = (dropIntent: "archive" | null) =>
      renderToStaticMarkup(
        <BoardWorktreeGroupDragOverlay
          worktreePath="/Users/tim/.t3/worktrees/t3code/board-wt"
          branch={null}
          threadCount={2}
          dropIntent={dropIntent}
        />,
      );

    expect(renderOverlay(null)).not.toContain("data-drop-intent");
    expect(renderOverlay("archive")).toContain('data-drop-intent="archive"');
  });
});
