import type { EnvironmentId, SidebarThreadSortOrder } from "@t3tools/contracts";

import { isAllEnvironmentsSelected, isEnvironmentSelected } from "./homeEnvironmentFilter";
import type { HomeProjectSortOrder } from "./homeThreadList";
import { PROJECT_SORT_OPTIONS, THREAD_SORT_OPTIONS } from "./home-list-options";

export interface HomeListFilterMenuEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

export interface HomeListFilterMenuProject {
  readonly key: string;
  readonly label: string;
}

type HomeListFilterMenuAction = {
  readonly type: "action";
  readonly title: string;
  readonly subtitle?: string;
  readonly state?: "on" | "off";
  readonly onPress: () => void;
};

type HomeListFilterMenuSubmenu = {
  readonly type: "submenu";
  readonly title: string;
  readonly items: HomeListFilterMenuAction[];
};

export interface HomeListFilterMenu {
  readonly title: string;
  readonly items: Array<HomeListFilterMenuAction | HomeListFilterMenuSubmenu>;
}

export function buildHomeListFilterMenu(props: {
  readonly environments: ReadonlyArray<HomeListFilterMenuEnvironment>;
  readonly projects: ReadonlyArray<HomeListFilterMenuProject>;
  readonly selectedEnvironmentIds: readonly EnvironmentId[];
  readonly selectedProjectKey: string | null;
  readonly projectSortOrder: HomeProjectSortOrder;
  readonly threadSortOrder: SidebarThreadSortOrder;
  readonly onClearEnvironments: () => void;
  readonly onToggleEnvironment: (environmentId: EnvironmentId) => void;
  readonly onProjectChange: (projectKey: string | null) => void;
  readonly onProjectSortOrderChange: (sortOrder: HomeProjectSortOrder) => void;
  readonly onThreadSortOrderChange: (sortOrder: SidebarThreadSortOrder) => void;
  /**
   * False hides the sort/group submenus. Recent/Board and Thread List v2 use
   * fixed layouts; the environment multi-filter still applies.
   */
  readonly listOrganization?: boolean;
  /** When false, hide the project scope submenu (Board uses its own control). */
  readonly showProjectFilter?: boolean;
}): HomeListFilterMenu {
  const items: Array<HomeListFilterMenuAction | HomeListFilterMenuSubmenu> = [];

  items.push({
    type: "submenu",
    title: "Environment",
    items: [
      {
        type: "action",
        title: "All environments",
        subtitle: "Show threads from every environment",
        state: isAllEnvironmentsSelected(props.selectedEnvironmentIds) ? "on" : "off",
        onPress: () => props.onClearEnvironments(),
      },
      ...props.environments.map((environment) => ({
        type: "action" as const,
        title: environment.label,
        // When "all" is selected every row is visually on so multi-toggle is clear;
        // pressing one leaves "all" and keeps only that environment.
        state: isEnvironmentSelected(props.selectedEnvironmentIds, environment.environmentId)
          ? ("on" as const)
          : ("off" as const),
        onPress: () => props.onToggleEnvironment(environment.environmentId),
      })),
    ],
  });

  if (props.showProjectFilter !== false && props.projects.length > 0) {
    items.push({
      type: "submenu",
      title: "Project",
      items: [
        {
          type: "action",
          title: "All projects",
          subtitle: "Show threads from every project",
          state: props.selectedProjectKey === null ? "on" : "off",
          onPress: () => props.onProjectChange(null),
        },
        ...props.projects.map((project) => ({
          type: "action" as const,
          title: project.label,
          state: props.selectedProjectKey === project.key ? ("on" as const) : ("off" as const),
          onPress: () => props.onProjectChange(project.key),
        })),
      ],
    });
  }

  if (props.listOrganization !== false) {
    items.push(
      {
        type: "submenu",
        title: "Sort projects",
        items: PROJECT_SORT_OPTIONS.map((option) => ({
          type: "action",
          title: option.label,
          state: props.projectSortOrder === option.value ? "on" : "off",
          onPress: () => props.onProjectSortOrderChange(option.value),
        })),
      },
      {
        type: "submenu",
        title: "Sort threads",
        items: THREAD_SORT_OPTIONS.map((option) => ({
          type: "action",
          title: option.label,
          state: props.threadSortOrder === option.value ? "on" : "off",
          onPress: () => props.onThreadSortOrderChange(option.value),
        })),
      },
    );
  }

  return {
    title: "Thread list options",
    items,
  };
}
