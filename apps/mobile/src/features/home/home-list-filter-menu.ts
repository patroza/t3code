import type { EnvironmentId, SidebarThreadSortOrder } from "@t3tools/contracts";

import { isAllEnvironmentsSelected, isEnvironmentSelected } from "./homeEnvironmentFilter";
import {
  HOME_THREAD_GROUPING_LABELS,
  HOME_THREAD_GROUPINGS,
  type HomeThreadGrouping,
} from "./homeListMode";
import type { HomeProjectSortOrder } from "./homeThreadList";
import {
  OWNERSHIP_FILTER_LABELS,
  OWNERSHIP_FILTERS,
  OWNERSHIP_RELATION_LABELS,
  OWNERSHIP_RELATIONS,
  PROJECT_SORT_OPTIONS,
  THREAD_SORT_OPTIONS,
  type OwnershipFilter,
  type OwnershipRelation,
} from "./home-list-filter-options";

import type { AppBarMenuItem } from "../../components/ui/AppBar.types";

export interface HomeListFilterMenuEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

export interface HomeListFilterMenuProject {
  readonly key: string;
  readonly label: string;
}

export function buildHomeListFilterMenuItems(props: {
  readonly environments: ReadonlyArray<HomeListFilterMenuEnvironment>;
  readonly projects: ReadonlyArray<HomeListFilterMenuProject>;
  readonly selectedEnvironmentIds: readonly EnvironmentId[];
  readonly selectedProjectKey: string | null;
  readonly ownershipFilter: OwnershipFilter;
  readonly ownershipRelation: OwnershipRelation;
  readonly projectSortOrder?: HomeProjectSortOrder;
  readonly threadSortOrder?: SidebarThreadSortOrder;
  readonly onClearEnvironments: () => void;
  readonly onToggleEnvironment: (environmentId: EnvironmentId) => void;
  readonly onProjectChange: (projectKey: string | null) => void;
  readonly onOwnershipFilterChange: (filter: OwnershipFilter) => void;
  readonly onOwnershipRelationChange: (relation: OwnershipRelation) => void;
  readonly onProjectSortOrderChange?: (sortOrder: HomeProjectSortOrder) => void;
  readonly onThreadSortOrderChange?: (sortOrder: SidebarThreadSortOrder) => void;
  /**
   * True shows project/thread sort submenus (classic grouped list). v2 Home
   * never sets this — its layout ignores those controls.
   */
  readonly listOrganization?: boolean;
  /**
   * Threads surface: hide settled threads. When provided, the menu offers a
   * toggle (recency/none default on; project defaults off at the call site).
   */
  readonly hideSettledThreads?: boolean;
  readonly onHideSettledThreadsChange?: (hide: boolean) => void;
  /** When set, offers Group by recency / project / nothing. */
  readonly threadGrouping?: HomeThreadGrouping;
  readonly onThreadGroupingChange?: (grouping: HomeThreadGrouping) => void;
}): AppBarMenuItem[] {
  const items: AppBarMenuItem[] = [
    {
      id: "environment",
      title: "Environment",
      items: [
        {
          id: "environment:all",
          title: "All environments",
          subtitle: "Show threads from every environment",
          selected: isAllEnvironmentsSelected(props.selectedEnvironmentIds),
          onPress: () => props.onClearEnvironments(),
        },
        ...props.environments.map((environment) => ({
          id: `environment:${environment.environmentId}`,
          title: environment.label,
          // When "all" is selected every row is visually on so multi-toggle is clear;
          // pressing one leaves "all" and keeps only that environment.
          selected: isEnvironmentSelected(props.selectedEnvironmentIds, environment.environmentId),
          onPress: () => props.onToggleEnvironment(environment.environmentId),
        })),
      ],
    },
    {
      id: "ownership",
      title: "Ownership",
      items: OWNERSHIP_FILTERS.map((value) => ({
        id: `ownership:${value}`,
        title: OWNERSHIP_FILTER_LABELS[value],
        selected: props.ownershipFilter === value,
        onPress: () => props.onOwnershipFilterChange(value),
      })),
    },
  ];

  if (props.ownershipFilter === "mine" || props.ownershipFilter === "theirs") {
    items.push({
      id: "ownership-relation",
      title: props.ownershipFilter === "mine" ? "Mine includes" : "Theirs includes",
      items: OWNERSHIP_RELATIONS.map((value) => ({
        id: `ownership-relation:${value}`,
        title: OWNERSHIP_RELATION_LABELS[value],
        selected: props.ownershipRelation === value,
        onPress: () => props.onOwnershipRelationChange(value),
      })),
    });
  }

  if (props.projects.length > 0) {
    items.push({
      id: "project",
      title: "Project",
      items: [
        {
          id: "project:all",
          title: "All projects",
          subtitle: "Show threads from every project",
          selected: props.selectedProjectKey === null,
          onPress: () => props.onProjectChange(null),
        },
        ...props.projects.map((project) => ({
          id: `project:${project.key}`,
          title: project.label,
          selected: props.selectedProjectKey === project.key,
          onPress: () => props.onProjectChange(project.key),
        })),
      ],
    });
  }

  if (props.threadGrouping !== undefined && props.onThreadGroupingChange !== undefined) {
    const onThreadGroupingChange = props.onThreadGroupingChange;
    items.push({
      id: "grouping",
      title: "Group threads",
      items: HOME_THREAD_GROUPINGS.map((grouping) => ({
        id: `grouping:${grouping}`,
        title: HOME_THREAD_GROUPING_LABELS[grouping],
        selected: props.threadGrouping === grouping,
        onPress: () => onThreadGroupingChange(grouping),
      })),
    });
  }

  if (props.onHideSettledThreadsChange !== undefined && props.hideSettledThreads !== undefined) {
    const hideSettledThreads = props.hideSettledThreads;
    const onHideSettledThreadsChange = props.onHideSettledThreadsChange;
    items.push({
      id: "hide-settled",
      title: "Hide settled",
      subtitle: "Move settled threads out of the main list",
      selected: hideSettledThreads,
      onPress: () => onHideSettledThreadsChange(!hideSettledThreads),
    });
  }

  if (
    props.listOrganization === true &&
    props.projectSortOrder !== undefined &&
    props.threadSortOrder !== undefined &&
    props.onProjectSortOrderChange !== undefined &&
    props.onThreadSortOrderChange !== undefined
  ) {
    const projectSortOrder = props.projectSortOrder;
    const threadSortOrder = props.threadSortOrder;
    const onProjectSortOrderChange = props.onProjectSortOrderChange;
    const onThreadSortOrderChange = props.onThreadSortOrderChange;
    items.push(
      {
        id: "sort-projects",
        title: "Sort projects",
        items: PROJECT_SORT_OPTIONS.map((option) => ({
          id: `sort-projects:${option.value}`,
          title: option.label,
          selected: projectSortOrder === option.value,
          onPress: () => onProjectSortOrderChange(option.value),
        })),
      },
      {
        id: "sort-threads",
        title: "Sort threads",
        items: THREAD_SORT_OPTIONS.map((option) => ({
          id: `sort-threads:${option.value}`,
          title: option.label,
          selected: threadSortOrder === option.value,
          onPress: () => onThreadSortOrderChange(option.value),
        })),
      },
    );
  }

  return items;
}
