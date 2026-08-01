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
      /testID="thread-conversation-surface"[\s\S]*?style=\{\{ flex: 1 \}\}/,
    );
    expect(threadRoute).toMatch(
      /<View className="flex-1" style=\{\{ flex: 1 \}\}>[\s\S]*?<ThreadDetailScreen/,
    );
  });

  it("renders settled threads as slim history rows in the classic thread lists", () => {
    const listItems = readSrc("features/threads/thread-list-items.tsx");

    // The settled branch must stay wired into the shared row renderer: a
    // whole-file conflict resolve that keeps the helper but drops the branch
    // would silently restore full-size settled rows.
    expect(listItems).toContain('testID="thread-list-row-settled"');
    expect(listItems).toMatch(/isSettled \? \(\s*settledRowContent\(close\)/);
    expect(listItems).toContain("resolveSettledRowTimestamp");
    // Slim chrome: dimmed favicon, one muted title line, no status pill.
    expect(listItems).toMatch(
      /testID="thread-list-row-settled"[\s\S]*?text-foreground-muted[\s\S]*?<\/Pressable>/,
    );
    expect(listItems).toMatch(/settledRowContent[\s\S]*?opacity-40[\s\S]*?ProjectFavicon/);
  });

  it("keys markdown nodes uniquely even when parser spans collide", () => {
    const nodeKey = NodeFS.readFileSync(
      NodePath.join(root, "../modules/t3-markdown-text/src/markdownNodeKey.ts"),
      "utf8",
    );
    const tableBlock = NodeFS.readFileSync(
      NodePath.join(root, "../modules/t3-markdown-text/src/NativeMarkdownBlock.ios.tsx"),
      "utf8",
    );
    // Grid keys for tables (never type:beg:end → table_cell:0:0).
    expect(nodeKey).toContain("markdownTableCellKey");
    expect(nodeKey).toContain("i${index}");
    expect(tableBlock).toContain("markdownTableCellKey");
    expect(tableBlock).toContain("key={markdownTableCellKey(rowIndex, cellIndex)}");
  });
});
