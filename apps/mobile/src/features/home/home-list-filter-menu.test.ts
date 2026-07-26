import { describe, expect, it, vi } from "vite-plus/test";

import { buildHomeListFilterMenu } from "./home-list-filter-menu";

describe("buildHomeListFilterMenu", () => {
  it("adds a project scope submenu that selects and clears the same scope as the chips", () => {
    const onProjectChange = vi.fn();
    const menu = buildHomeListFilterMenu({
      environments: [],
      projects: [
        { key: "environment-1:project-1", label: "Codething" },
        { key: "environment-1:project-2", label: "Website" },
      ],
      selectedEnvironmentIds: [],
      selectedProjectKey: "environment-1:project-1",
      projectSortOrder: "updated_at",
      threadSortOrder: "updated_at",
      onClearEnvironments: vi.fn(),
      onToggleEnvironment: vi.fn(),
      onProjectChange,
      onProjectSortOrderChange: vi.fn(),
      onThreadSortOrderChange: vi.fn(),
    });

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
    const menu = buildHomeListFilterMenu({
      environments: [
        { environmentId: "env-1" as never, label: "Smart" },
        { environmentId: "env-2" as never, label: "t3vm" },
      ],
      projects: [],
      selectedEnvironmentIds: ["env-1" as never],
      selectedProjectKey: null,
      projectSortOrder: "updated_at",
      threadSortOrder: "updated_at",
      onClearEnvironments,
      onToggleEnvironment,
      onProjectChange: vi.fn(),
      onProjectSortOrderChange: vi.fn(),
      onThreadSortOrderChange: vi.fn(),
    });

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
});
