import { describe, expect, it } from "vite-plus/test";

import { overlayCommitList } from "./compose-integration-overlays.ts";

describe("integration overlay composition", () => {
  it("keeps overlay commits in oldest-first rev-list order", () => {
    expect(overlayCommitList("oldest\nmiddle\nnewest\n")).toEqual(["oldest", "middle", "newest"]);
  });

  it("handles an empty rev-list", () => {
    expect(overlayCommitList("")).toEqual([]);
  });
});
