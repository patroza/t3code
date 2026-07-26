import { isLiquidGlassSupported, LiquidGlassView } from "@callstack/liquid-glass";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { effectiveSettled } from "@t3tools/client-runtime/state/thread-settled";
import { LegendList } from "@legendapp/list/react-native";
import type { MenuAction } from "@react-native-menu/menu";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { LayoutChangeEvent, NativeScrollEvent, NativeSyntheticEvent } from "react-native";
import { Platform, Pressable, StyleSheet, TextInput, View, useColorScheme } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import type { SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { SearchBarCommands } from "react-native-screens";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";

import { AppText as Text } from "../../components/AppText";
import { ControlPillMenu } from "../../components/ControlPill";
import { SymbolView } from "../../components/AppSymbol";
import { NATIVE_LIQUID_GLASS_SUPPORTED } from "../../native/native-glass";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { scopedProjectKey, scopedThreadKey } from "../../lib/scopedEntities";
import { useThemeColor } from "../../lib/useThemeColor";
import { useProjects, useThreadShells } from "../../state/entities";
import {
  resolveHideSettledOnProjects,
  resolveHideSettledOnRecent,
} from "../../persistence/mobile-preferences";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { environmentServerConfigsAtom } from "../../state/server";
import { usePendingNewTasks, type PendingNewTask } from "../../state/use-pending-new-tasks";
import { useWorkspaceState } from "../../state/workspace";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { useHardwareKeyboardCommand } from "../keyboard/hardwareKeyboardCommands";
import { BoardScreen } from "../board/BoardScreen";
import {
  hasCustomHomeListOptions,
  PROJECT_SORT_OPTIONS,
  THREAD_SORT_OPTIONS,
  useHomeListOptions,
} from "../home/home-list-options";
import { buildHomeListFilterMenu } from "../home/home-list-filter-menu";
import { matchesEnvironmentFilter } from "../home/homeEnvironmentFilter";
import {
  buildHomeListLayout,
  buildHomeRecentListLayout,
  DEFAULT_GROUP_DISPLAY_STATE,
  homeListItemsAreEqual,
  nextGroupDisplayState,
  type HomeGroupDisplayAction,
  type HomeGroupDisplayState,
  type HomeListItem,
} from "../home/homeListItems";
import { buildHomeRecentListEntries, buildHomeRecentPendingEntries } from "../home/homeRecentList";
import { HOME_LIST_MODE_TITLES } from "../home/homeListMode";
import { buildHomeProjectScopes, buildHomeThreadGroups } from "../home/homeThreadList";
import { SwipeableScrollGateProvider, useSwipeableScrollGate } from "../home/thread-swipe-actions";
import { usePendingTaskListActions } from "../home/usePendingTaskListActions";
import { useThreadListActions } from "../home/useThreadListActions";
import { WorkspaceConnectionStatus } from "../home/WorkspaceConnectionStatus";
import { shouldShowWorkspaceConnectionStatus } from "../home/workspace-connection-status";
import { SidebarHeaderActions } from "./sidebar-header-actions";
import { SidebarFilterButton } from "./sidebar-filter-button";
import { createSidebarHeaderItems } from "./sidebar-native-header-items";
import { SidebarNavigationShell } from "./sidebar-navigation-shell";
import {
  PendingTaskListRow,
  ThreadListGroupHeader,
  ThreadListRow,
  ThreadListShowMoreRow,
} from "./thread-list-items";
import { ThreadListV2Row } from "./thread-list-v2-items";
import {
  buildThreadListV2Items,
  THREAD_LIST_V2_SETTLED_INITIAL_COUNT,
  THREAD_LIST_V2_SETTLED_PAGE_COUNT,
  type ThreadListV2Item,
} from "./threadListV2";

/** The sidebar list serves both lists: v1 grouped items or, when the Thread
    List v2 beta is on, queued offline tasks, flat v2 rows, and a settled
    "Show more" pager. */
type SidebarListItem =
  | HomeListItem
  | {
      readonly type: "v2-pending-task";
      readonly key: string;
      readonly pendingTask: PendingNewTask;
      readonly isLast: boolean;
    }
  | { readonly type: "v2-thread"; readonly key: string; readonly item: ThreadListV2Item }
  | { readonly type: "v2-show-more"; readonly key: string; readonly hiddenCount: number };

/**
 * Shared capsule behind the sidebar header buttons — a native liquid-glass
 * surface on iOS 26+, a tinted pill everywhere else.
 */
function SidebarHeaderButtonGroup(props: {
  readonly children: ReactNode;
  readonly colorScheme: "light" | "dark";
}) {
  if (isLiquidGlassSupported) {
    return (
      <LiquidGlassView
        colorScheme={props.colorScheme}
        effect="regular"
        interactive
        style={styles.headerButtonGroup}
      >
        {props.children}
      </LiquidGlassView>
    );
  }

  return (
    <View
      style={[
        styles.headerButtonGroup,
        props.colorScheme === "dark"
          ? { backgroundColor: "rgba(118,118,128,0.24)", borderColor: "rgba(255,255,255,0.08)" }
          : { backgroundColor: "rgba(255,255,255,0.72)", borderColor: "rgba(0,0,0,0.08)" },
        { borderWidth: StyleSheet.hairlineWidth },
      ]}
    >
      {props.children}
    </View>
  );
}

const SIDEBAR_STICKY_HEADER_HEIGHT = 106;
const SIDEBAR_STICKY_HEADER_FADE_HEIGHT = 44;
const SIDEBAR_HEADER_WASH_OPACITY = {
  dark: [0.22, 0.14, 0.04],
  light: [0.46, 0.3, 0.08],
} as const;

interface ThreadNavigationSidebarProps {
  readonly width: number;
  readonly visible: boolean;
  readonly selectedThreadKey: string | null;
  readonly onOpenSettings: () => void;
  readonly onOpenEnvironmentSettings: () => void;
  readonly onNewThreadInProject: (project: EnvironmentProject) => void;
  readonly onSearchQueryChange: (query: string) => void;
  readonly onSelectThread: (thread: EnvironmentThreadShell) => void;
  readonly onRequestVisibility: () => void;
  readonly searchQuery: string;
}

/**
 * iPad/large-width sidebar column.
 *
 * On iOS the pane is hosted inside its own navigation-inert single-screen
 * native stack (SidebarNavigationShell) so the header is a real
 * UINavigationBar: large title, native bar-button items, and a
 * UISearchController search field — the same chrome a UISplitViewController
 * column gets. Other platforms keep the custom header chrome.
 */
export function ThreadNavigationSidebar(props: ThreadNavigationSidebarProps) {
  if (Platform.OS !== "ios") {
    return <ThreadNavigationSidebarPane {...props} nativeChrome={false} />;
  }
  return <NativeSidebarContainer {...props} />;
}

function NativeSidebarContainer(props: ThreadNavigationSidebarProps) {
  const backgroundColor = useThemeColor("--color-drawer");
  const borderColor = useThemeColor("--color-border");

  return (
    <View
      testID="thread-navigation-sidebar"
      className="flex-1"
      style={{
        width: props.width,
        backgroundColor,
        borderRightColor: borderColor,
        borderRightWidth: StyleSheet.hairlineWidth,
      }}
    >
      <SidebarNavigationShell>
        <ThreadNavigationSidebarPane {...props} nativeChrome />
      </SidebarNavigationShell>
    </View>
  );
}

function ThreadNavigationSidebarPane(
  props: ThreadNavigationSidebarProps & { readonly nativeChrome: boolean },
) {
  const insets = useSafeAreaInsets();
  const colorScheme = useColorScheme() === "dark" ? "dark" : "light";
  const projects = useProjects();
  const threads = useThreadShells();
  const { state: catalogState } = useWorkspaceState();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const [headerIsOverContent, setHeaderIsOverContent] = useState(false);
  const searchInputRef = useRef<TextInput>(null);
  const searchBarRef = useRef<SearchBarCommands>(null);
  const openSwipeableRef = useRef<SwipeableMethods | null>(null);
  const headerIsOverContentRef = useRef(false);
  const sidebarScrollGesture = useMemo(() => Gesture.Native(), []);
  const { archiveThread, confirmDeleteThread, settleThread, unsettleThread } =
    useThreadListActions();
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const pendingTasks = usePendingNewTasks();
  const { openPendingTask, confirmDeletePendingTask } = usePendingTaskListActions();
  const environments = useMemo(
    () =>
      Object.values(savedConnectionsById)
        .map((connection) => ({
          environmentId: connection.environmentId,
          label: connection.environmentLabel,
        }))
        .sort((left, right) => left.label.localeCompare(right.label)),
    [savedConnectionsById],
  );
  const availableEnvironmentIds = useMemo(
    () => new Set(environments.map((environment) => environment.environmentId)),
    [environments],
  );
  const {
    options,
    toggleSelectedEnvironmentId,
    clearSelectedEnvironments,
    setListMode,
    setProjectSortOrder,
    setThreadSortOrder,
  } = useHomeListOptions(availableEnvironmentIds);
  // Thread List v2 only applies in Projects mode; Recent/Board use fixed layouts.
  const threadListV2Enabled =
    options.listMode === "projects" &&
    AsyncResult.isSuccess(preferencesResult) &&
    preferencesResult.value.threadListV2Enabled === true;
  const hideSettledOnRecent = AsyncResult.isSuccess(preferencesResult)
    ? resolveHideSettledOnRecent(preferencesResult.value)
    : true;
  const hideSettledOnProjects = AsyncResult.isSuccess(preferencesResult)
    ? resolveHideSettledOnProjects(preferencesResult.value)
    : false;
  const hideSettledThreads =
    options.listMode === "projects" ? hideSettledOnProjects : hideSettledOnRecent;
  const setHideSettledThreads = useCallback(
    (hide: boolean) => {
      if (options.listMode === "projects") {
        savePreferences({ hideSettledOnProjects: hide });
        return;
      }
      savePreferences({ hideSettledOnRecent: hide });
    },
    [options.listMode, savePreferences],
  );
  const [selectedProjectKey, setSelectedProjectKey] = useState<string | null>(null);
  const projectScopes = useMemo(
    () =>
      buildHomeProjectScopes({
        projects,
        selectedEnvironmentIds: options.selectedEnvironmentIds,
        projectGroupingMode: options.projectGroupingMode,
      }),
    [options.projectGroupingMode, options.selectedEnvironmentIds, projects],
  );
  const projectFilterOptions = useMemo(
    () =>
      projectScopes.map((scope) => ({
        key: scope.key,
        label: scope.title,
      })),
    [projectScopes],
  );
  const projectTitleByProjectKey = useMemo(
    () =>
      new Map(
        projectScopes.flatMap((scope) =>
          scope.projectRefs.map(
            (projectRef) =>
              [
                scopedProjectKey(projectRef.environmentId, projectRef.projectId),
                scope.title,
              ] as const,
          ),
        ),
      ),
    [projectScopes],
  );
  const selectedProjectScope = useMemo(
    () =>
      selectedProjectKey === null
        ? null
        : (projectScopes.find((scope) => scope.key === selectedProjectKey) ?? null),
    [projectScopes, selectedProjectKey],
  );
  useEffect(() => {
    if (
      selectedProjectKey !== null &&
      !projectFilterOptions.some((project) => project.key === selectedProjectKey)
    ) {
      setSelectedProjectKey(null);
    }
  }, [projectFilterOptions, selectedProjectKey]);
  const selectedProjectRefs = useMemo(
    () =>
      selectedProjectScope === null
        ? null
        : new Set(
            selectedProjectScope.projectRefs.map((projectRef) =>
              scopedProjectKey(projectRef.environmentId, projectRef.projectId),
            ),
          ),
    [selectedProjectScope],
  );
  const scopedProjects = useMemo(
    () =>
      selectedProjectRefs === null
        ? projects
        : projects.filter((project) =>
            selectedProjectRefs.has(scopedProjectKey(project.environmentId, project.id)),
          ),
    [projects, selectedProjectRefs],
  );
  const scopedThreads = useMemo(
    () =>
      selectedProjectRefs === null
        ? threads
        : threads.filter((thread) =>
            selectedProjectRefs.has(scopedProjectKey(thread.environmentId, thread.projectId)),
          ),
    [selectedProjectRefs, threads],
  );
  const scopedPendingTasks = useMemo(
    () =>
      selectedProjectRefs === null
        ? pendingTasks
        : pendingTasks.filter((pendingTask) =>
            selectedProjectRefs.has(
              scopedProjectKey(pendingTask.message.environmentId, pendingTask.creation.projectId),
            ),
          ),
    [pendingTasks, selectedProjectRefs],
  );
  const recentEntries = useMemo(
    () =>
      options.listMode === "recent"
        ? buildHomeRecentListEntries({
            projects: scopedProjects,
            threads: scopedThreads,
            selectedEnvironmentIds: options.selectedEnvironmentIds,
            projectRefKeys: selectedProjectRefs,
            searchQuery: props.searchQuery,
          })
        : [],
    [
      options.listMode,
      options.selectedEnvironmentIds,
      props.searchQuery,
      scopedProjects,
      scopedThreads,
      selectedProjectRefs,
    ],
  );
  const recentPendingEntries = useMemo(
    () =>
      options.listMode === "recent"
        ? buildHomeRecentPendingEntries({
            pendingTasks: scopedPendingTasks,
            selectedEnvironmentIds: options.selectedEnvironmentIds,
            projectRefKeys: selectedProjectRefs,
            searchQuery: props.searchQuery,
          })
        : [],
    [
      options.listMode,
      options.selectedEnvironmentIds,
      props.searchQuery,
      scopedPendingTasks,
      selectedProjectRefs,
    ],
  );
  const environmentLabelById = useMemo(() => {
    const map = new Map<string, string>();
    for (const connection of Object.values(savedConnectionsById)) {
      map.set(connection.environmentId, connection.environmentLabel);
    }
    return map;
  }, [savedConnectionsById]);
  const [groupDisplayStates, setGroupDisplayStates] = useState<
    ReadonlyMap<string, HomeGroupDisplayState>
  >(() => new Map());
  const updateGroupDisplay = useCallback((key: string, action: HomeGroupDisplayAction) => {
    setGroupDisplayStates((previous) => {
      const next = new Map(previous);
      next.set(
        key,
        nextGroupDisplayState(previous.get(key) ?? DEFAULT_GROUP_DISPLAY_STATE, action),
      );
      return next;
    });
  }, []);
  const hasSearchQuery = props.searchQuery.trim().length > 0;
  const projectCwdByKey = useMemo(() => {
    const map = new Map<string, string>();
    for (const project of projects) {
      map.set(scopedProjectKey(project.environmentId, project.id), project.workspaceRoot);
    }
    return map;
  }, [projects]);
  const projectByKey = useMemo(() => {
    const map = new Map<string, EnvironmentProject>();
    for (const project of projects) {
      map.set(scopedProjectKey(project.environmentId, project.id), project);
    }
    return map;
  }, [projects]);

  // Thread List v2 (beta) support — same model as the compact Home list
  // (HomeScreen.tsx): flat creation-order card block + settled recency tail.
  // PR states stream in per-row; merged/closed PRs auto-settle their thread
  // on the next partition.
  const [changeRequestStateByKey, setChangeRequestStateByKey] = useState<
    ReadonlyMap<string, "open" | "closed" | "merged">
  >(() => new Map());
  const handleChangeRequestState = useCallback(
    (threadKey: string, state: "open" | "closed" | "merged" | null) => {
      setChangeRequestStateByKey((current) => {
        if ((current.get(threadKey) ?? null) === state) return current;
        const next = new Map(current);
        if (state === null) {
          next.delete(threadKey);
        } else {
          next.set(threadKey, state);
        }
        return next;
      });
    },
    [],
  );
  // The settled tail renders in pages; expansion resets when the filter
  // context changes so environment/search flips never inherit a deep page.
  const [settledVisibleCount, setSettledVisibleCount] = useState(
    THREAD_LIST_V2_SETTLED_INITIAL_COUNT,
  );
  const settledResetKey = `${options.selectedEnvironmentIds.join(",") || "all"}:${selectedProjectKey ?? "all"}:${props.searchQuery.trim()}`;
  const lastSettledResetKeyRef = useRef(settledResetKey);
  if (lastSettledResetKeyRef.current !== settledResetKey) {
    lastSettledResetKeyRef.current = settledResetKey;
    setSettledVisibleCount(THREAD_LIST_V2_SETTLED_INITIAL_COUNT);
  }
  const showMoreSettled = useCallback(
    () => setSettledVisibleCount((count) => count + THREAD_LIST_V2_SETTLED_PAGE_COUNT),
    [],
  );
  // now ticks per minute so the inactivity auto-settle boundary is actually
  // crossed while the pane stays open; without a clock dependency the
  // partition memoizes a frozen "now".
  const [nowMinute, setNowMinute] = useState(() => new Date().toISOString().slice(0, 16));
  // Snooze wake times are second-precise; a counter bumped exactly at the
  // next wake boundary re-runs the partition with a fresh clock so a woken
  // thread reappears immediately instead of on the next minute tick.
  const [snoozeWakeTick, bumpSnoozeWakeTick] = useState(0);
  const needsSettlementClock =
    threadListV2Enabled || options.listMode === "recent" || options.listMode === "projects";
  useEffect(() => {
    if (!needsSettlementClock) return;
    // Refresh immediately on enable: the mount-time value can be hours old
    // by the time the beta is switched on, which would misclassify the
    // inactivity auto-settle boundary until the first tick.
    setNowMinute(new Date().toISOString().slice(0, 16));
    const id = setInterval(() => setNowMinute(new Date().toISOString().slice(0, 16)), 60_000);
    return () => clearInterval(id);
  }, [needsSettlementClock]);
  // Threads on servers without the settlement capability never classify as
  // settled (the user could neither un-settle nor pin them).
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const settlementEnvironmentIds = useMemo(() => {
    const supported = new Set<EnvironmentId>();
    for (const [environmentId, config] of serverConfigs) {
      if (config.environment.capabilities.threadSettlement === true) {
        supported.add(environmentId);
      }
    }
    return supported;
  }, [serverConfigs]);
  const snoozeEnvironmentIds = useMemo(() => {
    const supported = new Set<EnvironmentId>();
    for (const [environmentId, config] of serverConfigs) {
      if (config.environment.capabilities.threadSnooze === true) {
        supported.add(environmentId);
      }
    }
    return supported;
  }, [serverConfigs]);

  const settledThreadKeys = useMemo(() => {
    if (options.listMode === "board") {
      return new Set<string>();
    }
    const now = `${nowMinute}:00.000Z`;
    const keys = new Set<string>();
    for (const thread of scopedThreads) {
      if (thread.archivedAt !== null) continue;
      if (!settlementEnvironmentIds.has(thread.environmentId)) continue;
      if (
        effectiveSettled(thread, {
          now,
          autoSettleAfterDays: 3,
          changeRequestState: null,
        })
      ) {
        keys.add(scopedThreadKey(thread.environmentId, thread.id));
      }
    }
    return keys;
  }, [nowMinute, options.listMode, scopedThreads, settlementEnvironmentIds]);

  const threadsForProjectList = useMemo(() => {
    if (!hideSettledThreads) return scopedThreads;
    return scopedThreads.filter(
      (thread) => !settledThreadKeys.has(scopedThreadKey(thread.environmentId, thread.id)),
    );
  }, [hideSettledThreads, scopedThreads, settledThreadKeys]);

  const visibleRecentEntries = useMemo(() => {
    if (options.listMode !== "recent") return [];
    return recentEntries.flatMap((entry) => {
      const key = scopedThreadKey(entry.thread.environmentId, entry.thread.id);
      if (hideSettledThreads && settledThreadKeys.has(key)) {
        return [];
      }
      return [{ thread: entry.thread, projectTitle: entry.project.title }];
    });
  }, [hideSettledThreads, options.listMode, recentEntries, settledThreadKeys]);

  const groups = useMemo(
    () =>
      options.listMode === "projects" && !threadListV2Enabled
        ? buildHomeThreadGroups({
            projects: scopedProjects,
            threads: threadsForProjectList,
            pendingTasks: scopedPendingTasks,
            selectedEnvironmentIds: options.selectedEnvironmentIds,
            searchQuery: props.searchQuery,
            projectSortOrder: options.projectSortOrder,
            threadSortOrder: options.threadSortOrder,
            projectGroupingMode: options.projectGroupingMode,
          })
        : [],
    [
      options,
      props.searchQuery,
      scopedPendingTasks,
      scopedProjects,
      threadListV2Enabled,
      threadsForProjectList,
    ],
  );

  const listLayout = useMemo(() => {
    if (options.listMode === "recent") {
      return buildHomeRecentListLayout({
        pendingTasks: recentPendingEntries.map((entry) => entry.pendingTask),
        entries: visibleRecentEntries,
      });
    }
    if (options.listMode !== "projects") {
      return { items: [] as HomeListItem[], stickyHeaderIndices: [] as number[] };
    }
    return buildHomeListLayout({
      groups,
      displayStates: groupDisplayStates,
      showAllThreads: hasSearchQuery,
    });
  }, [
    groupDisplayStates,
    groups,
    hasSearchQuery,
    options.listMode,
    recentPendingEntries,
    visibleRecentEntries,
  ]);

  const threadListV2Layout = useMemo(() => {
    if (!threadListV2Enabled)
      return { items: [], hiddenSettledCount: 0, snoozedCount: 0, nextSnoozeWakeAt: null };
    const layout = buildThreadListV2Items({
      threads: threads.filter((thread) => thread.archivedAt === null),
      selectedEnvironmentIds: options.selectedEnvironmentIds,
      projectRefs: selectedProjectScope === null ? null : selectedProjectScope.projectRefs,
      searchQuery: props.searchQuery,
      changeRequestStateByKey,
      settlementEnvironmentIds,
      snoozeEnvironmentIds,
      settledLimit: hideSettledThreads ? 0 : settledVisibleCount,
      now: `${nowMinute}:00.000Z`,
      snoozeNow: new Date().toISOString(),
    });
    if (!hideSettledThreads) return layout;
    return {
      ...layout,
      items: layout.items.filter((item) => item.variant === "card"),
      hiddenSettledCount: 0,
    };
  }, [
    changeRequestStateByKey,
    hideSettledThreads,
    nowMinute,
    snoozeWakeTick,
    options.selectedEnvironmentIds,
    props.searchQuery,
    settledVisibleCount,
    settlementEnvironmentIds,
    snoozeEnvironmentIds,
    threadListV2Enabled,
    threads,
    selectedProjectScope,
  ]);
  // Re-partition the moment the earliest snooze expires (clamped to the
  // signed-32-bit setTimeout range; far-future wakes re-arm at the clamp).
  const nextSnoozeWakeAt = threadListV2Layout.nextSnoozeWakeAt;
  useEffect(() => {
    if (nextSnoozeWakeAt === null) return;
    const wakeAtMs = Date.parse(nextSnoozeWakeAt);
    if (Number.isNaN(wakeAtMs)) return;
    const delayMs = Math.min(Math.max(0, wakeAtMs - Date.now()) + 50, 2_147_483_647);
    const id = setTimeout(() => bumpSnoozeWakeTick((tick) => tick + 1), delayMs);
    return () => clearTimeout(id);
    // snoozeWakeTick must re-arm the timer even when nextSnoozeWakeAt is
    // unchanged: after a clamped fire (wake beyond the 32-bit setTimeout
    // range) the boundary string is identical and the chain would die.
  }, [nextSnoozeWakeAt, snoozeWakeTick]);
  const listItems = useMemo<readonly SidebarListItem[]>(() => {
    if (!threadListV2Enabled) return listLayout.items;
    // Queued offline tasks render above the thread rows (mirrors the
    // compact Home v2 list): they are not thread shells, so the v2 item
    // builder never sees them, but they must stay visible and deletable
    // while their environment is offline. Same environment scope and
    // search filter as the list.
    const v2SearchQuery = props.searchQuery.trim().toLocaleLowerCase();
    const v2PendingTasks = pendingTasks.filter(
      (pendingTask) =>
        matchesEnvironmentFilter(
          pendingTask.message.environmentId,
          options.selectedEnvironmentIds,
        ) &&
        (selectedProjectRefs === null ||
          selectedProjectRefs.has(
            scopedProjectKey(pendingTask.message.environmentId, pendingTask.creation.projectId),
          )) &&
        (v2SearchQuery.length === 0 ||
          pendingTask.title.toLocaleLowerCase().includes(v2SearchQuery)),
    );
    const items: SidebarListItem[] = v2PendingTasks.map((pendingTask, index) => ({
      type: "v2-pending-task" as const,
      key: `v2-pending:${pendingTask.message.messageId}`,
      pendingTask,
      isLast: index === v2PendingTasks.length - 1,
    }));
    for (const item of threadListV2Layout.items) {
      items.push({
        type: "v2-thread" as const,
        key: scopedThreadKey(item.thread.environmentId, item.thread.id),
        item,
      });
    }
    if (threadListV2Layout.hiddenSettledCount > 0) {
      items.push({
        type: "v2-show-more",
        key: "v2-show-more",
        hiddenCount: threadListV2Layout.hiddenSettledCount,
      });
    }
    return items;
  }, [
    listLayout.items,
    options.selectedEnvironmentIds,
    pendingTasks,
    props.searchQuery,
    selectedProjectRefs,
    threadListV2Enabled,
    threadListV2Layout,
  ]);
  const showsConnectionStatus = shouldShowWorkspaceConnectionStatus(catalogState);
  const listOrganization = options.listMode === "projects" && !threadListV2Enabled;
  const listMenuActions = useMemo<MenuAction[]>(
    () => [
      {
        id: "environment",
        title: "Environment",
        subactions: [
          {
            id: "environment:all",
            title: "All environments",
            subtitle: "Show threads from every environment",
            state: options.selectedEnvironmentIds.length === 0 ? "on" : "off",
          },
          ...environments.map((environment) => ({
            id: `environment:${environment.environmentId}`,
            title: environment.label,
            state:
              options.selectedEnvironmentIds.length === 0 ||
              options.selectedEnvironmentIds.includes(environment.environmentId)
                ? ("on" as const)
                : ("off" as const),
          })),
        ],
      },
      ...(projectFilterOptions.length === 0 || options.listMode === "board"
        ? []
        : ([
            {
              id: "project",
              title: "Project",
              subactions: [
                {
                  id: "project:all",
                  title: "All projects",
                  subtitle: "Show threads from every project",
                  state: selectedProjectKey === null ? "on" : "off",
                },
                ...projectFilterOptions.map((project) => ({
                  id: `project:${project.key}`,
                  title: project.label,
                  state: selectedProjectKey === project.key ? ("on" as const) : ("off" as const),
                })),
              ],
            },
          ] satisfies MenuAction[])),
      ...(options.listMode === "recent" || options.listMode === "projects"
        ? ([
            {
              id: "hide-settled",
              title: "Hide settled",
              state: hideSettledThreads ? ("on" as const) : ("off" as const),
            },
          ] satisfies MenuAction[])
        : []),
      // Sort controls only apply in Projects classic layout. v2/Recent/Board
      // use fixed order; environment multi-filter still scopes every mode.
      ...(listOrganization
        ? ([
            {
              id: "project-sort",
              title: "Sort projects",
              subactions: PROJECT_SORT_OPTIONS.map((option) => ({
                id: `project-sort:${option.value}`,
                title: option.label,
                state: options.projectSortOrder === option.value ? "on" : "off",
              })),
            },
            {
              id: "thread-sort",
              title: "Sort threads",
              subactions: THREAD_SORT_OPTIONS.map((option) => ({
                id: `thread-sort:${option.value}`,
                title: option.label,
                state: options.threadSortOrder === option.value ? "on" : "off",
              })),
            },
          ] satisfies MenuAction[])
        : []),
    ],
    [
      environments,
      hideSettledThreads,
      listOrganization,
      options.listMode,
      options.projectSortOrder,
      options.selectedEnvironmentIds,
      options.threadSortOrder,
      projectFilterOptions,
      selectedProjectKey,
    ],
  );
  const handleListMenuAction = useCallback(
    ({ nativeEvent }: { readonly nativeEvent: { readonly event: string } }) => {
      const event = nativeEvent.event;
      if (event === "environment:all") {
        clearSelectedEnvironments();
        return;
      }
      if (event.startsWith("environment:")) {
        const environment = environments.find(
          (candidate) => String(candidate.environmentId) === event.slice("environment:".length),
        );
        if (environment) toggleSelectedEnvironmentId(environment.environmentId);
        return;
      }
      if (event === "hide-settled") {
        setHideSettledThreads(!hideSettledThreads);
        return;
      }
      if (event === "project:all") {
        setSelectedProjectKey(null);
        return;
      }
      if (event.startsWith("project:")) {
        const projectKey = event.slice("project:".length);
        if (projectFilterOptions.some((project) => project.key === projectKey)) {
          setSelectedProjectKey(projectKey);
        }
        return;
      }
      const projectSort = PROJECT_SORT_OPTIONS.find(
        (option) => `project-sort:${option.value}` === event,
      );
      if (projectSort) {
        setProjectSortOrder(projectSort.value);
        return;
      }
      const threadSort = THREAD_SORT_OPTIONS.find(
        (option) => `thread-sort:${option.value}` === event,
      );
      if (threadSort) {
        setThreadSortOrder(threadSort.value);
        return;
      }
    },
    [
      clearSelectedEnvironments,
      environments,
      hideSettledThreads,
      projectFilterOptions,
      setHideSettledThreads,
      setProjectSortOrder,
      setThreadSortOrder,
      toggleSelectedEnvironmentId,
    ],
  );

  const backgroundColor = useThemeColor("--color-drawer");
  const borderColor = useThemeColor("--color-border");
  const mutedColor = useThemeColor("--color-foreground-muted");
  const placeholderColor = useThemeColor("--color-placeholder");
  const headerFadeColor = String(backgroundColor);
  const headerWashOpacity = SIDEBAR_HEADER_WASH_OPACITY[colorScheme];
  const [measuredHeaderHeight, setMeasuredHeaderHeight] = useState<number | null>(null);
  // The sticky header (title row, search field, optional connection status)
  // is measured so the list inset always matches its real height — no
  // hardcoded per-variant constants.
  const stickyHeaderHeight = measuredHeaderHeight ?? insets.top + SIDEBAR_STICKY_HEADER_HEIGHT;
  const topListInset = stickyHeaderHeight + 6;
  const handleStickyHeaderLayout = useCallback((event: LayoutChangeEvent) => {
    const nextHeight = Math.round(event.nativeEvent.layout.height);
    setMeasuredHeaderHeight((current) => (current === nextHeight ? current : nextHeight));
  }, []);
  const handleSwipeableWillOpen = useCallback((methods: SwipeableMethods) => {
    if (openSwipeableRef.current !== methods) {
      openSwipeableRef.current?.close();
      openSwipeableRef.current = methods;
    }
  }, []);
  const handleSwipeableClose = useCallback((methods: SwipeableMethods) => {
    if (openSwipeableRef.current === methods) {
      openSwipeableRef.current = null;
    }
  }, []);
  const handleSelectThread = useCallback(
    (thread: EnvironmentThreadShell) => {
      props.onSelectThread(thread);
      openSwipeableRef.current?.close();
    },
    [props.onSelectThread],
  );
  const handleScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const next = event.nativeEvent.contentOffset.y > 6;
    if (headerIsOverContentRef.current === next) {
      return;
    }
    headerIsOverContentRef.current = next;
    setHeaderIsOverContent(next);
  }, []);
  const handleScrollBeginDrag = useCallback(() => {
    openSwipeableRef.current?.close();
  }, []);
  const { swipeEnabled, scrollGateHandlers } = useSwipeableScrollGate({
    onScroll: handleScroll,
    onScrollBeginDrag: handleScrollBeginDrag,
  });
  const listExtraData = useMemo(
    () => ({
      selectedThreadKey: props.selectedThreadKey ?? "",
      savedConnectionsById,
      serverConfigs,
    }),
    [props.selectedThreadKey, savedConnectionsById, serverConfigs],
  );
  const sidebarItemsAreEqual = useCallback(
    (previous: SidebarListItem, item: SidebarListItem): boolean => {
      if (previous.type === "v2-thread" && item.type === "v2-thread") {
        return (
          previous.key === item.key &&
          previous.item.thread === item.item.thread &&
          previous.item.variant === item.item.variant &&
          previous.item.showSettledDivider === item.item.showSettledDivider
        );
      }
      if (previous.type === "v2-show-more" && item.type === "v2-show-more") {
        return previous.hiddenCount === item.hiddenCount;
      }
      if (previous.type === "v2-pending-task" && item.type === "v2-pending-task") {
        return previous.pendingTask === item.pendingTask && previous.isLast === item.isLast;
      }
      if (
        previous.type === "v2-thread" ||
        previous.type === "v2-show-more" ||
        previous.type === "v2-pending-task" ||
        item.type === "v2-thread" ||
        item.type === "v2-show-more" ||
        item.type === "v2-pending-task"
      ) {
        return false;
      }
      return homeListItemsAreEqual(previous, item);
    },
    [],
  );
  const focusSearch = useCallback(() => {
    const focus = () => {
      if (props.nativeChrome) {
        searchBarRef.current?.focus();
        return;
      }
      searchInputRef.current?.focus();
    };
    if (!props.visible) {
      props.onRequestVisibility();
      setTimeout(focus, 240);
    } else {
      focus();
    }
    return true;
  }, [props.nativeChrome, props.onRequestVisibility, props.visible]);
  useHardwareKeyboardCommand("focusSearch", focusSearch);
  const renderListItem = useCallback(
    ({ item }: { readonly item: SidebarListItem }) => {
      switch (item.type) {
        case "v2-pending-task":
          return (
            <PendingTaskListRow
              variant="sidebar"
              pendingTask={item.pendingTask}
              environmentLabel={
                savedConnectionsById[item.pendingTask.message.environmentId]?.environmentLabel ??
                null
              }
              isLast={item.isLast}
              onSelectPendingTask={openPendingTask}
              onDeletePendingTask={confirmDeletePendingTask}
            />
          );
        case "v2-thread": {
          const thread = item.item.thread;
          const scopeKey = scopedProjectKey(thread.environmentId, thread.projectId);
          return (
            <ThreadListV2Row
              thread={thread}
              variant={item.item.variant}
              showSettledDivider={item.item.showSettledDivider}
              project={projectByKey.get(scopeKey) ?? null}
              projectTitle={projectTitleByProjectKey.get(scopeKey)}
              providerDriver={
                serverConfigs
                  .get(thread.environmentId)
                  ?.providers.find(
                    (provider) =>
                      provider.instanceId ===
                      (thread.session?.providerInstanceId ?? thread.modelSelection.instanceId),
                  )?.driver ?? null
              }
              environmentLabel={
                Object.keys(savedConnectionsById).length > 1
                  ? (savedConnectionsById[thread.environmentId]?.environmentLabel ?? null)
                  : null
              }
              pane="sidebar"
              selected={
                scopedThreadKey(thread.environmentId, thread.id) === props.selectedThreadKey
              }
              fullSwipeWidth={props.width - 20}
              onSelectThread={handleSelectThread}
              onDeleteThread={confirmDeleteThread}
              onArchiveThread={archiveThread}
              settlementSupported={settlementEnvironmentIds.has(thread.environmentId)}
              onSettleThread={settleThread}
              onUnsettleThread={unsettleThread}
              onChangeRequestState={handleChangeRequestState}
              projectCwd={projectCwdByKey.get(scopeKey) ?? null}
              onSwipeableClose={handleSwipeableClose}
              onSwipeableWillOpen={handleSwipeableWillOpen}
              simultaneousSwipeGesture={sidebarScrollGesture}
            />
          );
        }
        case "v2-show-more":
          return (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Show ${Math.min(item.hiddenCount, THREAD_LIST_V2_SETTLED_PAGE_COUNT)} more settled threads`}
              onPress={showMoreSettled}
              className="mx-4 mt-2 items-center rounded-lg border border-dashed border-border py-2.5"
              style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
            >
              <Text className="text-xs font-t3-medium text-foreground-muted">
                Show more ({item.hiddenCount} settled hidden)
              </Text>
            </Pressable>
          );
        case "header":
          return (
            <ThreadListGroupHeader
              variant="sidebar"
              collapsed={item.collapsed}
              isFirst={item.isFirst}
              groupKey={item.group.key}
              onGroupAction={updateGroupDisplay}
              // Same gating as the compact Home list: aggregated groups have no
              // single target project, and pending-project groups hold a
              // placeholder shell rather than a real project.
              newThreadTarget={item.group.newThreadTarget}
              onNewThread={props.onNewThreadInProject}
              project={item.group.representative}
              threadCount={item.group.threads.length + item.group.pendingTasks.length}
              title={item.group.title}
            />
          );
        case "pending-task":
          return (
            <PendingTaskListRow
              variant="sidebar"
              pendingTask={item.pendingTask}
              environmentLabel={
                savedConnectionsById[item.pendingTask.message.environmentId]?.environmentLabel ??
                null
              }
              isLast={item.isLast}
              onSelectPendingTask={openPendingTask}
              onDeletePendingTask={confirmDeletePendingTask}
            />
          );
        case "thread": {
          const thread = item.thread;
          const threadKey = scopedThreadKey(thread.environmentId, thread.id);
          return (
            <ThreadListRow
              variant="sidebar"
              thread={thread}
              projectTitle={item.projectTitle}
              environmentLabel={
                savedConnectionsById[thread.environmentId]?.environmentLabel ?? null
              }
              projectCwd={
                projectCwdByKey.get(scopedProjectKey(thread.environmentId, thread.projectId)) ??
                null
              }
              isLast={item.isLast}
              selected={threadKey === props.selectedThreadKey}
              fullSwipeWidth={props.width - 20}
              settlementSupported={settlementEnvironmentIds.has(thread.environmentId)}
              isSettled={settledThreadKeys.has(threadKey)}
              onSettleThread={(target) => {
                void settleThread(target);
              }}
              onUnsettleThread={unsettleThread}
              onArchiveThread={archiveThread}
              onDeleteThread={confirmDeleteThread}
              onSelectThread={handleSelectThread}
              onSwipeableClose={handleSwipeableClose}
              onSwipeableWillOpen={handleSwipeableWillOpen}
              simultaneousSwipeGesture={sidebarScrollGesture}
            />
          );
        }
        case "show-more":
          return (
            <ThreadListShowMoreRow
              variant="sidebar"
              hiddenCount={item.hiddenCount}
              canShowLess={item.canShowLess}
              groupKey={item.groupKey}
              onGroupAction={updateGroupDisplay}
            />
          );
      }
    },
    [
      archiveThread,
      confirmDeletePendingTask,
      confirmDeleteThread,
      handleChangeRequestState,
      handleSelectThread,
      handleSwipeableClose,
      handleSwipeableWillOpen,
      openPendingTask,
      projectByKey,
      projectCwdByKey,
      projectTitleByProjectKey,
      props.onNewThreadInProject,
      props.selectedThreadKey,
      props.width,
      savedConnectionsById,
      serverConfigs,
      settleThread,
      settlementEnvironmentIds,
      settledThreadKeys,
      showMoreSettled,
      sidebarScrollGesture,
      unsettleThread,
      updateGroupDisplay,
    ],
  );
  // Outside Projects classic layout only the environment/project filters can
  // light the "customized" state (sort options are hidden).
  const filterCustomized =
    options.selectedEnvironmentIds.length > 0 ||
    selectedProjectKey !== null ||
    ((options.listMode === "recent" || options.listMode === "projects") &&
      hideSettledThreads !== (options.listMode === "recent")) ||
    (listOrganization && hasCustomHomeListOptions({ ...options, selectedProjectKey }));
  const filterIcon = filterCustomized
    ? "line.3.horizontal.decrease.circle.fill"
    : "line.3.horizontal.decrease.circle";
  const filterMenu = useMemo(
    () =>
      buildHomeListFilterMenu({
        environments,
        projects: projectFilterOptions,
        selectedEnvironmentIds: options.selectedEnvironmentIds,
        selectedProjectKey,
        projectSortOrder: options.projectSortOrder,
        threadSortOrder: options.threadSortOrder,
        onClearEnvironments: clearSelectedEnvironments,
        onToggleEnvironment: toggleSelectedEnvironmentId,
        onProjectChange: setSelectedProjectKey,
        onProjectSortOrderChange: setProjectSortOrder,
        onThreadSortOrderChange: setThreadSortOrder,
        listOrganization,
        showProjectFilter: options.listMode !== "board",
        ...(options.listMode === "recent" || options.listMode === "projects"
          ? {
              hideSettledThreads,
              onHideSettledThreadsChange: setHideSettledThreads,
            }
          : {}),
      }),
    [
      clearSelectedEnvironments,
      environments,
      hideSettledThreads,
      listOrganization,
      options.listMode,
      options.projectSortOrder,
      options.selectedEnvironmentIds,
      options.threadSortOrder,
      projectFilterOptions,
      selectedProjectKey,
      setHideSettledThreads,
      setProjectSortOrder,
      setThreadSortOrder,
      toggleSelectedEnvironmentId,
    ],
  );
  const boardContent =
    options.listMode === "board" ? (
      <BoardScreen
        projects={projects}
        threads={threads}
        projectGroupingMode={options.projectGroupingMode}
        environmentLabelById={environmentLabelById}
        selectedEnvironmentIds={options.selectedEnvironmentIds}
        onClearEnvironments={clearSelectedEnvironments}
        onToggleEnvironment={toggleSelectedEnvironmentId}
        onSelectThread={handleSelectThread}
        onArchiveThread={archiveThread}
        onDeleteThread={confirmDeleteThread}
        onSettleThread={settleThread}
        onUnsettleThread={unsettleThread}
      />
    ) : null;
  const nativeHeaderItems = useMemo(
    () =>
      createSidebarHeaderItems({
        filterIcon,
        filterMenu,
        listMode: options.listMode,
        onListModeChange: setListMode,
        onOpenSettings: props.onOpenSettings,
      }),
    [filterIcon, filterMenu, options.listMode, props.onOpenSettings, setListMode],
  );
  // "No threads yet" over an inbox that is merely all-snoozed reads as
  // data loss; name the snoozed threads instead.
  const snoozedCount = threadListV2Layout.snoozedCount;
  const listEmpty = (
    <Text className="px-2 py-4 text-sm text-foreground-muted">
      {catalogState.isLoadingConnections
        ? "Loading threads…"
        : props.searchQuery.trim().length > 0
          ? snoozedCount > 0
            ? // Snoozed matches passed this same search filter — "No
              // matching threads" would misreport them as nonexistent.
              snoozedCount === 1
              ? "1 matching thread snoozed"
              : "All matching threads snoozed"
            : "No matching threads"
          : snoozedCount > 0
            ? snoozedCount === 1
              ? "1 thread snoozed"
              : `${snoozedCount} threads snoozed`
            : selectedProjectScope !== null
              ? `No threads in ${selectedProjectScope.title}`
              : "No threads yet"}
    </Text>
  );

  if (props.nativeChrome) {
    return (
      <>
        <NativeStackScreenOptions
          optionsVersion={[nativeHeaderItems, options.listMode]}
          options={{
            title: HOME_LIST_MODE_TITLES[options.listMode],
            headerTitle: HOME_LIST_MODE_TITLES[options.listMode],
            // Board columns are not one UIKit-inset scroll view — solid bar
            // so cards never underlap the glass nav (same as Board route / home).
            ...(NATIVE_LIQUID_GLASS_SUPPORTED
              ? options.listMode === "board"
                ? {
                    headerTransparent: false,
                    headerStyle: {
                      backgroundColor: backgroundColor as unknown as string,
                    },
                    scrollEdgeEffects: undefined,
                  }
                : {
                    headerTransparent: true,
                    headerStyle: { backgroundColor: "transparent" },
                  }
              : {}),
            headerSearchBarOptions:
              options.listMode === "board"
                ? undefined
                : {
                    ref: searchBarRef,
                    autoCapitalize: "none",
                    hideNavigationBar: false,
                    // Keep the search bar pinned under the title — UIKit's default
                    // hidesSearchBarWhenScrolling collapses it on scroll.
                    hideWhenScrolling: false,
                    obscureBackground: false,
                    placeholder: "Search",
                    placement: "stacked",
                    onCancelButtonPress: () => {
                      props.onSearchQueryChange("");
                    },
                    onChangeText: (event) => {
                      props.onSearchQueryChange(event.nativeEvent.text);
                    },
                  },
            unstable_headerRightItems: () => nativeHeaderItems,
          }}
        />
        <View className="flex-1">
          {boardContent !== null ? (
            boardContent
          ) : (
            <SwipeableScrollGateProvider enabled={swipeEnabled}>
              <GestureDetector gesture={sidebarScrollGesture}>
                <LegendList
                  data={listItems}
                  drawDistance={500}
                  estimatedItemSize={64}
                  extraData={listExtraData}
                  getItemType={(item) => item.type}
                  itemsAreEqual={sidebarItemsAreEqual}
                  keyExtractor={(item) => item.key}
                  renderItem={renderListItem}
                  automaticallyAdjustsScrollIndicatorInsets={NATIVE_LIQUID_GLASS_SUPPORTED}
                  contentInsetAdjustmentBehavior={
                    NATIVE_LIQUID_GLASS_SUPPORTED ? "automatic" : "never"
                  }
                  contentContainerStyle={[
                    styles.threadListContent,
                    {
                      paddingBottom: Math.max(insets.bottom, 16) + 16,
                      paddingTop: 6,
                    },
                  ]}
                  keyboardDismissMode="on-drag"
                  keyboardShouldPersistTaps="handled"
                  {...scrollGateHandlers}
                  recycleItems
                  scrollEventThrottle={16}
                  showsVerticalScrollIndicator={false}
                  style={styles.threadList}
                  ListHeaderComponent={
                    showsConnectionStatus ? (
                      <View className="px-1.5 pt-0.5 pb-2">
                        <WorkspaceConnectionStatus
                          onPress={props.onOpenEnvironmentSettings}
                          state={catalogState}
                          variant="sidebar"
                        />
                      </View>
                    ) : null
                  }
                  ListEmptyComponent={listEmpty}
                />
              </GestureDetector>
            </SwipeableScrollGateProvider>
          )}
        </View>
      </>
    );
  }

  return (
    <View
      testID="thread-navigation-sidebar"
      className="flex-1"
      style={{
        width: props.width,
        backgroundColor,
        borderRightColor: borderColor,
        borderRightWidth: StyleSheet.hairlineWidth,
      }}
    >
      <View className="flex-1" style={{ paddingBottom: insets.bottom }}>
        {boardContent !== null ? (
          <View className="flex-1" style={{ paddingTop: topListInset }}>
            {boardContent}
          </View>
        ) : (
          <SwipeableScrollGateProvider enabled={swipeEnabled}>
            <GestureDetector gesture={sidebarScrollGesture}>
              <LegendList
                data={listItems}
                drawDistance={500}
                estimatedItemSize={64}
                extraData={listExtraData}
                getItemType={(item) => item.type}
                itemsAreEqual={sidebarItemsAreEqual}
                keyExtractor={(item) => item.key}
                renderItem={renderListItem}
                contentContainerStyle={[
                  styles.threadListContent,
                  {
                    paddingBottom: 16 + insets.bottom,
                    paddingTop: topListInset,
                  },
                ]}
                keyboardDismissMode="on-drag"
                keyboardShouldPersistTaps="handled"
                {...scrollGateHandlers}
                recycleItems
                scrollEventThrottle={16}
                showsVerticalScrollIndicator={false}
                style={styles.threadList}
                ListEmptyComponent={listEmpty}
              />
            </GestureDetector>
          </SwipeableScrollGateProvider>
        )}
      </View>

      <View
        className="absolute inset-x-0 top-0 z-[4]"
        onLayout={handleStickyHeaderLayout}
        pointerEvents="box-none"
        style={{ paddingTop: insets.top }}
      >
        <View
          className="absolute inset-x-0 top-0"
          pointerEvents="none"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={{ height: stickyHeaderHeight + SIDEBAR_STICKY_HEADER_FADE_HEIGHT }}
        >
          <Svg width="100%" height="100%">
            <Defs>
              <LinearGradient id="sidebar-header-wash" x1="0%" x2="0%" y1="0%" y2="100%">
                <Stop
                  offset="0%"
                  stopColor={headerFadeColor}
                  stopOpacity={headerIsOverContent ? headerWashOpacity[0] : 0}
                />
                <Stop
                  offset="58%"
                  stopColor={headerFadeColor}
                  stopOpacity={headerIsOverContent ? headerWashOpacity[1] : 0}
                />
                <Stop
                  offset="88%"
                  stopColor={headerFadeColor}
                  stopOpacity={headerIsOverContent ? headerWashOpacity[2] : 0}
                />
                <Stop offset="100%" stopColor={headerFadeColor} stopOpacity={0} />
              </LinearGradient>
            </Defs>
            <Rect width="100%" height="100%" fill="url(#sidebar-header-wash)" />
          </Svg>
        </View>
        <View className="h-[50px] flex-row items-end gap-0.5 pr-2 pl-5">
          <Text className="flex-1 text-[34px] font-t3-bold text-foreground" numberOfLines={1}>
            {HOME_LIST_MODE_TITLES[options.listMode]}
          </Text>
          <SidebarHeaderButtonGroup colorScheme={colorScheme}>
            <ControlPillMenu actions={listMenuActions} onPressAction={handleListMenuAction}>
              <SidebarFilterButton
                grouped
                accessibilityLabel="Filter and sort threads"
                icon={filterIcon}
              />
            </ControlPillMenu>
            <SidebarHeaderActions
              grouped
              listMode={options.listMode}
              onListModeChange={setListMode}
              onOpenSettings={props.onOpenSettings}
            />
          </SidebarHeaderButtonGroup>
        </View>

        {options.listMode === "board" ? null : (
          <View className="mx-4 mt-[9px] h-[38px] flex-row items-center gap-1.5 rounded-xl bg-sidebar-search pr-2.5 pl-[11px]">
            <SymbolView name="magnifyingglass" size={15} tintColor={mutedColor} type="monochrome" />
            <TextInput
              ref={searchInputRef}
              accessibilityLabel="Search threads"
              autoCapitalize="none"
              autoCorrect={false}
              clearButtonMode="while-editing"
              onChangeText={props.onSearchQueryChange}
              placeholder="Search"
              placeholderTextColor={placeholderColor}
              returnKeyType="search"
              className="h-[34px] flex-1 px-0 py-0 font-sans text-base text-foreground"
              value={props.searchQuery}
            />
          </View>
        )}

        {showsConnectionStatus ? (
          <View className="px-3.5 pt-2.5">
            <WorkspaceConnectionStatus
              onPress={props.onOpenEnvironmentSettings}
              state={catalogState}
              variant="sidebar"
            />
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  headerButtonGroup: {
    alignItems: "center",
    borderRadius: 22,
    flexDirection: "row",
    overflow: "hidden",
  },
  threadList: {
    flex: 1,
  },
  threadListContent: {
    paddingHorizontal: 8,
  },
});
