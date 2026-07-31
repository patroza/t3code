import { describe, expect, it, vi } from "vite-plus/test";

import { buildHomeListFilterMenu } from "./home-list-filter-menu";

function baseProps(
  overrides: Partial<Parameters<typeof buildHomeListFilterMenu>[0]> = {},
): Parameters<typeof buildHomeListFilterMenu>[0] {
  return {
    environments: [],
    projects: [],
    selectedEnvironmentIds: [],
    selectedProjectKey: null,
    ownershipFilter: "any",
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

describe("buildHomeListFilterMenu", () => {
  it("adds a project scope submenu that selects and clears the same scope as the chips", () => {
    const onProjectChange = vi.fn();
    const menu = buildHomeListFilterMenu(
      baseProps({
        projects: [
          { key: "environment-1:project-1", label: "Codething" },
          { key: "environment-1:project-2", label: "Website" },
        ],
        selectedProjectKey: "environment-1:project-1",
        onProjectChange,
      }),
    );

    const projectMenu = menu.items.find(
      (item) => item.type === "submenu" && item.title === "Project",
    );
    expect(menu.items.some((item) => item.title === "Settings")).toBe(false);
    expect(projectMenu).toMatchObject({
      type: "submenu",
      items: [
        { title: "All projects", state: "off" },
        { title: "Codething", state: "on" },
        { title: "Website", state: "off" },
      ],
    });
    if (projectMenu?.type !== "submenu") throw new Error("Expected project submenu");

    projectMenu.items[0]?.onPress();
    projectMenu.items[2]?.onPress();
    expect(onProjectChange).toHaveBeenNthCalledWith(1, null);
    expect(onProjectChange).toHaveBeenNthCalledWith(2, "environment-1:project-2");
  });

  it("supports multi-select environment toggles", () => {
    const onToggleEnvironment = vi.fn();
    const onClearEnvironments = vi.fn();
    const menu = buildHomeListFilterMenu(
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

    const environmentMenu = menu.items.find(
      (item) => item.type === "submenu" && item.title === "Environment",
    );
    expect(environmentMenu).toMatchObject({
      type: "submenu",
      items: [
        { title: "All environments", state: "off" },
        { title: "Smart", state: "on" },
        { title: "t3vm", state: "off" },
      ],
    });
    if (environmentMenu?.type !== "submenu") throw new Error("Expected environment submenu");
    environmentMenu.items[0]?.onPress();
    environmentMenu.items[2]?.onPress();
    expect(onClearEnvironments).toHaveBeenCalledOnce();
    expect(onToggleEnvironment).toHaveBeenCalledWith("env-2");
  });

  it("offers Anyone, Mine, and Theirs ownership filters", () => {
    const onOwnershipFilterChange = vi.fn();
    const menu = buildHomeListFilterMenu(
      baseProps({
        ownershipFilter: "mine",
        onOwnershipFilterChange,
      }),
    );

    const ownershipMenu = menu.items.find(
      (item) => item.type === "submenu" && item.title === "Ownership",
    );
    expect(ownershipMenu).toMatchObject({
      type: "submenu",
      items: [
        { title: "Anyone", state: "off" },
        { title: "Mine", state: "on" },
        { title: "Theirs", state: "off" },
      ],
    });
    if (ownershipMenu?.type !== "submenu") throw new Error("Expected ownership submenu");
    ownershipMenu.items[2]?.onPress();
    expect(onOwnershipFilterChange).toHaveBeenCalledWith("theirs");
  });

  it("offers created / participated / both sub-filters when Mine or Theirs is selected", () => {
    const onOwnershipRelationChange = vi.fn();
    const menu = buildHomeListFilterMenu(
      baseProps({
        ownershipFilter: "mine",
        ownershipRelation: "created",
        onOwnershipRelationChange,
      }),
    );

    const relationMenu = menu.items.find(
      (item) => item.type === "submenu" && item.title === "Mine includes",
    );
    expect(relationMenu).toMatchObject({
      type: "submenu",
      items: [
        { title: "Created or participated", state: "off" },
        { title: "Created", state: "on" },
        { title: "Participated", state: "off" },
      ],
    });
    if (relationMenu?.type !== "submenu") throw new Error("Expected relation submenu");
    relationMenu.items[2]?.onPress();
    expect(onOwnershipRelationChange).toHaveBeenCalledWith("participated");

    const anyoneMenu = buildHomeListFilterMenu(baseProps({ ownershipFilter: "any" }));
    expect(
      anyoneMenu.items.some((item) => item.type === "submenu" && item.title === "Mine includes"),
    ).toBe(false);
  });
});
