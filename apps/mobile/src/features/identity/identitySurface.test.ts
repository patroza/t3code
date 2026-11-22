import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";
import { describe, expect, it } from "vite-plus/test";

function readSource(relativePath: string): string {
  return NodeFS.readFileSync(NodeURL.fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

// Asserts only the fork's hooks into upstream files, so dropping one fails here.
describe("mobile identity surfaces", () => {
  it.each([
    ["../../App.tsx", "<IdentityClaimGate />"],
    ["../home/HomeRouteScreen.tsx", "useOwnershipFilteredThreads("],
    ["../home/HomeRouteScreen.tsx", "withOwnershipFilter("],
    ["../threads/ThreadNavigationSidebar.tsx", "useOwnershipFilteredThreads("],
    ["../threads/ThreadNavigationSidebar.tsx", "withOwnershipFilter("],
    ["../home/ThreadListFilters.tsx", "<OwnershipFilterChip />"],
    ["../threads/thread-list-v2-items.tsx", "<ThreadShellIdentityMark thread={thread} />"],
    ["../threads/ThreadFeed.tsx", "props.renderMessageSender?.(message.id)"],
    ["../threads/ThreadDetailScreen.tsx", "renderMessageSender={renderMessageSender("],
    ["../../persistence/mobile-preferences.ts", "sanitizeOwnershipPreferences(parsed)"],
  ])("%s keeps %s", (file, hook) => {
    expect(readSource(file)).toContain(hook);
  });
});
