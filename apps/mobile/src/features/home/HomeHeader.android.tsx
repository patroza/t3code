import type { EnvironmentId } from "@t3tools/contracts";
import type { MenuAction } from "@react-native-menu/menu";
import { useCallback, useMemo } from "react";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useThreadListV2Enabled } from "../threads/use-thread-list-v2-enabled";
import { MaterialThreadListToolbar } from "./MaterialThreadListToolbar";
import {
  DEFAULT_OWNERSHIP_FILTER,
  hasCustomHomeListOptions,
  OWNERSHIP_FILTER_LABELS,
  OWNERSHIP_FILTERS,
  OWNERSHIP_RELATION_LABELS,
  OWNERSHIP_RELATIONS,
  PROJECT_SORT_OPTIONS,
  THREAD_SORT_OPTIONS,
} from "./home-list-options";
import { isAllEnvironmentsSelected, isEnvironmentSelected } from "./homeEnvironmentFilter";
import {
  HOME_LIST_MODE_LABELS,
  HOME_LIST_MODES,
  HOME_THREAD_GROUPING_LABELS,
  HOME_THREAD_GROUPINGS,
  usesProjectThreadGrouping,
  type HomeListMode,
  type HomeThreadGrouping,
} from "./homeListMode";
import type { HomeHeaderProps } from "./HomeHeader.types";

export type { HomeHeaderEnvironment } from "./HomeHeader.types";

function checkedMenuState(checked: boolean) {
  return checked ? ("on" as const) : undefined;
}

/** Sort projects/threads only apply when Threads are grouped by project. */
function usesListOrganization(listMode: HomeListMode, threadGrouping: HomeThreadGrouping) {
  return listMode === "threads" && usesProjectThreadGrouping(threadGrouping);
}

function defaultHideSettledForGrouping(threadGrouping: HomeThreadGrouping): boolean {
  return !usesProjectThreadGrouping(threadGrouping);
}

