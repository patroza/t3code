import { describe, expect, it, vi } from "vite-plus/test";

import type { AppBarMenuItem } from "../../components/ui/AppBar.types";
import { buildHomeListFilterMenuItems } from "./home-list-filter-menu";

function baseProps(
  overrides: Partial<Parameters<typeof buildHomeListFilterMenuItems>[0]> = {},
): Parameters<typeof buildHomeListFilterMenuItems>[0] {
  return {
    environments: [],
    projects: [],
    selectedEnvironmentIds: [],
    selectedProjectKey: null,
    ownershipFilter: "mine",
    ownershipRelation: "both",
    projectSortOrder: "updated_at",
    threadSortOrder: "updated_at",
    onClearEnvironments: vi.fn(),
    onToggleEnvironment: vi.fn(),
    onProjectChange: vi.fn(),
    onOwnershipFilterChange: vi.fn(),
    onOwnershipRelationChange: vi.fn(),
    onProjectSortOrderChange: vi.fn(),
    onThreadSortOrderChange: vi.fn(),
    ...overrides,
  };
}

function submenu(items: ReadonlyArray<AppBarMenuItem>, title: string) {
  const item = items.find((entry) => "items" in entry && entry.title === title);
  if (!item || !("items" in item)) throw new Error(`Expected ${title} submenu`);
  return item;
}

describe("buildHomeListFilterMenuItems", () => {
  it("adds a project scope submenu that selects and clears the same scope as the chips", () => {
    const onProjectChange = vi.fn();
    const items = buildHomeListFilterMenuItems(
      baseProps({
        projects: [
          { key: "environment-1:project-1", label: "Codething" },
          { key: "environment-1:project-2", label: "Website" },
        ],
        selectedProjectKey: "environment-1:project-1",
        onProjectChange,
      }),
    );

    const projectMenu = submenu(items, "Project");
    expect(items.some((item) => item.title === "Settings")).toBe(false);
    expect(projectMenu.items).toMatchObject([
      { title: "All projects", selected: false },
      { title: "Codething", selected: true },
      { title: "Website", selected: false },
    ]);

    const allProjects = projectMenu.items[0];
    const website = projectMenu.items[2];
    if (!allProjects || !("onPress" in allProjects) || !website || !("onPress" in website)) {
      throw new Error("Expected project actions");
    }
    allProjects.onPress();
    website.onPress();
    expect(onProjectChange).toHaveBeenNthCalledWith(1, null);
    expect(onProjectChange).toHaveBeenNthCalledWith(2, "environment-1:project-2");
  });

  it("supports multi-select environment toggles", () => {
    const onToggleEnvironment = vi.fn();
    const onClearEnvironments = vi.fn();
    const items = buildHomeListFilterMenuItems(
      baseProps({
        environments: [
          { environmentId: "env-1" as never, label: "Smart" },
          { environmentId: "env-2" as never, label: "t3vm" },
        ],
        selectedEnvironmentIds: ["env-1" as never],
        onClearEnvironments,
        onToggleEnvironment,
      }),
    );

    const environmentMenu = submenu(items, "Environment");
    expect(environmentMenu.items).toMatchObject([
      { title: "All environments", selected: false },
      { title: "Smart", selected: true },
      { title: "t3vm", selected: false },
    ]);
    const allEnvironments = environmentMenu.items[0];
    const t3vm = environmentMenu.items[2];
    if (!allEnvironments || !("onPress" in allEnvironments) || !t3vm || !("onPress" in t3vm)) {
      throw new Error("Expected environment actions");
    }
    allEnvironments.onPress();
    t3vm.onPress();
    expect(onClearEnvironments).toHaveBeenCalledOnce();
    expect(onToggleEnvironment).toHaveBeenCalledWith("env-2");
  });

  it("offers Anyone, Mine, and Theirs ownership filters", () => {
    const onOwnershipFilterChange = vi.fn();
    const items = buildHomeListFilterMenuItems(
      baseProps({
        ownershipFilter: "mine",
        onOwnershipFilterChange,
      }),
    );

    const ownershipMenu = submenu(items, "Ownership");
    expect(ownershipMenu.items).toMatchObject([
      { title: "Anyone", selected: false },
      { title: "Mine + unattributed", selected: true },
      { title: "Only mine", selected: false },
      { title: "Theirs", selected: false },
    ]);
    const theirs = ownershipMenu.items.find((item) => item.title === "Theirs");
    if (!theirs || !("onPress" in theirs)) throw new Error("Expected ownership action");
    theirs.onPress();
    expect(onOwnershipFilterChange).toHaveBeenCalledWith("theirs");
  });

  it("offers created / participated / both sub-filters when Mine or Theirs is selected", () => {
    const onOwnershipRelationChange = vi.fn();
    const items = buildHomeListFilterMenuItems(
      baseProps({
        ownershipFilter: "mine",
        ownershipRelation: "created",
        onOwnershipRelationChange,
      }),
    );

    const relationMenu = submenu(items, "Mine includes");
    expect(relationMenu.items).toMatchObject([
      { title: "Created or participated", selected: false },
      { title: "Created", selected: true },
      { title: "Participated", selected: false },
    ]);
    const participated = relationMenu.items[2];
    if (!participated || !("onPress" in participated)) {
      throw new Error("Expected relation action");
    }
    participated.onPress();
    expect(onOwnershipRelationChange).toHaveBeenCalledWith("participated");

    const anyoneItems = buildHomeListFilterMenuItems(baseProps({ ownershipFilter: "any" }));
    expect(anyoneItems.some((item) => item.title === "Mine includes")).toBe(false);
  });
});
