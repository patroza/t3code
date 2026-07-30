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
});