export function HomeHeader(props: HomeHeaderProps) {
  const threadListV2Enabled = useThreadListV2Enabled();
  const listOrganization =
    usesListOrganization(props.listMode, props.threadGrouping) && !threadListV2Enabled;
  const hasCustomListOptions =
    props.selectedEnvironmentIds.length > 0 ||
    props.ownershipFilter !== DEFAULT_OWNERSHIP_FILTER ||
    props.ownershipRelation !== "both" ||
    props.selectedProjectKey !== null ||
    (props.listMode === "threads" &&
      props.hideSettledThreads !== defaultHideSettledForGrouping(props.threadGrouping)) ||
    props.threadGrouping !== "project" ||
    (listOrganization &&
      hasCustomHomeListOptions({
        selectedEnvironmentIds: props.selectedEnvironmentIds,
        ownershipFilter: props.ownershipFilter,
        ownershipRelation: props.ownershipRelation,
        listMode: props.listMode,
        threadGrouping: props.threadGrouping,
        projectSortOrder: props.projectSortOrder,
        threadSortOrder: props.threadSortOrder,
        selectedProjectKey: props.selectedProjectKey,
      }));
  const menuActions = useMemo<MenuAction[]>(
    () => [
      {
        id: "list-mode",
        title: "View",
        subactions: HOME_LIST_MODES.map((mode) => ({
          id: `list-mode:${mode}`,
          title: HOME_LIST_MODE_LABELS[mode],
          state: checkedMenuState(mode === props.listMode),
        })),
      },
      {
        id: "environment",
        title: "Environment",
        subactions: [
          {
            id: "environment:all",
            title: "All environments",
            state: checkedMenuState(isAllEnvironmentsSelected(props.selectedEnvironmentIds)),
          },
          ...props.environments.map((environment) => ({
            id: `environment:${environment.environmentId}`,
            title: environment.label,
            state: checkedMenuState(
              isEnvironmentSelected(props.selectedEnvironmentIds, environment.environmentId),
            ),
          })),
        ],
      },
      {
        id: "ownership",
        title: "Ownership",
        subactions: OWNERSHIP_FILTERS.map((value) => ({
          id: `ownership:${value}`,
          title: OWNERSHIP_FILTER_LABELS[value],
          state: checkedMenuState(value === props.ownershipFilter),
        })),
      },
      ...(props.ownershipFilter === "mine" || props.ownershipFilter === "theirs"
        ? ([
            {
              id: "ownership-relation",
              title: props.ownershipFilter === "mine" ? "Mine includes" : "Theirs includes",
              subactions: OWNERSHIP_RELATIONS.map((value) => ({
                id: `ownership-relation:${value}`,
                title: OWNERSHIP_RELATION_LABELS[value],
                state: checkedMenuState(value === props.ownershipRelation),
              })),
            },
          ] satisfies MenuAction[])
        : []),
      ...(props.projects.length === 0 || props.listMode === "board"
        ? []
        : ([
            {
              id: "project",
              title: "Project",
              subactions: [
                {
                  id: "project:all",
                  title: "All projects",
                  state: checkedMenuState(props.selectedProjectKey === null),
                },
                ...props.projects.map((project) => ({
                  id: `project:${project.key}`,
                  title: project.label,
                  state: checkedMenuState(props.selectedProjectKey === project.key),
                })),
              ],
            },
          ] satisfies MenuAction[])),
      ...(props.listMode === "threads"
        ? ([
            {
              id: "grouping",
              title: "Group threads",
              subactions: HOME_THREAD_GROUPINGS.map((grouping) => ({
                id: `grouping:${grouping}`,
                title: HOME_THREAD_GROUPING_LABELS[grouping],
                state: checkedMenuState(props.threadGrouping === grouping),
              })),
            },
            {
              id: "hide-settled",
              title: "Hide settled",
              state: checkedMenuState(props.hideSettledThreads),
            },
          ] satisfies MenuAction[])
        : []),
      ...(listOrganization
        ? ([
            {
              id: "project-sort",
              title: "Sort projects",
              subactions: PROJECT_SORT_OPTIONS.map((option) => ({
                id: `project-sort:${option.value}`,
                title: option.label,
                state: checkedMenuState(props.projectSortOrder === option.value),
              })),
            },
            {
              id: "thread-sort",
              title: "Sort threads",
              subactions: THREAD_SORT_OPTIONS.map((option) => ({
                id: `thread-sort:${option.value}`,
                title: option.label,
                state: checkedMenuState(props.threadSortOrder === option.value),
              })),
            },
          ] satisfies MenuAction[])
        : []),
    ],
    [
      listOrganization,
      props.environments,
      props.hideSettledThreads,
      props.listMode,
      props.ownershipFilter,
      props.ownershipRelation,
      props.projectSortOrder,
      props.projects,
      props.selectedEnvironmentIds,
      props.selectedProjectKey,
      props.threadGrouping,
      props.threadSortOrder,
    ],
  );
  const handleMenuAction = useCallback(
    (event: { nativeEvent: { event: string } }) => {
      const id = event.nativeEvent.event;
      if (id.startsWith("list-mode:")) {
        const mode = id.slice("list-mode:".length);
        if (mode === "threads" || mode === "board") {
          props.onListModeChange(mode);
        }
        return;
      }

      if (id === "environment:all") {
        props.onClearEnvironments();
        return;
      }

      if (id.startsWith("environment:")) {
        const environmentId = id.slice("environment:".length) as EnvironmentId;
        props.onToggleEnvironment(environmentId);
        return;
      }

      if (id === "project:all") {
        props.onProjectChange(null);
        return;
      }

      if (id.startsWith("ownership-relation:")) {
        const relation = id.slice("ownership-relation:".length);
        if (relation === "created" || relation === "participated" || relation === "both") {
          props.onOwnershipRelationChange(relation);
        }
        return;
      }

      if (id.startsWith("ownership:")) {
        const ownership = id.slice("ownership:".length);
        if (ownership === "any" || ownership === "mine" || ownership === "theirs") {
          props.onOwnershipFilterChange(ownership);
        }
        return;
      }

      if (id.startsWith("project:")) {
        const projectKey = id.slice("project:".length);
        if (props.projects.some((project) => project.key === projectKey)) {
          props.onProjectChange(projectKey);
        }
        return;
      }

      if (id.startsWith("grouping:")) {
        const grouping = id.slice("grouping:".length);
        if (grouping === "recency" || grouping === "project" || grouping === "none") {
          props.onThreadGroupingChange(grouping);
        }
        return;
      }

      if (id === "hide-settled") {
        props.onHideSettledThreadsChange(!props.hideSettledThreads);
        return;
      }

      const projectSort = PROJECT_SORT_OPTIONS.find(
        (option) => id === `project-sort:${option.value}`,
      );
      if (projectSort) {
        props.onProjectSortOrderChange(projectSort.value);
        return;
      }

      const threadSort = THREAD_SORT_OPTIONS.find((option) => id === `thread-sort:${option.value}`);
      if (threadSort) {
        props.onThreadSortOrderChange(threadSort.value);
        return;
      }
    },
    [props],
  );

  return (
    <>
      <NativeStackScreenOptions options={{ headerShown: false }} />
      <MaterialThreadListToolbar
        searchQuery={props.searchQuery}
        onSearchQueryChange={props.onSearchQueryChange}
        filterActions={menuActions}
        filterCustomized={hasCustomListOptions}
        onFilterAction={handleMenuAction}
        onOpenSettings={props.onOpenSettings}
        onOpenEnvironments={props.onOpenEnvironments}
      />
    </>
  );
}
