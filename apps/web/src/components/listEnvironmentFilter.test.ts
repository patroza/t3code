import { EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_HIDE_SETTLED_PROJECTS,
  DEFAULT_HIDE_SETTLED_RECENT,
  DEFAULT_SIDEBAR_V2_SETTLED_RECENCY_HEADERS,
  DEFAULT_SIDEBAR_V2_SETTLED_SHELF_EXPANDED,
  DEFAULT_WEB_LIST_MODE,
  DEFAULT_WEB_THREAD_GROUPING,
  LIST_HIDE_SETTLED_PROJECTS_STORAGE_KEY,
  LIST_HIDE_SETTLED_RECENT_STORAGE_KEY,
  SIDEBAR_V2_SETTLED_RECENCY_HEADERS_STORAGE_KEY,
  SIDEBAR_V2_SETTLED_SHELF_EXPANDED_STORAGE_KEY,
  WebListModeSchema,
  defaultThreadGroupingFromLegacyModeStorage,
  isAllEnvironmentsSelected,
  matchesEnvironmentFilter,
  resolveSelectedEnvironmentIds,
  toggleEnvironmentId,
  usesFlatThreadGrouping,
  usesProjectThreadGrouping,
} from "./listEnvironmentFilter";

const envA = EnvironmentId.make("environment-a");
const envB = EnvironmentId.make("environment-b");
const decodeListMode = Schema.decodeUnknownSync(WebListModeSchema);

describe("list environment multi-select", () => {
  it("treats an empty selection as all environments", () => {
    expect(matchesEnvironmentFilter(envA, [])).toBe(true);
    expect(isAllEnvironmentsSelected([])).toBe(true);
  });

  it("starts a singleton selection when toggling from empty (all)", () => {
    expect(toggleEnvironmentId([], envA)).toEqual([envA]);
  });

  it("adds and removes ids without collapsing back to empty until last deselect", () => {
    expect(toggleEnvironmentId([envA], envB)).toEqual([envA, envB]);
    expect(toggleEnvironmentId([envA, envB], envA)).toEqual([envB]);
  });

  it("drops selected ids that are no longer available", () => {
    expect(resolveSelectedEnvironmentIds([envA, envB], new Set([envA]))).toEqual([envA]);
    expect(resolveSelectedEnvironmentIds([], new Set([envA]))).toEqual([]);
  });
});

describe("threads list mode and grouping prefs", () => {
  it("maps legacy recent/projects mode values onto the combined Threads surface", () => {
    expect(decodeListMode("threads")).toBe("threads");
    expect(decodeListMode("board")).toBe("board");
    expect(decodeListMode("recent")).toBe("threads");
    expect(decodeListMode("projects")).toBe("threads");
    expect(DEFAULT_WEB_LIST_MODE).toBe("threads");
  });

  it("migrates unset grouping from legacy mode storage", () => {
    expect(defaultThreadGroupingFromLegacyModeStorage('"recent"')).toBe("recency");
    expect(defaultThreadGroupingFromLegacyModeStorage('"projects"')).toBe("project");
    expect(defaultThreadGroupingFromLegacyModeStorage(null)).toBe(DEFAULT_WEB_THREAD_GROUPING);
    expect(DEFAULT_WEB_THREAD_GROUPING).toBe("project");
  });

  it("classifies project vs flat groupings for hide-settled / shelf behavior", () => {
    expect(usesProjectThreadGrouping("project")).toBe(true);
    expect(usesProjectThreadGrouping("recency")).toBe(false);
    expect(usesFlatThreadGrouping("recency")).toBe(true);
    expect(usesFlatThreadGrouping("none")).toBe(true);
    expect(usesFlatThreadGrouping("project")).toBe(false);
  });
});

describe("hide-settled and Sidebar V2 settled shelf defaults", () => {
  it("hides settled by default on recency/none and shows them on project groups", () => {
    expect(DEFAULT_HIDE_SETTLED_RECENT).toBe(true);
    expect(DEFAULT_HIDE_SETTLED_PROJECTS).toBe(false);
    expect(LIST_HIDE_SETTLED_RECENT_STORAGE_KEY).toBe("t3code:list:hide-settled-recent:v1");
    expect(LIST_HIDE_SETTLED_PROJECTS_STORAGE_KEY).toBe("t3code:list:hide-settled-projects:v1");
  });

  it("keeps V2 settled recency headers and expanded shelf as defaults", () => {
    expect(DEFAULT_SIDEBAR_V2_SETTLED_RECENCY_HEADERS).toBe(true);
    expect(DEFAULT_SIDEBAR_V2_SETTLED_SHELF_EXPANDED).toBe(true);
    expect(SIDEBAR_V2_SETTLED_RECENCY_HEADERS_STORAGE_KEY).toBe(
      "t3code:sidebar-v2:settled-recency-headers:v1",
    );
    expect(SIDEBAR_V2_SETTLED_SHELF_EXPANDED_STORAGE_KEY).toBe(
      "t3code:sidebar-v2:settled-shelf-expanded:v1",
    );
  });
});
