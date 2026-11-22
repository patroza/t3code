/** Guard fork surfaces whose hooks in upstream files can drop out in a merge while helper tests stay green. */
// @effect-diagnostics nodeBuiltinImport:off - existence contract reads source text on disk.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { describe, expect, it } from "vite-plus/test";

const root = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));

function readSrc(relativePath: string): string {
  return NodeFS.readFileSync(NodePath.join(root, relativePath), "utf8");
}

// Each entry names a fork hook (fork-owned text) and the file that must keep it.
const identityHooks: ReadonlyArray<readonly [file: string, hook: string]> = [
  ["routes/__root.tsx", "<IdentityClaimGate />"],
  ["components/Sidebar.tsx", "useOwnedThreads(useQuietThreadShells())"],
  ["components/sidebar/SidebarThreadHeader.tsx", "<SidebarOwnershipFilter />"],
  ["components/sidebar/SidebarThreadRow.tsx", "<SidebarThreadIdentityMark thread={thread} />"],
  ["components/chat/TimelineUserMessageRow.tsx", "<MessageSenderCaption message={row.message} />"],
  ["components/chat/MessagesTimeline.tsx", "messageSender,"],
  ["components/ChatView.tsx", "messageSender={messageSender}"],
  ["components/settings/AuthorizedClientsSettings.tsx", "<McpClientIdentityControl"],
];

describe("fork identity surfaces", () => {
  it.each(identityHooks)("%s keeps %s", (file, hook) => {
    expect(readSrc(file)).toContain(hook);
  });

  it("keeps the identity controls addressable", () => {
    expect(readSrc("components/identity/IdentityClaimGate.tsx")).toContain(
      'data-testid="identity-claim-gate"',
    );
    expect(readSrc("components/identity/ParticipantStack.tsx")).toContain(
      'data-testid="participant-stack"',
    );
    expect(readSrc("components/sidebar/SidebarOwnershipFilter.tsx")).toContain(
      'data-testid="sidebar-ownership-filter"',
    );
    expect(readSrc("components/chat/MessageSenderCaption.tsx")).toContain(
      'data-testid="message-sender-caption"',
    );
    expect(readSrc("components/settings/McpClientIdentityControl.tsx")).toContain(
      'data-testid="mcp-client-identity"',
    );
  });
});
