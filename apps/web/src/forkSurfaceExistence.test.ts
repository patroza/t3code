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
    expect(sidebarV2).toContain("ComposerDraftDot");
    expect(sidebarV2).toContain("hasComposerDraftMessage");
  });

  it("classic sidebar marks composer draft threads", () => {
    const sidebar = readSrc("components/Sidebar.tsx");
    expect(sidebar).toContain("ComposerDraftDot");
    expect(sidebar).toContain("hasComposerDraftMessage");
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

  it("queued message chips keep edit + steer labels", () => {
    const chips = readSrc("components/chat/QueuedMessageChips.tsx");
    expect(chips).toContain('aria-label="Edit queued message"');
    expect(chips).toContain("Steer: send now, interrupting the current step");
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
    const stackLogic = readSrc("components/identity/ParticipantStack.logic.ts");
    expect(stackLogic).toContain('channels.join(",")');
    expect(stack).toContain('data-testid="source-channel-glyph"');
    const root = readSrc("routes/__root.tsx");
    expect(root).toContain("IdentityClaimGate");
    const chat = readSrc("components/ChatView.tsx");
    expect(chat).toContain("requestIdentityClaimGate");
    const sidebarV2 = readSrc("components/SidebarV2.tsx");
    expect(sidebarV2).toContain("ParticipantStack");
    expect(sidebarV2).toContain("sidebar-v2-ownership-filter-");
    const sidebarV1 = readSrc("components/Sidebar.tsx");
    expect(sidebarV1).toContain("ParticipantStack");
    expect(sidebarV1).toContain("SourceChannelGlyph");
  });
});
