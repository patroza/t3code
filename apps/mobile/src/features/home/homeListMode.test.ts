import { describe, expect, it } from "vite-plus/test";

import { otherHomeListModes } from "./homeListMode";

describe("otherHomeListModes", () => {
  it("returns the mode that is not current", () => {
    expect(otherHomeListModes("threads")).toEqual(["board"]);
    expect(otherHomeListModes("board")).toEqual(["threads"]);
  });
});
