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

  it("keeps the feed still for sends the server will hold in the steering queue", () => {
    const composerState = readSrc("state/use-thread-composer-state.ts");
    const detailScreen = readSrc("features/threads/ThreadDetailScreen.tsx");

    // The prediction is the shared one (same rule as the server decider and
    // the web client), not a mobile-local re-derivation that can drift.
    expect(composerState).toContain('from "@t3tools/shared/chatList"');
    expect(composerState).toContain("sendEntersSteeringQueue({");
    expect(composerState).toContain("hasPendingTurnStart:");

    // A queue-bound send must move neither the viewport nor the anchor: both
    // live inside the guard, and the anchor would otherwise stay armed and
    // fire whenever the queue eventually drains.
    expect(detailScreen).toMatch(
      /if \(!sendWillQueue\) \{[\s\S]*?scrollToEnd\(\{ animated: false \}\)[\s\S]*?setAnchorMessageId\(messageId\)[\s\S]*?\}/,
    );
  });

  it('"Send now" moves the message optimistically and can put it back', () => {
    const composerState = readSrc("state/use-thread-composer-state.ts");

    // The feed and the chip list both read the promoted detail, so one piece
    // of state moves the message and one revert puts it back.
    expect(composerState).toContain("promoteSteeredQueuedMessages(selectedThreadDetail");
    expect(composerState).toMatch(/buildThreadFeed\(steeredDetail\)/);
    expect(composerState).toMatch(/timelineIds = new Set\(steeredDetail\?\.messages/);
    // Failure puts it back rather than leaving a bubble the agent never got.
    expect(composerState).toMatch(
      /if \(result\._tag === "Success"\) \{[\s\S]*?return;[\s\S]*?\}[\s\S]*?pruneSteeringQueuedMessageIds\([\s\S]*?setPendingConnectionError/,
    );
  });

  it("keeps list-mode titles under the connection-status title swap", () => {
    // Upstream's connection-aware header hardcodes the brand lockup and the
    // literal "Threads" (#5372). This fork's headers show a list-mode title
    // (Threads / Projects / Board), so every surface that adopts the swap has
    // to pass its own title through — a plain adoption silently renames Board
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
