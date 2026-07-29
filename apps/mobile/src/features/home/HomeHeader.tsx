import type { EnvironmentId, SidebarThreadSortOrder } from "@t3tools/contracts";
import type { MenuAction } from "@react-native-menu/menu";
import {
  NativeHeaderToolbar,
  NativeStackScreenOptions,
  nativeHeaderScrollEdgeEffects,
} from "../../native/StackHeader";
import { useCallback, useMemo, useRef } from "react";
import { Platform, Pressable, Text as RNText, TextInput, View } from "react-native";
import type { SearchBarCommands } from "react-native-screens";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ControlPillMenu } from "../../components/ControlPill";
import { SymbolView } from "../../components/AppSymbol";
import { T3Wordmark } from "../../components/T3Wordmark";
import { NATIVE_LIQUID_GLASS_SUPPORTED } from "../../native/native-glass";
import { useThemeColor } from "../../lib/useThemeColor";
import { useHardwareKeyboardCommand } from "../keyboard/hardwareKeyboardCommands";
import { withNativeGlassHeaderItem } from "../layout/native-glass-header-items";
import { createNativeMailSearchToolbarItem } from "../layout/native-mail-search-toolbar";
import type { HomeProjectSortOrder } from "./homeThreadList";
import {
  buildHomeListFilterMenu,
  type HomeListFilterMenuEnvironment,
  type HomeListFilterMenuProject,
} from "./home-list-filter-menu";
import {
  hasCustomHomeListOptions,
  PROJECT_SORT_OPTIONS,
  THREAD_SORT_OPTIONS,
} from "./home-list-options";
import { isAllEnvironmentsSelected, isEnvironmentSelected } from "./homeEnvironmentFilter";
import {
  HOME_LIST_MODE_ICONS,
  HOME_LIST_MODE_LABELS,
  HOME_LIST_MODE_TITLES,
  HOME_THREAD_GROUPING_LABELS,
  HOME_THREAD_GROUPINGS,
  otherHomeListModes,
  usesProjectThreadGrouping,
  type HomeListMode,
  type HomeThreadGrouping,
} from "./homeListMode";

const HEADER_SCROLL_EDGE_EFFECTS = nativeHeaderScrollEdgeEffects(Platform.OS, Platform.Version);

export type HomeHeaderEnvironment = HomeListFilterMenuEnvironment;

export function HomeHeader(props: {
  readonly environments: ReadonlyArray<HomeHeaderEnvironment>;
  readonly projects: ReadonlyArray<HomeListFilterMenuProject>;
  readonly searchQuery: string;
  readonly listMode: HomeListMode;
  readonly threadGrouping: HomeThreadGrouping;
  readonly selectedEnvironmentIds: readonly EnvironmentId[];
  readonly selectedProjectKey: string | null;
  /**
   * Hide settled threads for the Threads surface. Recency/none default on;
   * project grouping defaults off at the call site.
   */
  readonly hideSettledThreads: boolean;
  readonly projectSortOrder: HomeProjectSortOrder;
  readonly threadSortOrder: SidebarThreadSortOrder;
  readonly onSearchQueryChange: (query: string) => void;
  readonly onListModeChange: (mode: HomeListMode) => void;
  readonly onThreadGroupingChange: (grouping: HomeThreadGrouping) => void;
  readonly onClearEnvironments: () => void;
  readonly onToggleEnvironment: (environmentId: EnvironmentId) => void;
  readonly onProjectChange: (projectKey: string | null) => void;
  readonly onHideSettledThreadsChange: (hide: boolean) => void;
  readonly onProjectSortOrderChange: (sortOrder: HomeProjectSortOrder) => void;
  readonly onThreadSortOrderChange: (sortOrder: SidebarThreadSortOrder) => void;
  readonly onOpenSettings: () => void;
  readonly onStartNewTask: () => void;
}) {
  if (Platform.OS === "android") {
    return <AndroidHomeHeader {...props} />;
  }

  return <IosHomeHeader {...props} />;
}

type HomeHeaderProps = Parameters<typeof HomeHeader>[0];

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

