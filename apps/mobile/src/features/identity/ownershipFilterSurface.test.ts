import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";
import { describe, expect, it } from "vite-plus/test";

function readSource(relativePath: string): string {
  return NodeFS.readFileSync(NodeURL.fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

describe("mobile ownership filter surface", () => {
  it("keeps ownership controls wired in both phone and sidebar thread lists", () => {
    const homeHeader = readSource("../home/HomeHeader.tsx");
    const homeRoute = readSource("../home/HomeRouteScreen.tsx");
    const sidebar = readSource("../threads/ThreadNavigationSidebar.tsx");

    expect(homeHeader).toContain('title: "Ownership"');
    expect(homeHeader).toContain("onOwnershipFilterChange");
    expect(homeRoute).toContain("ownershipFilteredThreads");
    expect(sidebar).toContain("threadMatchesMine");
    expect(sidebar).toContain("ownershipFilter: options.ownershipFilter");
  });
});
