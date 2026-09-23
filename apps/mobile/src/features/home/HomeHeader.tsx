import {
  NativeHeaderToolbar,
  NativeStackScreenOptions,
  nativeHeaderScrollEdgeEffects,
} from "../../native/StackHeader";
import { useCallback, useRef } from "react";
import { Platform, Text as RNText, useWindowDimensions } from "react-native";
import type { SearchBarCommands } from "react-native-screens";

import { NATIVE_LIQUID_GLASS_SUPPORTED } from "../../native/native-glass";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { useHardwareKeyboardCommand } from "../keyboard/hardwareKeyboardCommands";
import { withNativeGlassHeaderItem } from "../layout/native-glass-header-items";
import {
  createNativeMailSearchToolbarItem,
  NATIVE_MAIL_SEARCH_TOOLBAR_SUPPORTED,
} from "../layout/native-mail-search-toolbar";
import { getConnectionAwareBrandHeaderOptions } from "./WorkspaceConnectionTitle";
import { buildHomeListFilterMenu } from "./home-list-filter-menu";
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

export type { HomeHeaderEnvironment } from "./HomeHeader.types";

const HEADER_SCROLL_EDGE_EFFECTS = nativeHeaderScrollEdgeEffects(Platform.OS, Platform.Version);

function defaultHideSettledForGrouping(threadGrouping: HomeThreadGrouping): boolean {
  return !usesProjectThreadGrouping(threadGrouping);
}

export function HomeHeader(props: HomeHeaderProps) {
  const searchBarRef = useRef<SearchBarCommands>(null);
  const { width: headerWidth } = useWindowDimensions();
  const theme = useUniwindTheme();
  const iconColor = theme["--color-icon"];
  const sheetBackground = theme["--color-sheet"];
  const alternateModes = otherHomeListModes(props.listMode);
  const isBoardMode = props.listMode === "board";
  // Board columns are nested horizontal/vertical lists — not one UIKit scroll
  // view that glass can sample / auto-inset. Use a solid bar so cards never
  // paint under the status/nav chrome (same as the dedicated Board route).
  const useSolidBoardHeader = isBoardMode && NATIVE_LIQUID_GLASS_SUPPORTED;
  const hasCustomListOptions =
    props.selectedEnvironmentIds.length > 0 ||
    props.ownershipFilter !== DEFAULT_OWNERSHIP_FILTER ||
    props.ownershipRelation !== "both" ||
    props.selectedProjectKey !== null ||
    (props.listMode === "threads" &&
      props.hideSettledThreads !== defaultHideSettledForGrouping(props.threadGrouping)) ||
    props.threadGrouping !== "project";
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
    ownershipFilter: props.ownershipFilter,
    ownershipRelation: props.ownershipRelation,
    onClearEnvironments: props.onClearEnvironments,
    onToggleEnvironment: props.onToggleEnvironment,
    onProjectChange: props.onProjectChange,
    onOwnershipFilterChange: props.onOwnershipFilterChange,
    onOwnershipRelationChange: props.onOwnershipRelationChange,
    listOrganization: false,
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
        optionsVersion={[
          filterMenu.items,
          props.listMode,
          headerTitle,
          useSolidBoardHeader,
          headerWidth,
        ]}
        options={{
          // The iOS Home header owns the native title, so the connection
          // status has to swap in here. The list-mode title is passed
          // through so it survives the swap.
          ...getConnectionAwareBrandHeaderOptions({
            headerWidth,
            trailingItemCount: alternateModes.length + 1,
            onOpenEnvironments: props.onOpenEnvironments,
            title: headerTitle,
            brand: (
              <RNText className="text-[18px] font-t3-bold text-foreground" numberOfLines={1}>
                {headerTitle}
              </RNText>
            ),
          }),
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
          unstable_headerRightItems: () => [
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
          // Board has no thread search. Mail-search toolbar is iOS 26+ only;
          // pre-Liquid-Glass falls back to the standard nav search field.
          // Keys are omitted (not `undefined`) on the NativeHeaderToolbar
          // fallback so a reapply cannot clobber options that toolbar owns.
          ...(NATIVE_MAIL_SEARCH_TOOLBAR_SUPPORTED
            ? isBoardMode
              ? { unstable_headerToolbarItems: undefined }
              : {
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
            : isBoardMode
              ? {}
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

      {NATIVE_MAIL_SEARCH_TOOLBAR_SUPPORTED || isBoardMode ? null : (
        <NativeHeaderToolbar placement="bottom">
          <NativeHeaderToolbar.Menu
            accessibilityLabel="Filter threads"
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

            <NativeHeaderToolbar.Menu title="Ownership">
              <NativeHeaderToolbar.Label>Ownership</NativeHeaderToolbar.Label>
              {OWNERSHIP_FILTERS.map((value) => (
                <NativeHeaderToolbar.MenuAction
                  key={value}
                  isOn={value === props.ownershipFilter}
                  onPress={() => props.onOwnershipFilterChange(value)}
                >
                  <NativeHeaderToolbar.Label>
                    {OWNERSHIP_FILTER_LABELS[value]}
                  </NativeHeaderToolbar.Label>
                </NativeHeaderToolbar.MenuAction>
              ))}
            </NativeHeaderToolbar.Menu>

            {props.ownershipFilter === "mine" || props.ownershipFilter === "theirs" ? (
              <NativeHeaderToolbar.Menu
                title={props.ownershipFilter === "mine" ? "Mine includes" : "Theirs includes"}
              >
                <NativeHeaderToolbar.Label>
                  {props.ownershipFilter === "mine" ? "Mine includes" : "Theirs includes"}
                </NativeHeaderToolbar.Label>
                {OWNERSHIP_RELATIONS.map((value) => (
                  <NativeHeaderToolbar.MenuAction
                    key={value}
                    isOn={value === props.ownershipRelation}
                    onPress={() => props.onOwnershipRelationChange(value)}
                  >
                    <NativeHeaderToolbar.Label>
                      {OWNERSHIP_RELATION_LABELS[value]}
                    </NativeHeaderToolbar.Label>
                  </NativeHeaderToolbar.MenuAction>
                ))}
              </NativeHeaderToolbar.Menu>
            ) : null}

            {props.projects.length > 0 ? (
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
                  subtitle="Move settled threads out of the main list"
                >
                  <NativeHeaderToolbar.Label>Hide settled</NativeHeaderToolbar.Label>
                </NativeHeaderToolbar.MenuAction>
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
