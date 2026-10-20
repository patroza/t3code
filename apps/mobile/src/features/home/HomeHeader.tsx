import { Toolbar } from "../../components/ui/Toolbar";
import { NativeStackScreenOptions, nativeHeaderScrollEdgeEffects } from "../../native/StackHeader";
import { use, useCallback, useEffect, useRef } from "react";
import { useNavigation, type ParamListBase } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { Platform, Text as RNText, useWindowDimensions } from "react-native";
import type { SearchBarCommands } from "react-native-screens";

import { NATIVE_LIQUID_GLASS_SUPPORTED } from "../../native/native-glass";
import { NativePrimaryColumnContext } from "../../native/v5-workspace-context";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { useHardwareKeyboardCommand } from "../keyboard/hardwareKeyboardCommands";
import { withNativeGlassHeaderItem } from "../layout/native-glass-header-items";
import { createNativeMailSearchToolbarItem } from "../layout/native-mail-search-toolbar";
import { getConnectionAwareBrandHeaderOptions } from "./WorkspaceConnectionTitle";
import { useNativeMailSearchToolbar } from "../../native/use-native-mail-search-toolbar";
import { useDeviceType } from "../../native/native-layout-metrics";
import { buildHomeListFilterMenu } from "./home-list-filter-menu";
import {
  createSidebarFilterHeaderItem,
  createSidebarHeaderItems,
} from "../threads/sidebar-native-header-items";
import {
  DEFAULT_OWNERSHIP_FILTER,
  OWNERSHIP_FILTER_LABELS,
  OWNERSHIP_FILTERS,
  OWNERSHIP_RELATION_LABELS,
  OWNERSHIP_RELATIONS,
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
  type HomeThreadGrouping,
} from "./homeListMode";
import type { HomeHeaderProps } from "./HomeHeader.types";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";

export type { HomeHeaderEnvironment } from "./HomeHeader.types";

const HEADER_SCROLL_EDGE_EFFECTS = nativeHeaderScrollEdgeEffects(Platform.OS, Platform.Version);

function defaultHideSettledForGrouping(threadGrouping: HomeThreadGrouping): boolean {
  return !usesProjectThreadGrouping(threadGrouping);
}

