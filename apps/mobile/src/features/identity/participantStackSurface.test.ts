import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";
import { describe, expect, it } from "vite-plus/test";

function readSource(relativePath: string): string {
  return NodeFS.readFileSync(NodeURL.fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

describe("mobile participation indicator surface", () => {
  it("keeps the claimed-participant marker wired across mobile thread lists", () => {
    const stack = readSource("./ParticipantStack.tsx");
    const listV1 = readSource("../threads/thread-list-items.tsx");
    const listV2 = readSource("../threads/thread-list-v2-items.tsx");
    const board = readSource("../board/BoardScreen.tsx");

    expect(stack).toContain('testID={youParticipated ? "you-participated-indicator"');
    expect(stack).toContain("+{extras.length}");
    expect(stack).toContain('"border border-primary bg-primary/15"');
    expect(stack).not.toContain(">✓</Text>");
    expect(stack).toContain("isClaimedNonStarterParticipant");
    expect(stack).toContain("You participated");
    expect(listV1).toContain("environmentId={thread.environmentId}");
    expect(listV2).toContain("environmentId={thread.environmentId}");
    expect(board).toContain("environmentId={props.thread.environmentId}");
  });
});
