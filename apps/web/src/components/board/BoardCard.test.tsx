import { DndContext } from "@dnd-kit/core";
import {
  DEFAULT_RUNTIME_MODE,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type VcsStatusResult,
} from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type { SidebarThreadSummary } from "../../types";
import { BoardCard, BoardCardDragOverlay } from "./BoardCard";

const environmentId = EnvironmentId.make("environment-local");

function makeThread(overrides: Partial<SidebarThreadSummary> = {}): SidebarThreadSummary {
  return {
    id: ThreadId.make("thread-1"),
    environmentId,
    projectId: ProjectId.make("project-1"),
    title: "Fix board keyboard semantics",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: "default",
    session: null,
    createdAt: "2026-07-22T09:00:00.000Z",
    updatedAt: "2026-07-22T10:00:00.000Z",
    archivedAt: null,
    latestTurn: null,
    latestUserMessageAt: "2026-07-22T09:30:00.000Z",
    branch: "feature/board",
    worktreePath: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    settledOverride: null,
    settledAt: null,
    ...overrides,
  };
}

function makeGitStatus(): VcsStatusResult {
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
    pr: {
      number: 42,
      title: "Board controls",
      url: "https://github.com/example/repo/pull/42",
      baseRef: "main",
      headRef: "feature/board",
      state: "open",
    },
  };
}

function renderCard(thread: SidebarThreadSummary = makeThread(), isSettled = false): string {
  return renderToStaticMarkup(
    <DndContext>
      <BoardCard
        thread={thread}
        project={null}
        gitStatus={makeGitStatus()}
        gitStatusPending={false}
        isSettled={isSettled}
        onOpenThread={() => {}}
        onShowContextMenu={() => {}}
        dragClickGuard={{
          startDrag: () => {},
          finishDrag: () => {},
          consumeSuppressedClick: () => false,
          dispose: () => {},
        }}
      />
    </DndContext>,
  );
}

describe("BoardCard", () => {
  it("uses a noninteractive card root and a native open-thread button", () => {
    const markup = renderCard();
    const rootTag = markup.match(/<div[^>]*data-testid="board-card-thread-1"[^>]*>/)?.[0];

    expect(rootTag).toBeDefined();
    expect(rootTag).not.toContain('role="button"');
    expect(rootTag).not.toContain('tabindex="0"');
    expect(markup).toContain('<button type="button"');
    expect(markup).toContain('aria-label="Open thread: Fix board keyboard semantics"');
    expect(markup).toContain('data-testid="board-card-open-thread-1"');
  });

  it("renders the open-thread and PR buttons as two separate controls", () => {
    const markup = renderCard();
    const openButtonStart = markup.indexOf('data-testid="board-card-open-thread-1"');
    const openButtonEnd = markup.indexOf("</button>", openButtonStart);
    const prButtonStart = markup.indexOf('<button type="button"', openButtonEnd);

    expect(markup.match(/<button\b/g)).toHaveLength(2);
    expect(openButtonStart).toBeGreaterThan(-1);
    expect(openButtonEnd).toBeGreaterThan(openButtonStart);
    expect(prButtonStart).toBeGreaterThan(openButtonEnd);
    expect(markup.slice(openButtonStart, openButtonEnd)).not.toContain("#42");
  });

  it("shows the plan-only indicator only for plan-mode threads", () => {
    const markup = renderCard(makeThread({ interactionMode: "plan" }));

    expect(markup).toContain('data-testid="thread-plan-mode-thread-1"');
    expect(markup).toContain('aria-label="Plan-only thread"');
    expect(renderCard()).not.toContain('data-testid="thread-plan-mode-thread-1"');
  });

  it("shows the sidebar-v2 status indicator for active threads", () => {
    const runningThread = makeThread({
      session: {
        threadId: ThreadId.make("thread-1"),
        status: "running",
        providerName: "Codex",
        providerInstanceId: ProviderInstanceId.make("codex"),
        runtimeMode: DEFAULT_RUNTIME_MODE,
        activeTurnId: "turn-1" as never,
        lastError: null,
        updatedAt: "2026-07-22T10:00:00.000Z",
      },
    });
    const markup = renderCard(runningThread);

    expect(markup).toContain('role="status"');
    expect(markup).toContain(">Working</span>");
    // Ready threads without an unread completion stay unlabeled.
    expect(renderCard()).not.toContain('role="status"');
  });

  it("replaces the status indicator with the settled indicator when settled", () => {
    const runningThread = makeThread({
      session: {
        threadId: ThreadId.make("thread-1"),
        status: "running",
        providerName: "Codex",
        providerInstanceId: ProviderInstanceId.make("codex"),
        runtimeMode: DEFAULT_RUNTIME_MODE,
        activeTurnId: "turn-1" as never,
        lastError: null,
        updatedAt: "2026-07-22T10:00:00.000Z",
      },
    });

    const settledMarkup = renderCard(runningThread, true);
    expect(settledMarkup).toContain('data-testid="thread-settled-thread-1"');
    expect(settledMarkup).toContain('aria-label="Settled thread"');
    expect(settledMarkup).not.toContain(">Working</span>");
    expect(renderCard()).not.toContain('data-testid="thread-settled-thread-1"');
  });
});

describe("BoardCardDragOverlay", () => {
  it("is hidden from assistive technology and contains no focusable controls", () => {
    const markup = renderToStaticMarkup(
      <BoardCardDragOverlay
        thread={makeThread()}
        project={null}
        gitStatus={makeGitStatus()}
        gitStatusPending={false}
        isSettled={false}
      />,
    );

    expect(markup).toContain('aria-hidden="true"');
    expect(markup).not.toContain("<button");
    expect(markup).not.toContain("<a ");
    expect(markup).not.toContain("tabindex=");
  });

  it("reflects the pending drop intent so feedback is visible under the card", () => {
    const renderOverlay = (dropIntent: "archive" | "trash" | null) =>
      renderToStaticMarkup(
        <BoardCardDragOverlay
          thread={makeThread()}
          project={null}
          gitStatus={makeGitStatus()}
          gitStatusPending={false}
          isSettled={false}
          dropIntent={dropIntent}
        />,
      );

    expect(renderOverlay(null)).not.toContain("data-drop-intent");
    expect(renderOverlay("archive")).toContain('data-drop-intent="archive"');
    expect(renderOverlay("trash")).toContain('data-drop-intent="trash"');
  });
});