function AndroidHomeHeader(props: HomeHeaderProps) {
  const insets = useSafeAreaInsets();
  const iconColor = useThemeColor("--color-icon");
  const mutedColor = useThemeColor("--color-foreground-muted");
  const listOrganization = usesListOrganization(props.listMode, props.threadGrouping);
  const alternateModes = otherHomeListModes(props.listMode);
  const hasCustomListOptions =
    props.selectedEnvironmentIds.length > 0 ||
    props.selectedProjectKey !== null ||
    (props.listMode === "threads" &&
      props.hideSettledThreads !== defaultHideSettledForGrouping(props.threadGrouping)) ||
    props.threadGrouping !== "project" ||
    (listOrganization &&
      hasCustomHomeListOptions({
        selectedEnvironmentIds: props.selectedEnvironmentIds,
        listMode: props.listMode,
        threadGrouping: props.threadGrouping,
        projectSortOrder: props.projectSortOrder,
        threadSortOrder: props.threadSortOrder,
        selectedProjectKey: props.selectedProjectKey,
      }));
  const menuActions = useMemo<MenuAction[]>(
    () => [
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
      <View
        className="border-b border-header-border bg-header px-4 pb-3"
        style={{
          paddingTop: Math.max(insets.top, 12),
        }}
      >
        <View className="w-full max-w-[720px] self-center gap-3">
          <View className="flex-row items-center gap-2.5">
            <View className="flex-1 flex-row items-center gap-2">
              <T3Wordmark color={iconColor} height={15} />
              <RNText className="-ml-0.5 text-[21px] font-t3-medium tracking-[-0.5px] text-foreground-muted">
                Code
              </RNText>
              <View className="rounded-full bg-subtle px-2 py-0.75">
                <RNText className="text-[11px] font-t3-bold tracking-[1.1px] text-foreground-muted uppercase">
                  Alpha
                </RNText>
              </View>
            </View>

            {alternateModes.map((mode) => (
              <Pressable
                key={mode}
                accessibilityLabel={HOME_LIST_MODE_LABELS[mode]}
                accessibilityRole="button"
                onPress={() => props.onListModeChange(mode)}
                className="size-11 items-center justify-center rounded-full bg-subtle"
              >
                <SymbolView
                  name={HOME_LIST_MODE_ICONS[mode] as never}
                  size={18}
                  tintColor={iconColor}
                  type="monochrome"
                />
              </Pressable>
            ))}

            <ControlPillMenu
              actions={menuActions}
              isAnchoredToRight
              onPressAction={handleMenuAction}
            >
              <Pressable
                accessibilityLabel="Filter and sort threads"
                accessibilityRole="button"
                className="size-11 items-center justify-center rounded-full bg-subtle"
              >
                <SymbolView
                  name={
                    hasCustomListOptions
                      ? "line.3.horizontal.decrease.circle.fill"
                      : "line.3.horizontal.decrease.circle"
                  }
                  size={16}
                  tintColor={iconColor}
                  type="monochrome"
                />
              </Pressable>
            </ControlPillMenu>
            <Pressable
              accessibilityLabel="Open settings"
              accessibilityRole="button"
              onPress={props.onOpenSettings}
              className="size-11 items-center justify-center rounded-full bg-subtle"
            >
              <SymbolView name="gearshape" size={18} tintColor={iconColor} type="monochrome" />
            </Pressable>
          </View>

          {props.listMode === "board" ? null : (
            <View className="min-h-12 flex-row items-center gap-2.5 rounded-2xl border border-input-border bg-input px-3.5">
              <SymbolView
                name="magnifyingglass"
                size={17}
                tintColor={mutedColor}
                type="monochrome"
              />
              <TextInput
                accessibilityLabel="Search threads"
                autoCapitalize="none"
                onChangeText={props.onSearchQueryChange}
                placeholder="Search threads"
                placeholderTextColorClassName="accent-placeholder"
                className="flex-1 py-2.5 text-base font-sans text-foreground"
                value={props.searchQuery}
              />
              {props.searchQuery.length > 0 ? (
                <Pressable
                  accessibilityLabel="Clear search"
                  hitSlop={10}
                  onPress={() => props.onSearchQueryChange("")}
                >
                  <SymbolView
                    name="xmark.circle.fill"
                    size={17}
                    tintColor={mutedColor}
                    type="monochrome"
                  />
                </Pressable>
              ) : null}
            </View>
          )}
        </View>
      </View>
    </>
  );
}

function IosHomeHeader(props: HomeHeaderProps) {
  const searchBarRef = useRef<SearchBarCommands>(null);
  const iconColor = useThemeColor("--color-icon");
  const sheetBackground = useThemeColor("--color-sheet");
  const listOrganization = usesListOrganization(props.listMode, props.threadGrouping);
  const alternateModes = otherHomeListModes(props.listMode);
  const isBoardMode = props.listMode === "board";
  // Board columns are nested horizontal/vertical lists — not one UIKit scroll
  // view that glass can sample / auto-inset. Use a solid bar so cards never
  // paint under the status/nav chrome (same as the dedicated Board route).
  const useSolidBoardHeader = isBoardMode && NATIVE_LIQUID_GLASS_SUPPORTED;
  const hasCustomListOptions =
    props.selectedEnvironmentIds.length > 0 ||
    props.selectedProjectKey !== null ||
    (props.listMode === "threads" &&
      props.hideSettledThreads !== defaultHideSettledForGrouping(props.threadGrouping)) ||
    props.threadGrouping !== "project" ||
    (listOrganization &&
      hasCustomHomeListOptions({
        selectedEnvironmentIds: props.selectedEnvironmentIds,
        listMode: props.listMode,
        threadGrouping: props.threadGrouping,
        projectSortOrder: props.projectSortOrder,
        threadSortOrder: props.threadSortOrder,
        selectedProjectKey: props.selectedProjectKey,
      }));
  const focusSearch = useCallback(() => {
    searchBarRef.current?.focus();
    return searchBarRef.current !== null;
  }, []);
  useHardwareKeyboardCommand("focusSearch", focusSearch);
  const filterMenu = buildHomeListFilterMenu({
    environments: props.environments,
    projects: props.projects,
    selectedEnvironmentIds: props.selectedEnvironmentIds,
    selectedProjectKey: props.selectedProjectKey,
    projectSortOrder: props.projectSortOrder,
    threadSortOrder: props.threadSortOrder,
    onClearEnvironments: props.onClearEnvironments,
    onToggleEnvironment: props.onToggleEnvironment,
    onProjectChange: props.onProjectChange,
    onProjectSortOrderChange: props.onProjectSortOrderChange,
    onThreadSortOrderChange: props.onThreadSortOrderChange,
    listOrganization,
    showProjectFilter: props.listMode !== "board",
    threadGrouping: props.listMode === "threads" ? props.threadGrouping : undefined,
    onThreadGroupingChange: props.listMode === "threads" ? props.onThreadGroupingChange : undefined,
    ...(props.listMode === "threads"
      ? {
          hideSettledThreads: props.hideSettledThreads,
          onHideSettledThreadsChange: props.onHideSettledThreadsChange,
        }
      : {}),
  });

  const headerTitle = HOME_LIST_MODE_TITLES[props.listMode];

  return (
    <>
      <NativeStackScreenOptions
        optionsVersion={[filterMenu.items, props.listMode, headerTitle, useSolidBoardHeader]}
        options={{
          title: headerTitle,
          headerTitle,
          headerTintColor: iconColor,
          // Explicitly toggle glass ↔ solid when switching modes so board
          // underlap does not stick after leaving Board, and vice versa.
          ...(NATIVE_LIQUID_GLASS_SUPPORTED
            ? useSolidBoardHeader
              ? {
                  headerTransparent: false,
                  // native-stack types backgroundColor as string; ColorValue is fine at runtime.
                  headerStyle: {
                    backgroundColor: sheetBackground as unknown as string,
                  },
                  scrollEdgeEffects: undefined,
                }
              : {
                  headerTransparent: true,
                  headerStyle: { backgroundColor: "transparent" },
                  scrollEdgeEffects: HEADER_SCROLL_EDGE_EFFECTS,
                }
            : {}),
          unstable_headerRightItems:
            Platform.OS === "ios"
              ? () => [
                  ...alternateModes.map((mode) =>
                    withNativeGlassHeaderItem({
                      accessibilityLabel: HOME_LIST_MODE_LABELS[mode],
                      icon: { name: HOME_LIST_MODE_ICONS[mode], type: "sfSymbol" } as const,
                      identifier: `home-mode-${mode}`,
                      label: "",
                      onPress: () => props.onListModeChange(mode),
                      type: "button",
                    }),
                  ),
                  withNativeGlassHeaderItem({
                    accessibilityLabel: "Open settings",
                    icon: { name: "ellipsis", type: "sfSymbol" } as const,
                    identifier: "home-settings",
                    label: "",
                    onPress: props.onOpenSettings,
                    type: "button",
                  }),
                ]
              : undefined,
          // Board has no thread search — hide the bottom mail search toolbar.
          unstable_headerToolbarItems:
            Platform.OS === "ios" && !isBoardMode
              ? () => [
                  createNativeMailSearchToolbarItem({
                    composeButtonId: "home-new-task",
                    composeSystemImageName: "square.and.pencil",
                    filterMenu,
                    filterButtonId: "home-filter",
                    filterSystemImageName: hasCustomListOptions
                      ? "line.3.horizontal.decrease.circle.fill"
                      : "line.3.horizontal.decrease",
                    onComposePress: props.onStartNewTask,
                    onSearchTextChange: props.onSearchQueryChange,
                    placeholder: "Search",
                    searchTextChangeId: "home-search-text",
                  }),
                ]
              : undefined,
          headerSearchBarOptions:
            Platform.OS === "ios"
              ? undefined
              : {
                  ref: searchBarRef,
                  allowToolbarIntegration: true,
                  hideNavigationBar: false,
                  placeholder: "Search",
                  onCancelButtonPress: () => {
                    props.onSearchQueryChange("");
                  },
                  onChangeText: (event) => {
                    props.onSearchQueryChange(event.nativeEvent.text);
                  },
                },
        }}
      />

      {Platform.OS === "ios" ? null : (
        <NativeHeaderToolbar placement="right">
          {alternateModes.map((mode) => (
            <NativeHeaderToolbar.Button
              key={mode}
              accessibilityLabel={HOME_LIST_MODE_LABELS[mode]}
              icon={HOME_LIST_MODE_ICONS[mode] as never}
              onPress={() => props.onListModeChange(mode)}
              separateBackground
            />
          ))}
          <NativeHeaderToolbar.Button
            accessibilityLabel="Open settings"
            icon="gearshape"
            onPress={props.onOpenSettings}
            separateBackground
          />
        </NativeHeaderToolbar>
      )}

      {Platform.OS === "ios" ? null : (
        <NativeHeaderToolbar placement="bottom">
          <NativeHeaderToolbar.Menu
            accessibilityLabel="Filter and sort threads"
            icon={
              hasCustomListOptions
                ? "line.3.horizontal.decrease.circle.fill"
                : "line.3.horizontal.decrease.circle"
            }
            title="Thread list options"
            separateBackground
          >
            <NativeHeaderToolbar.Menu title="Environment">
              <NativeHeaderToolbar.Label>Environment</NativeHeaderToolbar.Label>
              <NativeHeaderToolbar.MenuAction
                isOn={isAllEnvironmentsSelected(props.selectedEnvironmentIds)}
                onPress={() => props.onClearEnvironments()}
                subtitle="Show threads from every environment"
              >
                <NativeHeaderToolbar.Label>All environments</NativeHeaderToolbar.Label>
              </NativeHeaderToolbar.MenuAction>
              {props.environments.map((environment) => (
                <NativeHeaderToolbar.MenuAction
                  key={environment.environmentId}
                  isOn={isEnvironmentSelected(
                    props.selectedEnvironmentIds,
                    environment.environmentId,
                  )}
                  onPress={() => props.onToggleEnvironment(environment.environmentId)}
                >
                  <NativeHeaderToolbar.Label>{environment.label}</NativeHeaderToolbar.Label>
                </NativeHeaderToolbar.MenuAction>
              ))}
            </NativeHeaderToolbar.Menu>

            {props.projects.length > 0 && props.listMode !== "board" ? (
              <NativeHeaderToolbar.Menu title="Project">
                <NativeHeaderToolbar.Label>Project</NativeHeaderToolbar.Label>
                <NativeHeaderToolbar.MenuAction
                  isOn={props.selectedProjectKey === null}
                  onPress={() => props.onProjectChange(null)}
                  subtitle="Show threads from every project"
                >
                  <NativeHeaderToolbar.Label>All projects</NativeHeaderToolbar.Label>
                </NativeHeaderToolbar.MenuAction>
                {props.projects.map((project) => (
                  <NativeHeaderToolbar.MenuAction
                    key={project.key}
                    isOn={props.selectedProjectKey === project.key}
                    onPress={() => props.onProjectChange(project.key)}
                  >
                    <NativeHeaderToolbar.Label>{project.label}</NativeHeaderToolbar.Label>
                  </NativeHeaderToolbar.MenuAction>
                ))}
              </NativeHeaderToolbar.Menu>
            ) : null}

            {props.listMode === "threads" ? (
              <>
                <NativeHeaderToolbar.Menu title="Group threads">
                  <NativeHeaderToolbar.Label>Group threads</NativeHeaderToolbar.Label>
                  {HOME_THREAD_GROUPINGS.map((grouping) => (
                    <NativeHeaderToolbar.MenuAction
                      key={grouping}
                      isOn={props.threadGrouping === grouping}
                      onPress={() => props.onThreadGroupingChange(grouping)}
                    >
                      <NativeHeaderToolbar.Label>
                        {HOME_THREAD_GROUPING_LABELS[grouping]}
                      </NativeHeaderToolbar.Label>
                    </NativeHeaderToolbar.MenuAction>
                  ))}
                </NativeHeaderToolbar.Menu>
                <NativeHeaderToolbar.MenuAction
                  isOn={props.hideSettledThreads}
                  onPress={() => props.onHideSettledThreadsChange(!props.hideSettledThreads)}
                  subtitle="Omit settled threads from this list"
                >
                  <NativeHeaderToolbar.Label>Hide settled</NativeHeaderToolbar.Label>
                </NativeHeaderToolbar.MenuAction>
              </>
            ) : null}

            {listOrganization ? (
              <>
                <NativeHeaderToolbar.Menu title="Sort projects">
                  <NativeHeaderToolbar.Label>Sort projects</NativeHeaderToolbar.Label>
                  {PROJECT_SORT_OPTIONS.map((option) => (
                    <NativeHeaderToolbar.MenuAction
                      key={option.value}
                      isOn={props.projectSortOrder === option.value}
                      onPress={() => props.onProjectSortOrderChange(option.value)}
                    >
                      <NativeHeaderToolbar.Label>{option.label}</NativeHeaderToolbar.Label>
                    </NativeHeaderToolbar.MenuAction>
                  ))}
                </NativeHeaderToolbar.Menu>

                <NativeHeaderToolbar.Menu title="Sort threads">
                  <NativeHeaderToolbar.Label>Sort threads</NativeHeaderToolbar.Label>
                  {THREAD_SORT_OPTIONS.map((option) => (
                    <NativeHeaderToolbar.MenuAction
                      key={option.value}
                      isOn={props.threadSortOrder === option.value}
                      onPress={() => props.onThreadSortOrderChange(option.value)}
                    >
                      <NativeHeaderToolbar.Label>{option.label}</NativeHeaderToolbar.Label>
                    </NativeHeaderToolbar.MenuAction>
                  ))}
                </NativeHeaderToolbar.Menu>
              </>
            ) : null}
          </NativeHeaderToolbar.Menu>
          <NativeHeaderToolbar.Spacer width={8} sharesBackground={false} />
          <NativeHeaderToolbar.SearchBarSlot />
          <NativeHeaderToolbar.Spacer width={8} sharesBackground={false} />
          <NativeHeaderToolbar.Button
            accessibilityLabel="New task"
            icon="square.and.pencil"
            onPress={props.onStartNewTask}
            separateBackground
          />
        </NativeHeaderToolbar>
      )}
    </>
  );
}