export function HomeHeader(props: HomeHeaderProps) {
  const navigation = useNavigation<NativeStackNavigationProp<ParamListBase>>();
  const { layout, panes, togglePrimarySidebar } = useAdaptiveWorkspaceLayout();
  const usesNativeMailSearchToolbar = useNativeMailSearchToolbar();
  const deviceType = useDeviceType();
  const primaryColumn = use(NativePrimaryColumnContext);
  const sidebarHeader =
    Platform.OS === "ios" &&
    primaryColumn !== null &&
    (deviceType === "pad" || !usesNativeMailSearchToolbar);
  const showsCompactCompose = deviceType === "pad" && !layout.usesSplitView;
  const searchBarRef = useRef<SearchBarCommands>(null);
  const { width: headerWidth } = useWindowDimensions();
  const theme = useUniwindTheme();
  const iconColor = theme["--color-icon"];
  const alternateModes = otherHomeListModes(props.listMode);
  const focusAfterReveal = useRef(false);
  useEffect(
    () =>
      navigation.addListener("transitionEnd", (event) => {
        if (focusAfterReveal.current && !event.data.closing) {
          focusAfterReveal.current = false;
          searchBarRef.current?.focus();
        }
      }),
    [navigation],
  );
  const hasCustomListOptions =
    props.selectedEnvironmentIds.length > 0 ||
    props.ownershipFilter !== DEFAULT_OWNERSHIP_FILTER ||
    props.ownershipRelation !== "both" ||
    props.selectedProjectKey !== null ||
    (props.listMode === "threads" &&
      props.hideSettledThreads !== defaultHideSettledForGrouping(props.threadGrouping)) ||
    props.threadGrouping !== "project";
  const focusSearch = useCallback(() => {
    if (primaryColumn && !panes.primarySidebarVisible) {
      focusAfterReveal.current = true;
      togglePrimarySidebar();
      return true;
    }
    searchBarRef.current?.focus();
    return searchBarRef.current !== null;
  }, [primaryColumn, panes.primarySidebarVisible, togglePrimarySidebar]);
  useHardwareKeyboardCommand("focusSearch", focusSearch);
  const filterMenu = buildHomeListFilterMenu({
    environments: props.environments,
    projects: props.projects,
    selectedEnvironmentIds: props.selectedEnvironmentIds,
    selectedProjectKey: props.selectedProjectKey,
    ownershipFilter: props.ownershipFilter,
    ownershipRelation: props.ownershipRelation,
    onClearEnvironments: props.onClearEnvironments,
    onToggleEnvironment: props.onToggleEnvironment,
    onProjectChange: props.onProjectChange,
    onOwnershipFilterChange: props.onOwnershipFilterChange,
    onOwnershipRelationChange: props.onOwnershipRelationChange,
    listOrganization: false,
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

  if (props.usesWorkspaceToolbar) {
    return deviceType === "duo-unfolded" ? (
      <NativeStackScreenOptions
        optionsVersion={filterMenu.items}
        options={{
          nativeSidebarFilter: createSidebarFilterHeaderItem({
            filterIcon: hasCustomListOptions
              ? "line.3.horizontal.decrease.circle.fill"
              : "line.3.horizontal.decrease.circle",
            filterMenu,
          }),
        }}
      />
    ) : null;
  }

  return (
    <>
      <NativeStackScreenOptions
        optionsVersion={[
          filterMenu.items,
          props.listMode,
          headerTitle,
          headerWidth,
          showsCompactCompose,
        ]}
        options={{
          // The iOS Home header owns the native title, so the connection
          // status has to swap in here. The list-mode title is passed
          // through so it survives the swap.
          ...getConnectionAwareBrandHeaderOptions({
            headerWidth,
            trailingItemCount: alternateModes.length + (sidebarHeader ? 2 : 1),
            onOpenEnvironments: props.onOpenEnvironments,
            title: headerTitle,
            brand: (
              <RNText className="text-[18px] font-t3-bold text-foreground" numberOfLines={1}>
                {headerTitle}
              </RNText>
            ),
          }),
          headerTintColor: iconColor,
          ...(NATIVE_LIQUID_GLASS_SUPPORTED
            ? {
                headerTransparent: true,
                headerStyle: { backgroundColor: "transparent" },
                scrollEdgeEffects: HEADER_SCROLL_EDGE_EFFECTS,
              }
            : {}),
          unstable_headerRightItems: () =>
            sidebarHeader
              ? [
                  ...createSidebarHeaderItems({
                    filterIcon: hasCustomListOptions
                      ? "line.3.horizontal.decrease.circle.fill"
                      : "line.3.horizontal.decrease.circle",
                    filterMenu,
                    listMode: props.listMode,
                    onListModeChange: props.onListModeChange,
                    onOpenSettings: props.onOpenSettings,
                  }),
                  ...(showsCompactCompose
                    ? [
                        withNativeGlassHeaderItem({
                          accessibilityLabel: "New task",
                          axisBehavior: "horizontalOnly",
                          icon: { name: "square.and.pencil", type: "sfSymbol" } as const,
                          identifier: "home-new-task",
                          label: "",
                          onPress: props.onStartNewTask,
                          type: "button",
                        }),
                      ]
                    : []),
                ]
              : [
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
                ],
          // The keys below are set per-branch (not `undefined`) so a later
          // reapply cannot clobber options owned by Toolbar.
          ...(sidebarHeader
            ? {
                headerSearchBarOptions: {
                  ref: searchBarRef,
                  autoCapitalize: "none" as const,
                  hideNavigationBar: false,
                  hideWhenScrolling: false,
                  obscureBackground: false,
                  placement: "stacked" as const,
                  allowToolbarIntegration: false,
                  placeholder: "Search",
                  onCancelButtonPress: () => props.onSearchQueryChange(""),
                  onChangeText: (event: { nativeEvent: { text: string } }) =>
                    props.onSearchQueryChange(event.nativeEvent.text),
                },
                unstable_headerToolbarItems: () => [],
              }
            : usesNativeMailSearchToolbar
              ? {
                  unstable_headerToolbarItems: () => [
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
                      showsSearchDismissButton: true,
                    }),
                  ],
                }
              : {
                  headerSearchBarOptions: {
                    ref: searchBarRef,
                    autoCapitalize: "none" as const,
                    hideNavigationBar: false,
                    placeholder: "Search",
                    onCancelButtonPress: () => {
                      props.onSearchQueryChange("");
                    },
                    onChangeText: (event: { nativeEvent: { text: string } }) => {
                      props.onSearchQueryChange(event.nativeEvent.text);
                    },
                  },
                }),
        }}
      />

      {sidebarHeader || usesNativeMailSearchToolbar ? null : (
        <Toolbar placement="bottom">
          <Toolbar.Menu
            accessibilityLabel="Filter threads"
            icon={
              hasCustomListOptions
                ? "line.3.horizontal.decrease.circle.fill"
                : "line.3.horizontal.decrease.circle"
            }
            title="Thread list options"
            separateBackground
          >
            <Toolbar.Menu title="Environment">
              <Toolbar.Label>Environment</Toolbar.Label>
              <Toolbar.MenuAction
                isOn={isAllEnvironmentsSelected(props.selectedEnvironmentIds)}
                onPress={() => props.onClearEnvironments()}
                subtitle="Show threads from every environment"
              >
                <Toolbar.Label>All environments</Toolbar.Label>
              </Toolbar.MenuAction>
              {props.environments.map((environment) => (
                <Toolbar.MenuAction
                  key={environment.environmentId}
                  isOn={isEnvironmentSelected(
                    props.selectedEnvironmentIds,
                    environment.environmentId,
                  )}
                  onPress={() => props.onToggleEnvironment(environment.environmentId)}
                >
                  <Toolbar.Label>{environment.label}</Toolbar.Label>
                </Toolbar.MenuAction>
              ))}
            </Toolbar.Menu>

            <Toolbar.Menu title="Ownership">
              <Toolbar.Label>Ownership</Toolbar.Label>
              {OWNERSHIP_FILTERS.map((value) => (
                <Toolbar.MenuAction
                  key={value}
                  isOn={value === props.ownershipFilter}
                  onPress={() => props.onOwnershipFilterChange(value)}
                >
                  <Toolbar.Label>{OWNERSHIP_FILTER_LABELS[value]}</Toolbar.Label>
                </Toolbar.MenuAction>
              ))}
            </Toolbar.Menu>

            {props.ownershipFilter === "mine" || props.ownershipFilter === "theirs" ? (
              <Toolbar.Menu
                title={props.ownershipFilter === "mine" ? "Mine includes" : "Theirs includes"}
              >
                <Toolbar.Label>
                  {props.ownershipFilter === "mine" ? "Mine includes" : "Theirs includes"}
                </Toolbar.Label>
                {OWNERSHIP_RELATIONS.map((value) => (
                  <Toolbar.MenuAction
                    key={value}
                    isOn={value === props.ownershipRelation}
                    onPress={() => props.onOwnershipRelationChange(value)}
                  >
                    <Toolbar.Label>{OWNERSHIP_RELATION_LABELS[value]}</Toolbar.Label>
                  </Toolbar.MenuAction>
                ))}
              </Toolbar.Menu>
            ) : null}

            {props.projects.length > 0 ? (
              <Toolbar.Menu title="Project">
                <Toolbar.Label>Project</Toolbar.Label>
                <Toolbar.MenuAction
                  isOn={props.selectedProjectKey === null}
                  onPress={() => props.onProjectChange(null)}
                  subtitle="Show threads from every project"
                >
                  <Toolbar.Label>All projects</Toolbar.Label>
                </Toolbar.MenuAction>
                {props.projects.map((project) => (
                  <Toolbar.MenuAction
                    key={project.key}
                    isOn={props.selectedProjectKey === project.key}
                    onPress={() => props.onProjectChange(project.key)}
                  >
                    <Toolbar.Label>{project.label}</Toolbar.Label>
                  </Toolbar.MenuAction>
                ))}
              </Toolbar.Menu>
            ) : null}

            {props.listMode === "threads" ? (
              <>
                <Toolbar.Menu title="Group threads">
                  <Toolbar.Label>Group threads</Toolbar.Label>
                  {HOME_THREAD_GROUPINGS.map((grouping) => (
                    <Toolbar.MenuAction
                      key={grouping}
                      isOn={props.threadGrouping === grouping}
                      onPress={() => props.onThreadGroupingChange(grouping)}
                    >
                      <Toolbar.Label>{HOME_THREAD_GROUPING_LABELS[grouping]}</Toolbar.Label>
                    </Toolbar.MenuAction>
                  ))}
                </Toolbar.Menu>
                <Toolbar.MenuAction
                  isOn={props.hideSettledThreads}
                  onPress={() => props.onHideSettledThreadsChange(!props.hideSettledThreads)}
                  subtitle="Move settled threads out of the main list"
                >
                  <Toolbar.Label>Hide settled</Toolbar.Label>
                </Toolbar.MenuAction>
              </>
            ) : null}
          </Toolbar.Menu>
          <Toolbar.Spacer width={8} sharesBackground={false} />
          <Toolbar.SearchBarSlot />
          <Toolbar.Spacer width={8} sharesBackground={false} />
          <Toolbar.Button
            accessibilityLabel="New task"
            icon="square.and.pencil"
            onPress={props.onStartNewTask}
            separateBackground
          />
        </Toolbar>
      )}
    </>
  );
}
