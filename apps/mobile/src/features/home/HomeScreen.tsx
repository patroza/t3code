import {
  LegendList,
  type LegendListRef,
  type LegendListRenderItemProps,
} from "@legendapp/list/react-native";
import {
  type EnvironmentProject,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import {
  threadSearchMatchKey,
  type EnvironmentThreadSearchMatch,
} from "@t3tools/client-runtime/state/thread-search";
import { effectiveSettled } from "@t3tools/client-runtime/state/thread-settled";
import { sortPinnedThreadsByOrderKey } from "@t3tools/client-runtime/state/thread-sort";
import type {
  EnvironmentId,
  SidebarProjectGroupingMode,
  SidebarThreadSortOrder,
} from "@t3tools/contracts";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Platform, Pressable, View } from "react-native";
import type { SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import type { WorkspaceEnvironment, WorkspaceState } from "../../state/workspaceModel";
import type { SavedRemoteConnection } from "../../lib/connection";
import { scopedProjectKey, scopedThreadKey } from "../../lib/scopedEntities";
import { NATIVE_LIQUID_GLASS_SUPPORTED } from "../../native/native-glass";

const PRE_LIQUID_GLASS_BOTTOM_TOOLBAR_HEIGHT = 44;
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { useThreadSearch } from "../../state/queries";
import { environmentServerConfigsAtom } from "../../state/server";
import type { PendingNewTask } from "../../state/use-pending-new-tasks";
import { BoardScreen } from "../board/BoardScreen";
import {
  PendingTaskListRow,
  ThreadListGroupHeader,
  ThreadListRow,
  ThreadListSectionHeader,
  ThreadListShowMoreRow,
} from "../threads/thread-list-items";
import {
  ThreadListV2PendingRow,
  ThreadListV2Row,
  ThreadListV2SettledShelfHeader,
  ThreadListV2SnoozedShelfHeader,
} from "../threads/thread-list-v2-items";
import {
  buildThreadListV2Items,
  buildThreadListV2ListItems,
  THREAD_LIST_V2_SETTLED_INITIAL_COUNT,
  THREAD_LIST_V2_SETTLED_PAGE_COUNT,
  type ThreadListV2ChangeRequestState,
  type ThreadListV2ListItem,
} from "../threads/threadListV2";
import { useThreadListV2Enabled } from "../threads/use-thread-list-v2-enabled";
import { useThreadListV2ShelfPreferences } from "../threads/use-thread-list-v2-shelf-preferences";
import type { HomeListFilterMenuEnvironment } from "./home-list-filter-menu";
import {
  buildHomeListLayout,
  buildHomeRecentListLayout,
  DEFAULT_GROUP_DISPLAY_STATE,
  homeListItemsAreEqual,
  nextGroupDisplayState,
  type HomeGroupDisplayAction,
  type HomeGroupDisplayState,
  type HomeListItem,
} from "./homeListItems";
import {
  usesFlatThreadGrouping,
  usesProjectThreadGrouping,
  type HomeListMode,
  type HomeThreadGrouping,
} from "./homeListMode";
import { buildHomeRecentListEntries, buildHomeRecentPendingEntries } from "./homeRecentList";
import {
  buildHomeProjectScopes,
  buildHomeThreadGroups,
  sortHomeProjectScopes,
  type HomeProjectSortOrder,
} from "./homeThreadList";
import { SwipeableScrollGateProvider, useSwipeableScrollGate } from "./thread-swipe-actions";

/* ─── Types ──────────────────────────────────────────────────────────── */

interface HomeScreenProps {
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly pendingTasks: ReadonlyArray<PendingNewTask>;
  readonly catalogState: WorkspaceState;
  readonly savedConnectionsById: Readonly<Record<string, SavedRemoteConnection>>;
  readonly environments: ReadonlyArray<
    HomeListFilterMenuEnvironment & Pick<WorkspaceEnvironment, "connectionState">
  >;
  readonly searchQuery: string;
  readonly listMode: HomeListMode;
  readonly threadGrouping: HomeThreadGrouping;
  readonly selectedEnvironmentIds: readonly EnvironmentId[];
  readonly selectedProjectKey: string | null;
  /**
   * When true, settled threads leave the main inbox:
   * - **Threads v2:** always keeps a settled slim shelf (web V2 parity); this
   *   flag is ignored for the v2 partition.
   * - **Classic recency/none:** collapsible-style bottom Settled section
   *   (web classic Recent shelf parity) — not hard-deleted.
   * - **Classic project:** omit from each project group (web project parity).
   * Recency/none default on; project grouping defaults off (call site).
   */
  readonly hideSettledThreads: boolean;
  readonly projectSortOrder: HomeProjectSortOrder;
  readonly threadSortOrder: SidebarThreadSortOrder;
  readonly projectGroupingMode: SidebarProjectGroupingMode;
  readonly onSearchQueryChange: (query: string) => void;
  readonly onClearEnvironments: () => void;
  readonly onToggleEnvironment: (environmentId: EnvironmentId) => void;
  readonly onProjectChange: (projectKey: string | null) => void;
  readonly onProjectSortOrderChange: (sortOrder: HomeProjectSortOrder) => void;
  readonly onThreadSortOrderChange: (sortOrder: SidebarThreadSortOrder) => void;
  readonly onAddConnection: () => void;
  readonly onOpenSettings: () => void;
  readonly onStartNewTask: () => void;
  readonly onSelectThread: (thread: EnvironmentThreadShell) => void;
  readonly onArchiveThread: (thread: EnvironmentThreadShell) => void;
  readonly onDeleteThread: (thread: EnvironmentThreadShell) => void;
  /** Resolves true iff the settle was dispatched and succeeded. */
  readonly onSettleThread: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly onSnoozeThread: (
    thread: EnvironmentThreadShell,
    snoozedUntil: string,
  ) => Promise<boolean>;
  readonly onUnsnoozeThread: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly onUnsettleThread: (thread: EnvironmentThreadShell) => void;
  readonly onPinThread: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly onUnpinThread: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly onMovePinnedThread: (
    thread: EnvironmentThreadShell,
    direction: "up" | "down",
  ) => Promise<boolean>;
  readonly onRegenerateThreadTitle: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly onSelectPendingTask: (pendingTask: PendingNewTask) => void;
  readonly onDeletePendingTask: (pendingTask: PendingNewTask) => void;
  readonly onNewThreadInProject: (project: EnvironmentProject) => void;
}

/* ─── Layout constants ───────────────────────────────────────────────── */

const ESTIMATED_THREAD_ROW_HEIGHT = 72;
/**
 * Top spacing between the list and the Android custom header. The Android
 * header (AndroidHomeHeader) is rendered in-flow above this screen and
 * already consumes the top safe-area inset, so the list only needs breathing
 * room here.
 */

function deriveEmptyState(props: {
  readonly catalogState: WorkspaceState;
  readonly projectCount: number;
}): { readonly title: string; readonly detail: string; readonly loading: boolean } {
  const { catalogState } = props;
  if (catalogState.isLoadingConnections) {
    return {
      title: "Loading environments",
      detail: "Checking saved environments on this device.",
      loading: true,
    };
  }

  if (!catalogState.hasConnections) {
    return {
      title: "No environments connected",
      detail: "Add an environment to load projects and start coding sessions.",
      loading: false,
    };
  }

  if (
    (catalogState.connectionState === "available" ||
      catalogState.connectionState === "offline" ||
      catalogState.connectionState === "error") &&
    !catalogState.hasLoadedShellSnapshot
  ) {
    return {
      title: "Environment unavailable",
      detail:
        catalogState.connectionError ??
        "The saved environment is offline. Check the URL or start the environment, then retry.",
      loading: false,
    };
  }

  if (
    catalogState.hasConnectingEnvironment &&
    !catalogState.hasLoadedShellSnapshot &&
    catalogState.connectionError === null
  ) {
    return {
      title: "Connecting to environment",
      detail: "Loading projects and threads from the saved environment.",
      loading: true,
    };
  }

  if (props.projectCount === 0 && catalogState.hasLoadedShellSnapshot) {
    return {
      title: "No projects found",
      detail: "The connected environment did not report any projects.",
      loading: false,
    };
  }

  return {
    title: "No threads yet",
    detail: "Create a task to start a new coding session in one of your connected projects.",
    loading: false,
  };
}

function HomeTopContentSpacer() {
  return <View className="h-4" />;
}

/* ─── Main screen ────────────────────────────────────────────────────── */

export function HomeScreen(props: HomeScreenProps) {
  const [groupDisplayStates, setGroupDisplayStates] = useState<
    ReadonlyMap<string, HomeGroupDisplayState>
  >(() => new Map());
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  // Grouping changes V2 ordering only; the cards, pin block, and shelves are
  // shared across project and recency modes.
  // v2 is the default list since #5672; the legacy grouped list is the opt-in.
  // The preference itself is upstream's hook — only the list-mode gate is ours.
  const threadListV2Preferred = useThreadListV2Enabled();
  const threadListV2Enabled = props.listMode === "threads" && threadListV2Preferred;
  const autoSettleOnMerge =
    !AsyncResult.isSuccess(preferencesResult) ||
    preferencesResult.value.autoSettleOnMerge !== false;
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const openSwipeableRef = useRef<SwipeableMethods | null>(null);
  const listRef = useRef<LegendListRef | null>(null);
  const insets = useSafeAreaInsets();
  const iosBottomToolbarClearance =
    Platform.OS === "ios" && !NATIVE_LIQUID_GLASS_SUPPORTED
      ? PRE_LIQUID_GLASS_BOTTOM_TOOLBAR_HEIGHT
      : 0;
  const searchEnvironmentIds = useMemo(() => {
    const connectedIds = props.environments
      .filter((environment) => environment.connectionState === "connected")
      .map((environment) => environment.environmentId);
    if (props.selectedEnvironmentIds.length === 0) {
      return connectedIds;
    }
    const selected = new Set(props.selectedEnvironmentIds);
    return connectedIds.filter((environmentId) => selected.has(environmentId));
  }, [props.environments, props.selectedEnvironmentIds]);
  const threadSearch = useThreadSearch(searchEnvironmentIds, props.searchQuery);
  const threadSearchMatchByKey = useMemo(() => {
    const matches = new Map<string, EnvironmentThreadSearchMatch>();
    for (const match of threadSearch.matches) {
      if (match.source === "user" || match.source === "assistant") {
        matches.set(threadSearchMatchKey(match), match);
      }
    }
    return matches;
  }, [threadSearch.matches]);
  const matchedThreadKeys = useMemo(
    () => new Set(threadSearch.matches.map(threadSearchMatchKey)),
    [threadSearch.matches],
  );
  const effectiveGroupDisplayStates = useMemo(() => {
    const next = new Map(groupDisplayStates);
    if (!AsyncResult.isSuccess(preferencesResult)) {
      return next;
    }
    for (const key of preferencesResult.value.collapsedProjectGroups ?? []) {
      const existing = next.get(key);
      next.set(key, {
        ...(existing ?? DEFAULT_GROUP_DISPLAY_STATE),
        collapsed: true,
      });
    }
    return next;
  }, [groupDisplayStates, preferencesResult]);
  const effectiveGroupDisplayStatesRef = useRef(effectiveGroupDisplayStates);
  effectiveGroupDisplayStatesRef.current = effectiveGroupDisplayStates;

  const updateGroupDisplay = useCallback(
    (key: string, action: HomeGroupDisplayAction) => {
      const next = new Map(effectiveGroupDisplayStatesRef.current);
      next.set(key, nextGroupDisplayState(next.get(key) ?? DEFAULT_GROUP_DISPLAY_STATE, action));
      effectiveGroupDisplayStatesRef.current = next;
      setGroupDisplayStates(next);
      if (action === "toggle-collapsed") {
        const collapsedProjectGroups: string[] = [];
        for (const [groupKey, state] of next) {
          if (state.collapsed) {
            collapsedProjectGroups.push(groupKey);
          }
        }
        savePreferences({ collapsedProjectGroups });
      }
    },
    [savePreferences],
  );

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

  const handleScrollBeginDrag = useCallback(() => {
    openSwipeableRef.current?.close();
  }, []);
  const { swipeEnabled, scrollGateHandlers } = useSwipeableScrollGate({
    onScrollBeginDrag: handleScrollBeginDrag,
  });

  const projectScopes = useMemo(
    () =>
      buildHomeProjectScopes({
        projects: props.projects,
        selectedEnvironmentIds: props.selectedEnvironmentIds,
        projectGroupingMode: props.projectGroupingMode,
      }),
    [props.projectGroupingMode, props.projects, props.selectedEnvironmentIds],
  );
  const selectedProjectScope = useMemo(
    () =>
      props.selectedProjectKey === null
        ? null
        : (projectScopes.find(
            (scope) =>
              scope.key === props.selectedProjectKey ||
              scope.projectRefs.some(
                (projectRef) =>
                  scopedProjectKey(projectRef.environmentId, projectRef.projectId) ===
                  props.selectedProjectKey,
              ),
          ) ?? null),
    [projectScopes, props.selectedProjectKey],
  );
  const selectedProjectRefKeys = useMemo(
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
      selectedProjectRefKeys === null
        ? props.projects
        : props.projects.filter((project) =>
            selectedProjectRefKeys.has(scopedProjectKey(project.environmentId, project.id)),
          ),
    [props.projects, selectedProjectRefKeys],
  );
  const scopedThreads = useMemo(
    () =>
      selectedProjectRefKeys === null
        ? props.threads
        : props.threads.filter((thread) =>
            selectedProjectRefKeys.has(scopedProjectKey(thread.environmentId, thread.projectId)),
          ),
    [props.threads, selectedProjectRefKeys],
  );
  const scopedPendingTasks = useMemo(
    () =>
      selectedProjectRefKeys === null
        ? props.pendingTasks
        : props.pendingTasks.filter((pendingTask) =>
            selectedProjectRefKeys.has(
              scopedProjectKey(pendingTask.message.environmentId, pendingTask.creation.projectId),
            ),
          ),
    [props.pendingTasks, selectedProjectRefKeys],
  );

  const showFlatThreadList =
    props.listMode === "threads" && usesFlatThreadGrouping(props.threadGrouping);
  const showProjectThreadList =
    props.listMode === "threads" && usesProjectThreadGrouping(props.threadGrouping);

  const recentEntries = useMemo(
    () =>
      showFlatThreadList
        ? buildHomeRecentListEntries({
            projects: scopedProjects,
            threads: scopedThreads,
            selectedEnvironmentIds: props.selectedEnvironmentIds,
            projectRefKeys: selectedProjectRefKeys,
            searchQuery: props.searchQuery,
          })
        : [],
    [
      props.searchQuery,
      props.selectedEnvironmentIds,
      scopedProjects,
      scopedThreads,
      selectedProjectRefKeys,
      showFlatThreadList,
    ],
  );
  const recentPendingEntries = useMemo(
    () =>
      showFlatThreadList
        ? buildHomeRecentPendingEntries({
            pendingTasks: scopedPendingTasks,
            selectedEnvironmentIds: props.selectedEnvironmentIds,
            projectRefKeys: selectedProjectRefKeys,
            searchQuery: props.searchQuery,
          })
        : [],
    [
      props.searchQuery,
      props.selectedEnvironmentIds,
      scopedPendingTasks,
      selectedProjectRefKeys,
      showFlatThreadList,
    ],
  );

  const hasSearchQuery = props.searchQuery.trim().length > 0;

  const projectCwdByKey = useMemo(() => {
    const map = new Map<string, string>();
    for (const project of props.projects) {
      map.set(scopedProjectKey(project.environmentId, project.id), project.workspaceRoot);
    }
    return map;
  }, [props.projects]);

  const projectByKey = useMemo(() => {
    const map = new Map<string, EnvironmentProject>();
    for (const project of props.projects) {
      map.set(scopedProjectKey(project.environmentId, project.id), project);
    }
    return map;
  }, [props.projects]);

  const v2ProjectScopeKey = props.selectedProjectKey;
  const v2ScopeProjects = useMemo(
    () =>
      sortHomeProjectScopes({
        scopes: projectScopes,
        threads: props.threads,
        pendingTasks: props.pendingTasks,
        projectSortOrder: props.projectSortOrder,
      }),
    [
      props.pendingTasks,
      props.projects,
      props.projectSortOrder,
      props.selectedEnvironmentIds,
      props.threads,
      projectScopes,
    ],
  );
  const v2ScopedProjectGroup = useMemo(
    () =>
      v2ProjectScopeKey === null
        ? null
        : (v2ScopeProjects.find(
            (scope) =>
              scope.key === v2ProjectScopeKey ||
              scope.projectRefs.some(
                (projectRef) =>
                  scopedProjectKey(projectRef.environmentId, projectRef.projectId) ===
                  v2ProjectScopeKey,
              ),
          ) ?? null),
    [v2ProjectScopeKey, v2ScopeProjects],
  );
  const v2ProjectTitleByProjectKey = useMemo(
    () =>
      new Map(
        v2ScopeProjects.flatMap((scope) =>
          scope.projectRefs.map(
            (projectRef) =>
              [
                scopedProjectKey(projectRef.environmentId, projectRef.projectId),
                scope.title,
              ] as const,
          ),
        ),
      ),
    [v2ScopeProjects],
  );
  const v2ScopedProjectKeys = useMemo(
    () =>
      v2ScopedProjectGroup === null
        ? null
        : new Set(
            v2ScopedProjectGroup.projectRefs.map((projectRef) =>
              scopedProjectKey(projectRef.environmentId, projectRef.projectId),
            ),
          ),
    [v2ScopedProjectGroup],
  );
  // Thread List v2 (beta): one flat list in creation order, no grouping.
  // Settled threads collapse into a recency tail below the card block.
  // Settled threads stay in the live shell stream (settled ≠ archived), so
  // the partition works directly off live shells — no snapshot merging or
  // optimistic holds.
  // PR states stream in per-row. The next partition applies the configured
  // merge rule and the always-on close rule, matching web.
  const [changeRequestByKey, setChangeRequestByKey] = useState<
    ReadonlyMap<string, ThreadListV2ChangeRequestState>
  >(() => new Map());
  const handleChangeRequestState = useCallback(
    (threadKey: string, changeRequest: ThreadListV2ChangeRequestState | null) => {
      setChangeRequestByKey((current) => {
        const existing = current.get(threadKey) ?? null;
        if (
          (existing?.state ?? null) === (changeRequest?.state ?? null) &&
          (existing?.updatedAt ?? null) === (changeRequest?.updatedAt ?? null) &&
          (existing?.linkedPullRequestKey ?? null) === (changeRequest?.linkedPullRequestKey ?? null)
        ) {
          return current;
        }
        const next = new Map(current);
        if (changeRequest === null) {
          next.delete(threadKey);
        } else {
          next.set(threadKey, changeRequest);
        }
        return next;
      });
    },
    [],
  );
  const handleSettleThread = useCallback(
    (thread: EnvironmentThreadShell) => {
      void props.onSettleThread(thread);
    },
    [props.onSettleThread],
  );
  const handleSnoozeThread = useCallback(
    (thread: EnvironmentThreadShell, snoozedUntil: string) => {
      void props.onSnoozeThread(thread, snoozedUntil);
    },
    [props.onSnoozeThread],
  );
  const handleUnsnoozeThread = useCallback(
    (thread: EnvironmentThreadShell) => {
      void props.onUnsnoozeThread(thread);
    },
    [props.onUnsnoozeThread],
  );
  const handlePinThread = useCallback(
    (thread: EnvironmentThreadShell) => {
      void props.onPinThread(thread);
    },
    [props.onPinThread],
  );
  const handleMovePinnedThread = useCallback(
    (thread: EnvironmentThreadShell, direction: "up" | "down") => {
      void props.onMovePinnedThread(thread, direction);
    },
    [props.onMovePinnedThread],
  );
  const handleUnpinThread = useCallback(
    (thread: EnvironmentThreadShell) => {
      void props.onUnpinThread(thread);
    },
    [props.onUnpinThread],
  );
  const handleRegenerateThreadTitle = useCallback(
    (thread: EnvironmentThreadShell) => {
      void props.onRegenerateThreadTitle(thread);
    },
    [props.onRegenerateThreadTitle],
  );
  const handleDeleteThread = props.onDeleteThread;
  const handleUnsettleThread = props.onUnsettleThread;
  // Settled shelf/tail paging (v2 always; classic recency/none when hide
  // settled shelves history). Expansion resets when filter context changes.
  const [settledVisibleCount, setSettledVisibleCount] = useState(
    THREAD_LIST_V2_SETTLED_INITIAL_COUNT,
  );
  const settledResetKey = `${props.selectedEnvironmentIds.join(",") || "all"}:${v2ProjectScopeKey ?? "all"}:${props.searchQuery.trim()}`;
  const lastSettledResetKeyRef = useRef(settledResetKey);
  if (lastSettledResetKeyRef.current !== settledResetKey) {
    lastSettledResetKeyRef.current = settledResetKey;
    setSettledVisibleCount(THREAD_LIST_V2_SETTLED_INITIAL_COUNT);
  }
  const showMoreSettled = useCallback(
    () => setSettledVisibleCount((count) => count + THREAD_LIST_V2_SETTLED_PAGE_COUNT),
    [],
  );
  const {
    loaded: shelfPreferencesLoaded,
    settledShelfExpanded,
    snoozedShelfExpanded,
    toggleSettledShelf,
    toggleSnoozedShelf,
  } = useThreadListV2ShelfPreferences();
  // now is quantized to the minute and ticks so the inactivity auto-settle
  // boundary is actually crossed while the app stays open (mirrors web);
  // without a clock dependency the partition memoizes a frozen "now".
  const [nowMinute, setNowMinute] = useState(() => new Date().toISOString().slice(0, 16));
  // Snooze wake times are second-precise; a counter bumped exactly at the
  // next wake boundary re-runs the partition with a fresh clock so a woken
  // thread reappears immediately instead of on the next minute tick.
  const [snoozeWakeTick, bumpSnoozeWakeTick] = useState(0);
  const needsSettlementClock = threadListV2Enabled || props.listMode === "threads";
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
  const pinningEnvironmentIds = useMemo(() => {
    const supported = new Set<EnvironmentId>();
    for (const [environmentId, config] of serverConfigs) {
      if (config.environment.capabilities.threadPinning === true) {
        supported.add(environmentId);
      }
    }
    return supported;
  }, [serverConfigs]);

  // Settled classification for menu state + hide filter. Keys are env:threadId.
  const settledThreadKeys = useMemo(() => {
    if (props.listMode === "board") {
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
          changeRequest: null,
        })
      ) {
        keys.add(scopedThreadKey(thread.environmentId, thread.id));
      }
    }
    return keys;
  }, [nowMinute, props.listMode, scopedThreads, settlementEnvironmentIds]);

  const threadsForProjectList = useMemo(() => {
    if (!props.hideSettledThreads) return scopedThreads;
    return scopedThreads.filter(
      (thread) => !settledThreadKeys.has(scopedThreadKey(thread.environmentId, thread.id)),
    );
  }, [props.hideSettledThreads, scopedThreads, settledThreadKeys]);

  const projectGroups = useMemo(
    () =>
      showProjectThreadList && !threadListV2Enabled
        ? buildHomeThreadGroups({
            projects: scopedProjects,
            threads: threadsForProjectList,
            pendingTasks: scopedPendingTasks,
            selectedEnvironmentIds: props.selectedEnvironmentIds,
            searchQuery: props.searchQuery,
            matchedThreadKeys,
            projectSortOrder: props.projectSortOrder,
            threadSortOrder: props.threadSortOrder,
            projectGroupingMode: props.projectGroupingMode,
          })
        : [],
    [
      matchedThreadKeys,
      props.projectGroupingMode,
      props.projectSortOrder,
      props.searchQuery,
      props.selectedEnvironmentIds,
      props.threadSortOrder,
      scopedPendingTasks,
      scopedProjects,
      showProjectThreadList,
      threadListV2Enabled,
      threadsForProjectList,
    ],
  );

  // Classic flat/recency: when hide-settled, active inbox + settled shelf
  // (web classic Recent). When hide is off, settled stay mixed into activity
  // order like a normal flat list.
  const { visibleRecentEntries, classicSettledEntries } = useMemo(() => {
    if (!showFlatThreadList) {
      return {
        visibleRecentEntries: [] as ReadonlyArray<{
          thread: (typeof recentEntries)[number]["thread"];
          projectTitle: string;
        }>,
        classicSettledEntries: [] as ReadonlyArray<{
          thread: (typeof recentEntries)[number]["thread"];
          projectTitle: string;
        }>,
      };
    }
    if (!props.hideSettledThreads) {
      return {
        visibleRecentEntries: recentEntries.map((entry) => ({
          thread: entry.thread,
          projectTitle: entry.project.title,
        })),
        classicSettledEntries: [] as ReadonlyArray<{
          thread: (typeof recentEntries)[number]["thread"];
          projectTitle: string;
        }>,
      };
    }
    const active: Array<{
      thread: (typeof recentEntries)[number]["thread"];
      projectTitle: string;
    }> = [];
    const settled: Array<{
      thread: (typeof recentEntries)[number]["thread"];
      projectTitle: string;
    }> = [];
    for (const entry of recentEntries) {
      const key = scopedThreadKey(entry.thread.environmentId, entry.thread.id);
      const row = { thread: entry.thread, projectTitle: entry.project.title };
      if (settledThreadKeys.has(key)) settled.push(row);
      else active.push(row);
    }
    // History order: most recently settled/ended first (matches v2 tail).
    settled.sort((left, right) => {
      const leftMs = Date.parse(
        left.thread.settledAt ?? left.thread.latestUserMessageAt ?? left.thread.updatedAt ?? "",
      );
      const rightMs = Date.parse(
        right.thread.settledAt ?? right.thread.latestUserMessageAt ?? right.thread.updatedAt ?? "",
      );
      const safeLeft = Number.isNaN(leftMs) ? 0 : leftMs;
      const safeRight = Number.isNaN(rightMs) ? 0 : rightMs;
      return safeRight - safeLeft || left.thread.id.localeCompare(right.thread.id);
    });
    return { visibleRecentEntries: active, classicSettledEntries: settled };
  }, [props.hideSettledThreads, recentEntries, settledThreadKeys, showFlatThreadList]);

  const classicSettledHiddenCount = Math.max(0, classicSettledEntries.length - settledVisibleCount);
  const pagedClassicSettledEntries = useMemo(
    () => classicSettledEntries.slice(0, settledVisibleCount),
    [classicSettledEntries, settledVisibleCount],
  );

  const listLayout = useMemo(() => {
    if (showFlatThreadList) {
      const activeLayout = buildHomeRecentListLayout({
        pendingTasks: recentPendingEntries.map((entry) => entry.pendingTask),
        entries: visibleRecentEntries,
        groupByRecency: props.threadGrouping === "recency",
      });
      if (pagedClassicSettledEntries.length === 0) {
        return activeLayout;
      }
      // Append Settled shelf under the active inbox (web classic Recent).
      const items: HomeListItem[] = activeLayout.items.map((item, index) => {
        if (index !== activeLayout.items.length - 1) return item;
        if (item.type === "thread") return { ...item, isLast: false };
        if (item.type === "pending-task") return { ...item, isLast: false };
        return item;
      });
      const stickyHeaderIndices = [...activeLayout.stickyHeaderIndices];
      stickyHeaderIndices.push(items.length);
      items.push({
        type: "section-header",
        key: "section:settled-shelf",
        title: "Settled",
        isFirst: items.length === 0,
      });
      for (const [index, entry] of pagedClassicSettledEntries.entries()) {
        items.push({
          type: "thread",
          key: `thread:${entry.thread.environmentId}:${entry.thread.id}`,
          thread: entry.thread,
          projectTitle: entry.projectTitle,
          isLast:
            index === pagedClassicSettledEntries.length - 1 && classicSettledHiddenCount === 0,
        });
      }
      return { items, stickyHeaderIndices };
    }
    if (!showProjectThreadList) {
      return { items: [] as HomeListItem[], stickyHeaderIndices: [] as number[] };
    }
    return buildHomeListLayout({
      groups: projectGroups,
      displayStates: effectiveGroupDisplayStates,
      showAllThreads: hasSearchQuery,
    });
  }, [
    classicSettledHiddenCount,
    effectiveGroupDisplayStates,
    hasSearchQuery,
    pagedClassicSettledEntries,
    projectGroups,
    props.threadGrouping,
    recentPendingEntries,
    showFlatThreadList,
    showProjectThreadList,
    visibleRecentEntries,
  ]);
  const pinReorderEnvironmentIds = useMemo(() => {
    const supported = new Set<EnvironmentId>();
    for (const [environmentId, config] of serverConfigs) {
      if (config.environment.capabilities.threadPinReorder === true) {
        supported.add(environmentId);
      }
    }
    return supported;
  }, [serverConfigs]);
  const titleRegenerationEnvironmentIds = useMemo(() => {
    const supported = new Set<EnvironmentId>();
    for (const [environmentId, config] of serverConfigs) {
      if (config.environment.capabilities.threadTitleRegeneration === true) {
        supported.add(environmentId);
      }
    }
    return supported;
  }, [serverConfigs]);
  // Canonical arranged pinned order (reorder-capable threads only) for the
  // Move up/down position flags. Computed from all shells, not the rendered
  // list, so search/scope filtering never disables or misdirects a move.
  const arrangedPinnedKeys = useMemo(() => {
    const pinned = sortPinnedThreadsByOrderKey(
      props.threads.filter(
        (thread) =>
          thread.pinnedAt != null &&
          thread.archivedAt === null &&
          pinReorderEnvironmentIds.has(thread.environmentId),
      ),
    );
    return pinned.map((thread) => `${thread.environmentId}:${thread.id}`);
  }, [pinReorderEnvironmentIds, props.threads]);
  const threadListV2Layout = useMemo(() => {
    if (!threadListV2Enabled)
      return {
        items: [],
        hiddenSettledCount: 0,
        snoozedCount: 0,
        snoozedShelfHeaderIndex: null,
        settledCount: 0,
        settledShelfHeaderIndex: null,
        nextSnoozeWakeAt: null,
      };
    // Settled always partition into the slim tail (web Sidebar V2 / classic
    // Recent shelf). Hide-settled must not drop that history on mobile.
    return buildThreadListV2Items({
      threads: props.threads.filter((thread) => thread.archivedAt === null),
      selectedEnvironmentIds: props.selectedEnvironmentIds,
      projectRefs: v2ScopedProjectGroup === null ? null : v2ScopedProjectGroup.projectRefs,
      orderByRecency: props.threadGrouping === "recency",
      searchQuery: props.searchQuery,
      matchedThreadKeys,
      changeRequestByKey,
      autoSettleOnMerge,
      settlementEnvironmentIds,
      snoozeEnvironmentIds,
      settledLimit: settledVisibleCount,
      now: `${nowMinute}:00.000Z`,
      snoozeNow: new Date().toISOString(),
      snoozedShelfExpanded,
      settledShelfExpanded,
      selectedThreadKey: null,
    });
  }, [
    changeRequestByKey,
    autoSettleOnMerge,
    nowMinute,
    snoozeWakeTick,
    settledVisibleCount,
    settlementEnvironmentIds,
    snoozeEnvironmentIds,
    snoozedShelfExpanded,
    settledShelfExpanded,
    matchedThreadKeys,
    props.searchQuery,
    props.threadGrouping,
    props.selectedEnvironmentIds,
    props.threads,
    threadListV2Enabled,
    v2ScopedProjectGroup,
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
  const v2SearchQuery = props.searchQuery.trim().toLocaleLowerCase();
  const v2PendingTasks = useMemo(
    () =>
      props.pendingTasks.filter(
        (pendingTask) =>
          (props.selectedEnvironmentIds.length === 0 ||
            props.selectedEnvironmentIds.includes(pendingTask.message.environmentId)) &&
          (v2ScopedProjectKeys === null ||
            v2ScopedProjectKeys.has(
              scopedProjectKey(pendingTask.message.environmentId, pendingTask.creation.projectId),
            )) &&
          (v2SearchQuery.length === 0 ||
            pendingTask.title.toLocaleLowerCase().includes(v2SearchQuery)),
      ),
    [props.pendingTasks, props.selectedEnvironmentIds, v2ScopedProjectKeys, v2SearchQuery],
  );
  const threadListV2Items = useMemo(
    () =>
      buildThreadListV2ListItems({
        items: threadListV2Layout.items,
        pendingTasks: v2PendingTasks,
        snoozedCount: threadListV2Layout.snoozedCount,
        snoozedShelfExpanded,
        snoozedShelfHeaderIndex: threadListV2Layout.snoozedShelfHeaderIndex,
        settledCount: threadListV2Layout.settledCount,
        settledShelfExpanded,
        settledShelfHeaderIndex: threadListV2Layout.settledShelfHeaderIndex,
        snoozeLabelNow: `${nowMinute}:00.000Z`,
        groupByRecency: props.threadGrouping === "recency",
      }),
    [
      nowMinute,
      props.threadGrouping,
      settledShelfExpanded,
      snoozedShelfExpanded,
      threadListV2Layout,
      v2PendingTasks,
    ],
  );

  const renderV2Item = useCallback(
    ({ item, index }: { readonly item: ThreadListV2ListItem; readonly index: number }) => {
      const nextItem = threadListV2Items[index + 1];
      const showTrailingDivider =
        nextItem?.type === "v2-thread" ||
        (nextItem?.type === "v2-pending" && !nextItem.showPendingDivider);
      if (item.type === "v2-pending") {
        const pendingScopeKey = scopedProjectKey(
          item.pendingTask.message.environmentId,
          item.pendingTask.creation.projectId,
        );
        return (
          <ThreadListV2PendingRow
            pendingTask={item.pendingTask}
            project={projectByKey.get(pendingScopeKey) ?? null}
            projectTitle={v2ProjectTitleByProjectKey.get(pendingScopeKey)}
            environmentLabel={
              Object.keys(props.savedConnectionsById).length > 1
                ? (props.savedConnectionsById[item.pendingTask.message.environmentId]
                    ?.environmentLabel ?? null)
                : null
            }
            showPendingDivider={item.showPendingDivider}
            showTrailingDivider={showTrailingDivider}
            onSelectPendingTask={props.onSelectPendingTask}
            onDeletePendingTask={props.onDeletePendingTask}
          />
        );
      }
      if (item.type === "v2-snoozed-shelf") {
        return (
          <ThreadListV2SnoozedShelfHeader
            count={item.count}
            disabled={!shelfPreferencesLoaded}
            expanded={item.expanded}
            onToggle={toggleSnoozedShelf}
          />
        );
      }
      if (item.type === "v2-settled-shelf") {
        return (
          <ThreadListV2SettledShelfHeader
            count={item.count}
            disabled={!shelfPreferencesLoaded}
            expanded={item.expanded}
            onToggle={toggleSettledShelf}
          />
        );
      }
      if (item.type === "v2-recency-header") {
        return (
          <View className="bg-screen px-5 pb-1 pt-3">
            <Text className="text-xs font-t3-medium text-foreground-muted">{item.label}</Text>
          </View>
        );
      }
      const thread = item.item.thread;
      return (
        <ThreadListV2Row
          thread={thread}
          variant={item.item.variant}
          snoozed={item.item.snoozed}
          pinned={item.item.pinned}
          snoozePresetMinute={nowMinute}
          snoozeWakeLabelText={item.snoozeWakeLabelText}
          showTrailingDivider={showTrailingDivider}
          project={
            projectByKey.get(scopedProjectKey(thread.environmentId, thread.projectId)) ?? null
          }
          projectTitle={v2ProjectTitleByProjectKey.get(
            scopedProjectKey(thread.environmentId, thread.projectId),
          )}
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
            Object.keys(props.savedConnectionsById).length > 1
              ? (props.savedConnectionsById[thread.environmentId]?.environmentLabel ?? null)
              : null
          }
          searchMatch={threadSearchMatchByKey.get(
            threadSearchMatchKey({
              environmentId: thread.environmentId,
              threadId: thread.id,
            }),
          )}
          searchQuery={props.searchQuery}
          onSelectThread={props.onSelectThread}
          onDeleteThread={handleDeleteThread}
          onArchiveThread={props.onArchiveThread}
          onRegenerateThreadTitle={handleRegenerateThreadTitle}
          titleRegenerationSupported={titleRegenerationEnvironmentIds.has(thread.environmentId)}
          settlementSupported={settlementEnvironmentIds.has(thread.environmentId)}
          onSettleThread={handleSettleThread}
          snoozeSupported={snoozeEnvironmentIds.has(thread.environmentId)}
          pinningSupported={pinningEnvironmentIds.has(thread.environmentId)}
          pinReorderSupported={pinReorderEnvironmentIds.has(thread.environmentId)}
          canMovePinnedUp={arrangedPinnedKeys.indexOf(`${thread.environmentId}:${thread.id}`) > 0}
          canMovePinnedDown={(() => {
            const index = arrangedPinnedKeys.indexOf(`${thread.environmentId}:${thread.id}`);
            return index !== -1 && index < arrangedPinnedKeys.length - 1;
          })()}
          onSnoozeThread={handleSnoozeThread}
          onUnsnoozeThread={handleUnsnoozeThread}
          onUnsettleThread={handleUnsettleThread}
          onPinThread={handlePinThread}
          onUnpinThread={handleUnpinThread}
          onMovePinnedThread={handleMovePinnedThread}
          onChangeRequestState={handleChangeRequestState}
          projectCwd={
            projectCwdByKey.get(scopedProjectKey(thread.environmentId, thread.projectId)) ?? null
          }
          onSwipeableClose={handleSwipeableClose}
          onSwipeableWillOpen={handleSwipeableWillOpen}
        />
      );
    },
    [
      handleChangeRequestState,
      handleDeleteThread,
      arrangedPinnedKeys,
      handleMovePinnedThread,
      handlePinThread,
      handleRegenerateThreadTitle,
      nowMinute,
      handleSettleThread,
      handleSnoozeThread,
      handleUnpinThread,
      handleUnsnoozeThread,
      handleSwipeableClose,
      handleSwipeableWillOpen,
      handleUnsettleThread,
      pinningEnvironmentIds,
      pinReorderEnvironmentIds,
      snoozeEnvironmentIds,
      projectByKey,
      projectCwdByKey,
      props.onArchiveThread,
      props.onSelectThread,
      props.savedConnectionsById,
      props.searchQuery,
      serverConfigs,
      shelfPreferencesLoaded,
      settlementEnvironmentIds,
      threadListV2Items,
      threadSearchMatchByKey,
      titleRegenerationEnvironmentIds,
      toggleSettledShelf,
      toggleSnoozedShelf,
      v2ProjectTitleByProjectKey,
    ],
  );
  const v2KeyExtractor = useCallback((item: ThreadListV2ListItem) => item.key, []);

  const extraData = useMemo(
    () => ({
      projectCwdByKey,
      savedConnectionsById: props.savedConnectionsById,
      searchQuery: props.searchQuery,
      threadSearchMatchByKey,
    }),
    [projectCwdByKey, props.savedConnectionsById, props.searchQuery, threadSearchMatchByKey],
  );

  const renderItem = useCallback(
    ({ item }: LegendListRenderItemProps<HomeListItem>) => {
      switch (item.type) {
        case "header":
          return (
            <ThreadListGroupHeader
              variant="compact"
              collapsed={item.collapsed}
              isFirst={item.isFirst}
              groupKey={item.group.key}
              onGroupAction={updateGroupDisplay}
              // Aggregated groups (same repo across machines) have no single
              // target project, and `pending-project:` groups hold a placeholder
              // built from queued-task metadata rather than a real project shell,
              // so the quick new-thread button is single-real-project only.
              newThreadTarget={item.group.newThreadTarget}
              onNewThread={props.onNewThreadInProject}
              project={item.group.representative}
              threadCount={item.group.threads.length + item.group.pendingTasks.length}
              title={item.group.title}
            />
          );
        case "section-header":
          return <ThreadListSectionHeader variant="compact" title={item.title} />;
        case "pending-task":
          return (
            <PendingTaskListRow
              variant="compact"
              pendingTask={item.pendingTask}
              environmentLabel={
                props.savedConnectionsById[item.pendingTask.message.environmentId]
                  ?.environmentLabel ?? null
              }
              isLast={item.isLast}
              onSelectPendingTask={props.onSelectPendingTask}
              onDeletePendingTask={props.onDeletePendingTask}
            />
          );
        case "thread": {
          const thread = item.thread;
          const threadKey = scopedThreadKey(thread.environmentId, thread.id);
          return (
            <ThreadListRow
              variant="compact"
              thread={thread}
              projectTitle={item.projectTitle}
              environmentLabel={
                // Prefer showing server when multi-env OR recency/flat grouping
                // so threads from different hosts aren't ambiguous.
                Object.keys(props.savedConnectionsById).length > 1 ||
                usesFlatThreadGrouping(props.threadGrouping)
                  ? (props.savedConnectionsById[thread.environmentId]?.environmentLabel ?? null)
                  : null
              }
              projectCwd={
                projectCwdByKey.get(scopedProjectKey(thread.environmentId, thread.projectId)) ??
                null
              }
              isLast={item.isLast}
              searchMatch={threadSearchMatchByKey.get(
                threadSearchMatchKey({
                  environmentId: thread.environmentId,
                  threadId: thread.id,
                }),
              )}
              searchQuery={props.searchQuery}
              settlementSupported={settlementEnvironmentIds.has(thread.environmentId)}
              isSettled={settledThreadKeys.has(threadKey)}
              onSettleThread={handleSettleThread}
              onUnsettleThread={handleUnsettleThread}
              onArchiveThread={props.onArchiveThread}
              onDeleteThread={props.onDeleteThread}
              onRegenerateThreadTitle={handleRegenerateThreadTitle}
              titleRegenerationSupported={titleRegenerationEnvironmentIds.has(thread.environmentId)}
              onSelectThread={props.onSelectThread}
              onSwipeableClose={handleSwipeableClose}
              onSwipeableWillOpen={handleSwipeableWillOpen}
            />
          );
        }
        case "show-more":
          return (
            <ThreadListShowMoreRow
              variant="compact"
              hiddenCount={item.hiddenCount}
              canShowLess={item.canShowLess}
              groupKey={item.groupKey}
              onGroupAction={updateGroupDisplay}
            />
          );
        default: {
          // Exhaustiveness guard: unknown item types must not throw on open.
          const _exhaustive: never = item;
          void _exhaustive;
          return null;
        }
      }
    },
    [
      handleSettleThread,
      handleSwipeableClose,
      handleSwipeableWillOpen,
      handleUnsettleThread,
      handleRegenerateThreadTitle,
      projectCwdByKey,
      props.onArchiveThread,
      props.onDeletePendingTask,
      props.onDeleteThread,
      props.onNewThreadInProject,
      props.onSelectPendingTask,
      props.onSelectThread,
      props.savedConnectionsById,
      props.searchQuery,
      props.threadGrouping,
      settledThreadKeys,
      settlementEnvironmentIds,
      threadSearchMatchByKey,
      titleRegenerationEnvironmentIds,
      updateGroupDisplay,
    ],
  );

  const keyExtractor = useCallback((item: HomeListItem) => item.key, []);

  /* Empty states */
  // The signal must ignore the search/environment filters: an active query
  // that matches nothing needs the in-list "No results" state, not the
  // full-page "No threads yet". Settled threads are unarchived live shells,
  // so the v1 check already covers v2.
  const hasAnyThreads =
    props.threads.some((thread) => thread.archivedAt === null) || props.pendingTasks.length > 0;
  const hasResults = showFlatThreadList
    ? visibleRecentEntries.length > 0 || recentPendingEntries.length > 0
    : projectGroups.length > 0;
  const selectedEnvironmentLabel =
    props.selectedEnvironmentIds.length === 0
      ? null
      : props.selectedEnvironmentIds.length === 1
        ? (props.savedConnectionsById[props.selectedEnvironmentIds[0]!]?.environmentLabel ??
          "this environment")
        : `${props.selectedEnvironmentIds.length} environments`;
  const environmentLabelById = useMemo(() => {
    const map = new Map<string, string>();
    for (const connection of Object.values(props.savedConnectionsById)) {
      map.set(connection.environmentId, connection.environmentLabel);
    }
    return map;
  }, [props.savedConnectionsById]);
  // Connection state surfaces in the header title slot
  // (WorkspaceConnectionTitle) — nothing renders inside the list, so
  // reconnects never shift the rows.
  const emptyState = deriveEmptyState({
    catalogState: props.catalogState,
    projectCount: props.projects.length,
  });

  // Board owns its empty chrome; connection-level empty still applies below
  // for Recent/Projects when the workspace has no threads at all.
  if (!hasAnyThreads && props.listMode !== "board") {
    return (
      <View
        className="flex-1 items-center justify-center bg-screen px-8"
        style={{
          paddingBottom: Math.max(insets.bottom, 24) + iosBottomToolbarClearance,
          paddingTop: NATIVE_LIQUID_GLASS_SUPPORTED ? insets.top + 72 : 0,
        }}
      >
        <View className="w-full max-w-[430px]">
          <EmptyState
            title={emptyState.title}
            detail={emptyState.detail}
            actionLabel={!props.catalogState.hasReadyEnvironment ? "Add environment" : undefined}
            onAction={!props.catalogState.hasReadyEnvironment ? props.onAddConnection : undefined}
            variant="plain"
          />
          {emptyState.loading ? (
            <View className="mt-4 items-center">
              <ActivityIndicator colorClassName={"accent-icon-muted"} />
            </View>
          ) : null}
        </View>
      </View>
    );
  }

  const listHeader = Platform.OS === "ios" ? null : <HomeTopContentSpacer />;

  // Project scoping lives in the header filter menu (no inline chip row on
  // mobile — the menu is the one filter surface).
  const v2ListHeader = listHeader;

  const listEmpty = !hasResults ? (
    hasSearchQuery && threadSearch.isPending ? null : hasSearchQuery ? (
      <EmptyState title="No results" detail={`No threads matching "${props.searchQuery}".`} />
    ) : selectedProjectScope !== null ? (
      <EmptyState
        title={`No threads in ${selectedProjectScope.title}`}
        detail="Choose another project or create a new task."
      />
    ) : selectedEnvironmentLabel ? (
      <EmptyState
        title={`No threads in ${selectedEnvironmentLabel}`}
        detail="Choose another environment or create a new task."
      />
    ) : (
      <EmptyState title="No threads yet" detail="Create a task to start a new coding session." />
    )
  ) : null;
  // Self-contained: v1's listEmpty keys off projectGroups, which ignores the
  // v2 project scope, so it can be null (results elsewhere) while this list
  // is empty. Search outranks the scope — "No results" names the actionable
  // fact when a query is active. Snoozed threads outrank the rest: "No
  // threads yet" over an inbox that is merely all-snoozed reads as data
  // loss. Pending tasks render in the header, so the list showing them
  // isn't empty in the user's eyes.
  const v2SnoozedCount = threadListV2Layout.snoozedCount;
  const v2ListEmpty =
    v2PendingTasks.length > 0 ? null : hasSearchQuery ? (
      v2SnoozedCount > 0 ? (
        // The snoozed threads already passed this search filter: "No
        // results" would claim nothing matched when matches are merely
        // parked.
        <EmptyState
          title={
            v2SnoozedCount === 1 ? "1 matching thread snoozed" : `All matching threads snoozed`
          }
          detail={`Threads matching "${props.searchQuery}" are snoozed and return when their wake time passes.`}
        />
      ) : (
        <EmptyState title="No results" detail={`No threads matching "${props.searchQuery}".`} />
      )
    ) : v2SnoozedCount > 0 ? (
      <EmptyState
        title={v2SnoozedCount === 1 ? "1 thread snoozed" : `${v2SnoozedCount} threads snoozed`}
        detail="Snoozed threads return when their wake time passes."
      />
    ) : v2ScopedProjectGroup !== null ? (
      <EmptyState
        title={`No threads in ${v2ScopedProjectGroup.title}`}
        detail="Choose another project or create a new task."
      />
    ) : (
      listEmpty
    );

  if (props.listMode === "board") {
    // Solid nav header is forced for Board mode (HomeHeader): horizontal
    // columns are not UIKit-auto-inset scroll views, so glass underlapped cards.
    // Keep in-board env/project filter chrome — the bottom search toolbar is
    // hidden in Board mode.
    return (
      <View className="flex-1 bg-screen">
        <BoardScreen
          projects={props.projects}
          threads={props.threads}
          projectGroupingMode={props.projectGroupingMode}
          environmentLabelById={environmentLabelById}
          selectedEnvironmentIds={props.selectedEnvironmentIds}
          onClearEnvironments={props.onClearEnvironments}
          onToggleEnvironment={props.onToggleEnvironment}
          onSelectThread={props.onSelectThread}
          onArchiveThread={props.onArchiveThread}
          onDeleteThread={props.onDeleteThread}
          onSettleThread={props.onSettleThread}
          onUnsettleThread={props.onUnsettleThread}
        />
      </View>
    );
  }

  if (threadListV2Enabled) {
    return (
      <View className="flex-1 bg-screen">
        <SwipeableScrollGateProvider enabled={swipeEnabled}>
          <FlatList
            data={threadListV2Items}
            renderItem={renderV2Item}
            keyExtractor={v2KeyExtractor}
            extraData={{
              projectByKey,
              serverConfigs,
              savedConnectionsById: props.savedConnectionsById,
            }}
            ListHeaderComponent={v2ListHeader}
            ListFooterComponent={
              threadListV2Layout.hiddenSettledCount > 0 ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Show ${Math.min(threadListV2Layout.hiddenSettledCount, THREAD_LIST_V2_SETTLED_PAGE_COUNT)} more settled threads`}
                  onPress={showMoreSettled}
                  className="mx-4 mt-2 items-center rounded-lg border border-dashed border-border py-2.5"
                  style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
                >
                  <Text className="text-xs font-t3-medium text-foreground-muted">
                    Show more ({threadListV2Layout.hiddenSettledCount} settled hidden)
                  </Text>
                </Pressable>
              ) : null
            }
            ListEmptyComponent={v2ListEmpty}
            style={{ flex: 1 }}
            automaticallyAdjustsScrollIndicatorInsets={Platform.OS === "ios"}
            contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : "never"}
            showsVerticalScrollIndicator={false}
            keyboardDismissMode="on-drag"
            keyboardShouldPersistTaps="handled"
            {...scrollGateHandlers}
            scrollEventThrottle={16}
            contentContainerStyle={{
              paddingBottom:
                Platform.OS === "ios"
                  ? Math.max(insets.bottom, 24) + 96 + iosBottomToolbarClearance
                  : Math.max(insets.bottom, 16) + 88,
            }}
          />
        </SwipeableScrollGateProvider>
      </View>
    );
  }

  return (
    <View className="flex-1 bg-screen">
      {/* Sticky headers are deliberately not wired up: LegendList's JS sticky
          implementation mispositions pinned headers at mount under iOS
          automatic content insets (headers render one nav-inset too low until
          the first scroll event) and blanks non-pinned headers after
          collapse/expand data changes. The flattened layout still exposes
          `stickyHeaderIndices` if this gets revisited. */}
      <SwipeableScrollGateProvider enabled={swipeEnabled}>
        <LegendList
          ref={listRef}
          data={listLayout.items}
          renderItem={renderItem}
          keyExtractor={keyExtractor}
          // Mixed item types (headers, section-headers, threads, show-more)
          // must not share recycle pools — missing this crashes / blanks rows
          // once shells load (sidebar already passes getItemType).
          getItemType={(item) => item.type}
          itemsAreEqual={homeListItemsAreEqual}
          drawDistance={500}
          estimatedItemSize={ESTIMATED_THREAD_ROW_HEIGHT}
          extraData={extraData}
          ListHeaderComponent={listHeader}
          ListFooterComponent={
            classicSettledHiddenCount > 0 ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Show ${Math.min(classicSettledHiddenCount, THREAD_LIST_V2_SETTLED_PAGE_COUNT)} more settled threads`}
                onPress={showMoreSettled}
                className="mx-4 mt-2 items-center rounded-lg border border-dashed border-border py-2.5"
                style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
              >
                <Text className="text-xs font-t3-medium text-foreground-muted">
                  Show more ({classicSettledHiddenCount} settled hidden)
                </Text>
              </Pressable>
            ) : null
          }
          ListEmptyComponent={listEmpty}
          style={{ flex: 1 }}
          automaticallyAdjustsScrollIndicatorInsets={NATIVE_LIQUID_GLASS_SUPPORTED}
          contentInsetAdjustmentBehavior={NATIVE_LIQUID_GLASS_SUPPORTED ? "automatic" : "never"}
          showsVerticalScrollIndicator={false}
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          {...scrollGateHandlers}
          recycleItems
          scrollEventThrottle={16}
          contentContainerStyle={{
            // Android reserves room for the floating new-task FAB
            // (56 button + 16 gap + bottom inset). Pre-glass iOS shows a
            // standard 44pt bottom toolbar that overlays the list and is not
            // reflected in insets while contentInsetAdjustmentBehavior is
            // "never".
            paddingBottom:
              Platform.OS === "ios"
                ? Math.max(insets.bottom, 24) + 24 + iosBottomToolbarClearance
                : Math.max(insets.bottom, 16) + 88,
          }}
          scrollIndicatorInsets={
            Platform.OS === "ios"
              ? {
                  bottom: Math.max(insets.bottom, 16) + 24 + iosBottomToolbarClearance,
                  top: 0,
                }
              : undefined
          }
        />
      </SwipeableScrollGateProvider>
    </View>
  );
}
