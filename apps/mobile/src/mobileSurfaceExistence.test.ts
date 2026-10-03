/**
 * Existence contracts for mobile product surfaces that stack conflict
 * resolution can accidentally leave structurally present but unrenderable.
 */
// @effect-diagnostics nodeBuiltinImport:off - existence contract reads source text on disk.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { describe, expect, it } from "vite-plus/test";

const root = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));

function readSrc(relativePath: string): string {
  return NodeFS.readFileSync(NodePath.join(root, relativePath), "utf8");
}

describe("mobile surface existence (anti stack-drop)", () => {
  it("keeps the conversation feed inside an explicit flex host", () => {
    const threadRoute = readSrc("features/threads/ThreadRouteScreen.tsx");

    expect(threadRoute).toContain('testID="thread-conversation-surface"');
    expect(threadRoute).toMatch(
      /testID="thread-conversation-surface"[\s\S]*?style=\{\{\s*flex: 1\s*\}\}/,
    );
    // Inner host stays a real flex container so the composer overlay still
    // anchors to the true bottom. Android uses a canvas class and rounded
    // corners; iOS stays flex-1.
    expect(threadRoute).toMatch(
      /testID="thread-conversation-surface"[\s\S]*?flex: 1[\s\S]*?<ThreadDetailScreen/,
    );
  });

  it("renders settled threads as slim history rows in the v2 thread list", () => {
    const listItems = readSrc("features/threads/thread-list-v2-items.tsx");

    // The settled branch must stay wired into the v2 row renderer: a
    // whole-file conflict resolve that keeps the helper but drops the branch
    // would silently restore full-size settled rows.
    expect(listItems).toContain('testID="thread-list-row-settled"');
    expect(listItems).toMatch(
      /testID="thread-list-row-settled"[\s\S]*?opacity-40[\s\S]*?ProjectFavicon/,
    );
  });

  it("keeps native queued-message editing and steering reachable", () => {
    const detail = readSrc("features/threads/ThreadDetailScreen.tsx");
    const controls = readSrc("features/threads/ThreadQueueControl.tsx");
    expect(detail).toContain("useThreadQueuedCount");
    expect(detail).toContain("queuedRunEdit");
    expect(controls).toContain("threadEnvironment.promoteQueuedRun");
    expect(controls).toContain("threadEnvironment.cancelQueuedRun");
  });

  it("keeps list-mode titles under the connection-status title swap", () => {
    // Upstream's connection-aware header hardcodes the brand lockup and the
    // literal "Threads" (#5372). This fork's headers show a list-mode title
    // (Threads / Projects), so every surface that adopts the swap has
    // to pass its own title through — a plain adoption silently renames
    // and Projects to "Threads", which is exactly what slipped through once.
    const sidebar = NodeFS.readFileSync(
      NodePath.join(root, "features/threads/ThreadNavigationSidebar.tsx"),
      "utf8",
    );
    const homeHeader = NodeFS.readFileSync(
      NodePath.join(root, "features/home/HomeHeader.tsx"),
      "utf8",
    );

    // Native header slot (iOS split) and the custom large title (Android split).
    expect(sidebar).toMatch(
      /getConnectionAwareBrandHeaderOptions\(\{[\s\S]*?title: HOME_LIST_MODE_TITLES\[options\.listMode\]/,
    );
    expect(sidebar).toMatch(
      /<WorkspaceConnectionTitle[\s\S]*?\{HOME_LIST_MODE_TITLES\[options\.listMode\]\}/,
    );
    // iOS Home owns its native title, so the swap has to live there too.
    expect(homeHeader).toMatch(
      /getConnectionAwareBrandHeaderOptions\(\{[\s\S]*?title: headerTitle/,
    );
    // No surface may render the deleted in-list status pill again.
    expect(sidebar).not.toContain("WorkspaceConnectionStatus");
    expect(homeHeader).not.toContain("WorkspaceConnectionStatus");
  });

  it("keys markdown nodes uniquely even when parser spans collide", () => {
    const nodeKey = NodeFS.readFileSync(
      NodePath.join(root, "../modules/t3-markdown-text/src/markdownNodeKey.ts"),
      "utf8",
    );
    const tableBlock = NodeFS.readFileSync(
      NodePath.join(root, "../modules/t3-markdown-text/src/NativeMarkdownBlock.tsx"),
      "utf8",
    );
    // Grid keys for tables (never type:beg:end → table_cell:0:0).
    expect(nodeKey).toContain("markdownTableCellKey");
    expect(nodeKey).toContain("i${index}");
    expect(tableBlock).toContain("markdownTableCellKey");
    expect(tableBlock).toContain("key={markdownTableCellKey(rowIndex, cellIndex)}");
  });
});
