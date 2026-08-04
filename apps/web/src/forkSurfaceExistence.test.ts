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
    // Hide-settled must use row-lifted PR state (merged/closed auto-settle),
    // same as Sidebar V2 — never hard-code changeRequestState: null here.
    expect(sidebar).toContain("changeRequestStateByKey");
    expect(sidebar).toContain("SidebarChangeRequestStateContext");
    expect(sidebar).not.toContain("changeRequestState: null");
  });

  it("Sidebar V2 keeps Settled shelf labeling and new-thread affordance", () => {
    const sidebarV2 = readSrc("components/SidebarV2.tsx");
    expect(sidebarV2).toContain("Settled shelf");
    expect(sidebarV2).toMatch(/New thread|new thread/i);
    expect(sidebarV2).toContain("sidebar-v2-pinned-divider");
    expect(sidebarV2).toContain("sidebar-v2-snoozed-shelf-toggle");
    expect(sidebarV2).toContain("sidebar-v2-settled-shelf-toggle");
    expect(sidebarV2).toContain("attemptPin");
    expect(sidebarV2).toContain("attemptUnpin");
  });

  it("classic sidebar marks composer draft threads", () => {
    const sidebar = readSrc("components/Sidebar.tsx");
    expect(sidebar).toContain("ComposerDraftDot");
    expect(sidebar).toContain("hasComposerDraftMessage");
  });

  it("web deep links stay on shared changes (not discord-only)", () => {
    const root = readSrc("routes/__root.tsx");
    expect(root).toContain("OmegentDeepLinkCoordinator");
    expect(readSrc("components/OmegentDeepLinkCoordinator.tsx")).toContain(
      "OmegentDeepLinkCoordinator",
    );
    expect(readSrc("deepLinks.ts")).toMatch(/thread|message/i);
    const chat = readSrc("components/ChatView.tsx");
    expect(chat).toMatch(/deepLink|message-|scrollIntoView/i);
  });

  it("chat header keeps remote Open in VS Code control markers", () => {
    const header = readSrc("components/chat/ChatHeader.tsx");
    expect(header).toContain("shouldOfferRemoteVscodeOpen");
    expect(header).toContain("Open in VS Code Remote SSH on");
    expect(header).toContain("shell.openExternal");
  });

  it("chat header keeps AI usage status and host resource gauges", () => {
    const header = readSrc("components/chat/ChatHeader.tsx");
    expect(header).toContain("HostResourceStatus");
    expect(header).toContain('aria-label="provider usage status"');
    expect(header).toContain("AiUsageStats");
    expect(header).toContain("useAiUsageSnapshot");
    const chatView = readSrc("components/ChatView.tsx");
    expect(chatView).toContain("activeThreadDriverKind=");
    expect(chatView).toContain("activeThreadModel=");
    expect(chatView).toContain("isPreparingWorktree=");
  });

  it("thread detail loading keeps every composer send path disabled", () => {
    const chatView = readSrc("components/ChatView.tsx");
    expect(chatView).toContain(
      'sendDisabledReason={threadDetailLoading ? "Messages loading" : null}',
    );

    const composer = readSrc("components/chat/ChatComposer.tsx");
    expect(composer).toContain("const isSendDisabled = sendDisabledReason !== null");
    expect(composer).toContain("if (noProviderAvailable || isSendDisabled)");
    expect(composer.match(/sendDisabledReason=\{sendDisabledReason\}/g)).toHaveLength(3);
    expect(composer).not.toContain("sendDisabledReason={null}");
  });

  it("model picker keeps provider usage dots and selection-box stats", () => {
    const providerPicker = readSrc("components/chat/ProviderModelPicker.tsx");
    expect(providerPicker).toContain("usageSnapshot");
    expect(providerPicker).toContain("statusDotClassName");
    expect(providerPicker).toContain("AiUsageStats");
    const modelPickerContent = readSrc("components/chat/ModelPickerContent.tsx");
    expect(modelPickerContent).toContain("resolveDriverUsages");
    expect(modelPickerContent).toContain("AiUsageStats");
    const modelPickerSidebar = readSrc("components/chat/ModelPickerSidebar.tsx");
    expect(modelPickerSidebar).toContain("statusDotClassName");
    expect(modelPickerSidebar).toContain("usageDotFillClass");
  });

  it("classic sidebar thread rows keep provider usage dots + stats", () => {
    const sidebar = readSrc("components/Sidebar.tsx");
    expect(sidebar).toContain("useAiUsageSnapshot");
    expect(sidebar).toContain("resolveDriverUsage");
    expect(sidebar).toContain("usageDotFillClass");
    expect(sidebar).toContain("AiUsageStats");
    expect(sidebar).toContain("hasUsageMarker");
  });

  it("Sidebar V2 thread rows keep provider usage dots + stats", () => {
    const sidebarV2 = readSrc("components/SidebarV2.tsx");
    expect(sidebarV2).toContain("useAiUsageSnapshot");
    expect(sidebarV2).toContain("resolveDriverUsage");
    expect(sidebarV2).toContain("usageDotFillClass");
    expect(sidebarV2).toContain("statusDotClassName");
    expect(sidebarV2).toContain("AiUsageStats");
    expect(sidebarV2).toContain('aria-label": "provider usage status"');
  });

  it("Sidebar V2 grouping changes ordering and headers without changing its row surface", () => {
    const sidebarV2 = readSrc("components/SidebarV2.tsx");
    const webGrouping = readSrc("components/listEnvironmentFilter.ts");
    const mobileGrouping = readSrc("../../mobile/src/features/home/homeListMode.ts");
    const orderingContract = readSrc("../../../docs/sidebar-v2.md");
    expect(sidebarV2).toContain("sidebar-v2-thread-grouping-${grouping}");
    expect(sidebarV2).toContain('data-testid="sidebar-v2-thread-grouping"');
    expect(sidebarV2).toMatch(/size="icon"\s+type="button"\s+aria-label={`Thread ordering:/);
    expect(sidebarV2).toContain('aria-label="Filter threads by project"');
    expect(sidebarV2).toContain('grouping !== "none"');
    expect(sidebarV2).toContain('threadGrouping !== "recency"');
    expect(sidebarV2).toContain("orderForThreadGrouping(sortThreadsForSidebarV2(active))");
    expect(sidebarV2).toContain("sidebar-v2-${section}-recency-${group.id}");
    expect(sidebarV2).toContain('const rowVariant = isCard ? "card" : "slim"');
    expect(webGrouping).toContain('project: "Group by default"');
    expect(mobileGrouping).toContain('project: "Group by default"');
    expect(orderingContract).toContain("Do not make `project` group V2 rows by project");
    expect(orderingContract).toContain("pinned cards remain above active cards");
    expect(orderingContract).toContain("Recency headers may partition");

    const mobileHome = readSrc("../../mobile/src/features/home/HomeScreen.tsx");
    const mobileSidebar = readSrc("../../mobile/src/features/threads/ThreadNavigationSidebar.tsx");
    for (const source of [mobileHome, mobileSidebar]) {
      expect(source).toContain('threadGrouping === "recency"');
      expect(source).toContain("orderByRecency:");
      expect(source).toContain("groupByRecency:");
    }
  });

  it("every send path routes on the steering-queue prediction", () => {
    const chatView = readSrc("components/ChatView.tsx");
    // Both send paths (composer + plan follow-up) branch on the prediction:
    // queue-bound sends become chips, everything else takes the live edge.
    expect(chatView.match(/sendEntersSteeringQueue\(\{/g)).toHaveLength(2);
    expect(chatView).toContain("hasPendingTurnStart: activeThread.pendingTurnStart !== null");
    expect(
      chatView.match(
        /setOptimisticQueuedMessageIds\(\(existing\) => new Set\(existing\)\.add\(messageIdForSend\)\)/g,
      ),
    ).toHaveLength(2);
    // The chips render the merged list, never the raw server queue.
    expect(chatView).toContain("queuedMessages={displayQueuedMessages}");
  });

  it("queued message chips keep edit + send-now labels", () => {
    const chips = readSrc("components/chat/QueuedMessageChips.tsx");
    expect(chips).toContain('aria-label="Edit queued message"');
    expect(chips).toContain('aria-label="Send queued message now"');
    expect(chips).toContain("Remove from queue and edit in composer");
  });

  it("git action menu keeps the GitHub pull request list link", () => {
    const gitActions = readSrc("components/GitActionsControl.tsx");
    expect(gitActions).toContain('aria-label="View GitHub pull requests"');
    expect(gitActions).toContain("openPullRequestList");
    expect(gitActions).toContain("`${repositoryUrl}/pulls`");
  });

  it("sidebar v2 uses budgeted list VCS status so PR markers and auto-settle stay fresh", () => {
    const sidebar = readSrc("components/SidebarV2.tsx");
    expect(sidebar).toContain("vcsEnvironment.listStatus({");
    expect(sidebar).not.toContain("vcsEnvironment.status({");
  });
});
