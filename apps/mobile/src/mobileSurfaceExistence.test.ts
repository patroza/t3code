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
    const route = readSrc("features/threads/ThreadRouteScreen.tsx");
    const host = readSrc("features/threads/ThreadScreenHost.tsx");
    expect(route).toContain("<ThreadScreenHost>");
    expect(route).toContain("<ThreadScreenBinding");
    expect(host).toContain('testID="thread-conversation-surface"');
    expect(host).toMatch(/testID="thread-conversation-surface"[\s\S]*?style=\{\{\s*flex: 1\s*\}\}/);
    expect(host).toMatch(/<ThreadDetailScreen[\s\S]*?\{\.\.\.content.props\}/);
    expect(host).toMatch(/testID="thread-conversation-surface"[\s\S]*?<ThreadScreenOutlet/);
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

  it("keeps thread prefetch alongside pull-request sheet actions in both lists", () => {
    const row = readSrc("features/threads/thread-list-v2-items.tsx");
    expect(row).toMatch(
      /onPressIn=\{\(\) => \{\s*prefetchEnvironmentThread\(thread\.environmentId, thread\.id\)/,
    );
    expect(row).toContain("accessibilityActions={rowAccessibilityActions}");
    expect(row).toContain('actionName === "openPullRequests"');
    expect(readSrc("features/home/HomeScreen.tsx")).toContain(
      "onOpenThreadPullRequests={handleOpenThreadPullRequests}",
    );
    expect(readSrc("features/threads/ThreadNavigationSidebar.tsx")).toContain(
      "onOpenThreadPullRequests={handleOpenThreadPullRequests}",
    );
    expect(readSrc("Stack.tsx")).toContain("screen: ThreadPullRequestsSheet");
  });

  it("opens the fork's /new command in the persistent draft route", () => {
    const composer = readSrc("features/threads/ThreadComposer.tsx");
    expect(composer).toContain('parseStandaloneComposerSlashCommand(draftMessage) === "new"');
    expect(composer).toMatch(/selectThreadRoute\(\{\s*draft: \{/);
    expect(composer).not.toContain('"NewTaskSheet"');
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
    // The workspace now owns the iOS title and keeps the fork's selected list mode.
    const workspace = readSrc("features/workspace/WorkspaceRootScreen.tsx");
    expect(workspace).toContain("HOME_LIST_MODE_TITLES[listMode]");
    expect(workspace).toMatch(/<WorkspaceConnectionTitle[\s\S]*?\{props.title\}/);
    expect(homeHeader).toContain('accessibilityLabel="Thread list options"');
    expect(homeHeader).toContain("HOME_LIST_MODES.map");
    expect(homeHeader).toContain("HOME_THREAD_GROUPINGS.map");
    expect(homeHeader).toContain("Hide settled");
    expect(homeHeader).not.toContain("headerSearchBarOptions");
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
