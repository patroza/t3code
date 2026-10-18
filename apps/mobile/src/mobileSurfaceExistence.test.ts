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
    expect(threadRoute).toMatch(/<ThreadPane>[\s\S]*?<ThreadDetailScreen/);
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
    // HomeHeader owns the title; route-level options must not overwrite the list-mode swap.
    expect(readSrc("features/home/HomeRouteScreen.tsx")).not.toContain(
      "getConnectionAwareBrandHeaderOptions",
    );
    // No surface may render the deleted in-list status pill again.
    expect(sidebar).not.toContain("WorkspaceConnectionStatus");
    expect(homeHeader).not.toContain("WorkspaceConnectionStatus");
  });

  it("keeps selectable markdown connected to the native GFM renderer", () => {
    const selectable = readSrc("native/SelectableMarkdownText.tsx");
    const nativeRenderer = readSrc("native/EnrichedMarkdownText.tsx");
    expect(selectable).toMatch(/return <MobileEnrichedMarkdownText[\s\S]*?\{\.\.\.props\}/);
    expect(nativeRenderer).toMatch(/<EnrichedMarkdownText[\s\S]*?markdown=\{markdown\}/);
    expect(nativeRenderer).toMatch(
      /<EnrichedMarkdownText[\s\S]*?flavor="github"[\s\S]*?selectable/,
    );
    expect(nativeRenderer).toContain("selectionClipboard={selectionClipboard}");
    expect(nativeRenderer).toContain("props.contextClipboardFragment");
  });

  it("keeps historical sender captions beside upstream handoff rows", () => {
    const feed = readSrc("features/threads/ThreadFeed.tsx");
    const detail = readSrc("features/threads/ThreadDetailScreen.tsx");
    const route = readSrc("features/threads/ThreadRouteScreen.tsx");
    expect(feed).toContain("<UserMessageSenderCaption");
    expect(feed).toContain("message.source ?? props.messageSourceById?.get(message.id)");
    expect(feed).toContain("<ThreadHandoffDivider");
    expect(feed).toContain("<ThreadHandoffRow");
    expect(detail).toContain("messageSourceById={props.messageSourceById}");
    expect(detail).toContain("pendingHandoff={props.pendingHandoff}");
    expect(route).toContain("messageSourceById={userMessageSources}");
    expect(route).toContain("pendingHandoff={composer.pendingHandoff}");
  });

  it("keeps the iOS settings cog and ownership chip on the thread list", () => {
    const toolbar = readSrc("features/workspace/WorkspaceToolbar.ios.tsx");
    const filters = readSrc("features/home/ThreadListFilters.tsx");
    const ownership = readSrc("features/home/thread-list-ownership-filter.ts");
    expect(toolbar).toContain('accessibilityLabel="Open settings"');
    expect(toolbar).toContain('icon="gearshape"');
    expect(toolbar).not.toContain("Thread filters and settings");
    expect(filters).toContain('accessibilityLabel="Filter threads by environment"');
    expect(filters).toContain('accessibilityLabel="Filter threads by project"');
    expect(filters).toContain('accessibilityLabel="Filter threads by ownership"');
    expect(filters).toContain("ownershipFilterMenuActions");
    expect(ownership).toContain("Mine includes");
    expect(ownership).toContain("Theirs includes");
  });
});
