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
    const sidebar = readSrc("components/LegacySidebar.tsx");
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
    const sidebarV2 = readSrc("components/Sidebar.tsx");
    expect(sidebarV2).toContain("Settled shelf");
    expect(sidebarV2).toMatch(/New thread|new thread/i);
    expect(sidebarV2).toContain("sidebar-pinned-divider");
    expect(sidebarV2).toContain("sidebar-snoozed-shelf-toggle");
    expect(sidebarV2).toContain("sidebar-settled-shelf-toggle");
    expect(sidebarV2).toContain("attemptPin");
    expect(sidebarV2).toContain("attemptUnpin");
  });

  it("Sidebar V2 View & filters keeps multi-env environment filter (shared storage)", () => {
    const sidebarV2 = readSrc("components/Sidebar.tsx");
    // Restacked ownership work once dropped this; without it multi-env users
    // cannot hide t3vm / secondary machines from the V2 inbox.
    expect(sidebarV2).toContain('data-testid="sidebar-view-options-trigger"');
    expect(sidebarV2).toContain('data-testid="sidebar-environment-filter-all"');
    expect(sidebarV2).toContain("sidebar-environment-filter-${environment.environmentId}");
    expect(sidebarV2).toContain("LIST_ENVIRONMENT_FILTER_STORAGE_KEY");
    expect(sidebarV2).toContain(
      "matchesEnvironmentFilter(thread.environmentId, selectedEnvironmentIds)",
    );
    expect(sidebarV2).toContain("toggleEnvironmentId");
  });

  it("classic sidebar marks composer draft threads", () => {
    const sidebar = readSrc("components/LegacySidebar.tsx");
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
    const sidebar = readSrc("components/LegacySidebar.tsx");
    expect(sidebar).toContain("useAiUsageSnapshot");
    expect(sidebar).toContain("resolveDriverUsage");
    expect(sidebar).toContain("usageDotFillClass");
    expect(sidebar).toContain("AiUsageStats");
    expect(sidebar).toContain("hasUsageMarker");
  });

  it("Sidebar V2 thread rows keep provider usage dots + stats", () => {
    const sidebarV2 = readSrc("components/Sidebar.tsx");
    expect(sidebarV2).toContain("useAiUsageSnapshot");
    expect(sidebarV2).toContain("resolveDriverUsage");
    expect(sidebarV2).toContain("usageDotFillClass");
    expect(sidebarV2).toContain("statusDotClassName");
    expect(sidebarV2).toContain("AiUsageStats");
    expect(sidebarV2).toContain('aria-label": "provider usage status"');
  });

  it("Sidebar V2 grouping changes ordering and headers without changing its row surface", () => {
    const sidebarV2 = readSrc("components/Sidebar.tsx");
    const webGrouping = readSrc("components/listEnvironmentFilter.ts");
    const mobileGrouping = readSrc("../../mobile/src/features/home/homeListMode.ts");
    const orderingContract = readSrc("../../../docs/sidebar-v2.md");
    expect(sidebarV2).toContain("sidebar-thread-grouping-${grouping}");
    expect(sidebarV2).toContain('data-testid="sidebar-thread-grouping"');
    expect(sidebarV2).toMatch(/size="icon"\s+type="button"\s+aria-label={`Thread ordering:/);
    expect(sidebarV2).toContain('aria-label="Filter threads by project"');
    expect(sidebarV2).toContain('grouping !== "none"');
    expect(sidebarV2).toContain('threadGrouping !== "recency"');
    expect(sidebarV2).toContain("orderForThreadGrouping(sortThreadsForSidebar(active))");
    expect(sidebarV2).toContain("sidebar-${section}-recency-${group.id}");
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

  it("identity claim gate and participant stack surfaces exist", () => {
    const gate = readSrc("components/identity/IdentityClaimGate.tsx");
    expect(gate).toContain('data-testid="identity-claim-gate"');
    expect(gate).toContain("Who are you?");
    expect(gate).toContain("identity-claim-suggestions");
    expect(gate).toContain("Save identity");
    expect(gate).toContain("requestIdentityClaimGate");
    expect(gate).toContain("isIdentityClaimRequiredMessage");
    // Multi-env: claim gate must not only target primary (smart-without-map + t3vm).
    expect(gate).toContain("forceClaimEnvironmentId");
    expect(gate).toContain("orderedEnvironmentIds");
    const stack = readSrc("components/identity/ParticipantStack.tsx");
    expect(stack).toContain('data-testid="participant-stack"');
    expect(stack).toContain('data-testid="participant-stack-popup"');
    expect(stack).toContain("<TooltipPopup");
    expect(stack).toContain("participantDisplayLabel");
    expect(stack).toContain("title={null}");
    expect(stack).toContain('data-testid={youParticipated ? "you-participated-indicator"');
    expect(stack).toContain("+{extras.length}");
    expect(stack).toContain('"bg-primary/15 text-primary ring-1 ring-primary/35"');
    expect(stack).not.toContain("<CheckIcon");
    expect(stack).toContain("highlighted={lead.personId === claimPersonId}");
    const avatar = readSrc("components/identity/IdentityAvatar.tsx");
    expect(avatar).toContain('props.highlighted ? "var(--primary)"');
    expect(stack).toContain("isClaimedNonStarterParticipant");
    expect(stack).toContain("· You");
    const stackLogic = readSrc("components/identity/ParticipantStack.logic.ts");
    expect(stackLogic).toContain('channels.join(",")');
    expect(stack).toContain('data-testid="source-channel-glyph"');
    expect(stack).toContain("export function ThreadIdentityMark");
    expect(stack).toContain("identity-unavailable hosts keep the same title");
    expect(stack).toContain(
      "<SourceChannelGlyph channel={props.channel ?? lead.firstChannel} overlay",
    );
    const sidebarV1 = readSrc("components/LegacySidebar.tsx");
    const sidebarV2 = readSrc("components/Sidebar.tsx");
    expect(sidebarV1).toContain("environmentId={thread.environmentId}");
    expect(sidebarV2).toContain("environmentId={thread.environmentId}");
    const root = readSrc("routes/__root.tsx");
    expect(root).toContain("IdentityClaimGate");
    const chat = readSrc("components/ChatView.tsx");
    expect(chat).toContain("requestIdentityClaimGate");
    expect(sidebarV2).toContain("ThreadIdentityMark");
    expect(sidebarV2).toContain("sidebar-ownership-filter-");
    expect(sidebarV1).toContain("ThreadIdentityMark");
    expect(sidebarV1).not.toContain("ThreadIdentityLeading");
    expect(sidebarV2).not.toContain("ThreadIdentityLeading");
  });

  it("sidebar v2 uses budgeted list VCS status so PR markers and auto-settle stay fresh", () => {
    const sidebar = readSrc("components/Sidebar.tsx");
    expect(sidebar).toContain("vcsEnvironment.listStatus({");
    expect(sidebar).not.toContain("vcsEnvironment.status({");
  });
});
