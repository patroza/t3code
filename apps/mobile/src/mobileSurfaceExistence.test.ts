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
