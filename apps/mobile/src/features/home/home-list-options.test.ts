import {
  DEFAULT_SIDEBAR_PROJECT_SORT_ORDER,
  DEFAULT_SIDEBAR_THREAD_SORT_ORDER,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { hasCustomHomeListOptions, type HomeListOptions } from "./home-list-options";

const defaults: HomeListOptions = {
  selectedEnvironmentIds: [],
  ownershipFilter: "any",
  ownershipRelation: "both",
  listMode: "threads",
  threadGrouping: "project",
  projectSortOrder:
    DEFAULT_SIDEBAR_PROJECT_SORT_ORDER === "manual"
      ? "updated_at"
      : DEFAULT_SIDEBAR_PROJECT_SORT_ORDER,
  threadSortOrder: DEFAULT_SIDEBAR_THREAD_SORT_ORDER,
};

describe("home list options", () => {
  it("recognizes default options", () => {
    expect(hasCustomHomeListOptions(defaults)).toBe(false);
  });

  it("marks environment filters as customized", () => {
    expect(
      hasCustomHomeListOptions({
        ...defaults,
        selectedEnvironmentIds: ["environment-1" as never],
      }),
    ).toBe(true);
    expect(
      hasCustomHomeListOptions({ ...defaults, selectedProjectKey: "environment-1:project-1" }),
    ).toBe(true);
  });

  it("marks ownership filters as customized", () => {
    expect(hasCustomHomeListOptions({ ...defaults, ownershipFilter: "mine" })).toBe(true);
    expect(hasCustomHomeListOptions({ ...defaults, ownershipFilter: "theirs" })).toBe(true);
    expect(hasCustomHomeListOptions({ ...defaults, ownershipRelation: "created" })).toBe(true);
  });

  it("marks non-default thread grouping as customized", () => {
    expect(hasCustomHomeListOptions({ ...defaults, threadGrouping: "recency" })).toBe(true);
    expect(hasCustomHomeListOptions({ ...defaults, threadGrouping: "none" })).toBe(true);
    expect(hasCustomHomeListOptions({ ...defaults, threadGrouping: "project" })).toBe(false);
  });
});
