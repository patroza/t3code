/**
 * Existence contracts for fork-only product surfaces that pure helper tests can
 * leave green after a partial stack conflict resolution (see #154).
 *
 * Prefer pure behavior tests next to each feature; keep this file as the last
 * line of defense for JSX chrome that is easy to drop while helpers remain.
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

describe("fork surface existence (anti stack-drop)", () => {
  it("classic sidebar keeps the collapsible Settled shelf chrome", () => {
    const sidebar = readSrc("components/Sidebar.tsx");
    expect(sidebar).toContain('data-testid="sidebar-v1-settled-shelf-toggle"');
    expect(sidebar).toContain("Hide settled");
    expect(sidebar).toContain('data-testid="sidebar-v1-settled-recency-headers"');
    expect(sidebar).toContain("sidebar-v1-settled-recency-");
    // Settled recent rows use V2-like slim history chrome without list VCS.
    expect(sidebar).toContain("recent-thread-settled-");
    expect(sidebar).toContain("Un-settle thread");
    expect(sidebar).toContain("!props.isSettled");
  });

  it("Sidebar V2 keeps Settled shelf labeling and new-thread affordance", () => {
    const sidebarV2 = readSrc("components/SidebarV2.tsx");
    expect(sidebarV2).toContain("Settled shelf");
    expect(sidebarV2).toMatch(/New thread|new thread/i);
    expect(sidebarV2).toContain("ProjectServerContextLine");
    // Recent mode (shared thread grouping) + no VCS on settled history rows.
    expect(sidebarV2).toContain("sidebar-v2-thread-grouping-");
    expect(sidebarV2).toContain("sidebar-v2-active-recency-");
    expect(sidebarV2).toContain("isSettledHistoryRow");
    expect(sidebarV2).toContain("LIST_THREAD_GROUPING_STORAGE_KEY");
  });

  it("chat header keeps remote Open in VS Code control markers", () => {
    const header = readSrc("components/chat/ChatHeader.tsx");
    expect(header).toContain("shouldOfferRemoteVscodeOpen");
    expect(header).toContain("Open in VS Code Remote SSH on");
    expect(header).toContain("shell.openExternal");
  });

  it("queued message chips keep edit + steer labels", () => {
    const chips = readSrc("components/chat/QueuedMessageChips.tsx");
    expect(chips).toContain('aria-label="Edit queued message"');
    expect(chips).toContain("Steer: send now, interrupting the current step");
  });
});
