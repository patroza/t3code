import { describe, expect, it } from "vite-plus/test";

import { otherHomeListModes } from "./homeListMode";

describe("otherHomeListModes", () => {
  it("returns the two modes that are not current", () => {
    expect(otherHomeListModes("projects")).toEqual(["recent", "board"]);
    expect(otherHomeListModes("recent")).toEqual(["projects", "board"]);
    expect(otherHomeListModes("board")).toEqual(["recent", "projects"]);
  });
});
