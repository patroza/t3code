import { AsyncResult } from "effect/reactivity";
import { identityClaimPersonIdByEnvironmentAtom } from "../../state/identity";
import {
  resolveHideSettledOnProjects,
  resolveHideSettledOnRecent,
} from "../../persistence/mobile-preferences";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { useActiveNewTask } from "../../state/active-new-task";
import { ThreadUndoNotice } from "../home/ThreadUndoNotice";
import { useAndroidControlSizing } from "../../components/ui/useAndroidControlSizing";
import { pickableProjectGroups } from "@t3tools/client-runtime/state/project-grouping";
import {
  useAppearancePreferences,
  useAndroidFloatingTabs,
} from "../settings/appearance/AppearancePreferencesProvider";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import {
  claimPersonIdForEnvironment,
  threadMatchesMine,
} from "@t3tools/client-runtime/state/identity";
import { threadSearchMatchKey } from "@t3tools/client-runtime/state/thread-search";
import { AnimatedLegendList } from "@legendapp/list/reanimated";
import { THREAD_SIDEBAR_ROW_LAYOUT } from "./threadListAnimations";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { useRef, useState } from "react";
import { Platform, StyleSheet, View } from "react-native";
import { GestureDetector, useNativeGesture } from "react-native-gesture-handler";
import type { SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";
import { FLOATING_TABS } from "../layout/workspace/floating-workspace-tabs";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { scopedProjectKey, scopedThreadKey } from "../../lib/scopedEntities";
import { useProjects } from "../../state/entities";
import { steadyNavigationThreadShellsAtom } from "../../state/threads";
import { useThreadSearch } from "../../state/queries";
import { useThreadListV2ShelfPreferences } from "./use-thread-list-v2-shelf-preferences";
import { useThreadListNow } from "./use-thread-list-now";
import { usePendingThreadOrder } from "../../state/thread-order";
import { threadListEnvironmentsAtom } from "../../state/presentation";
import {
  useLaunchingThreads,
  usePendingNewTasks,
  type PendingNewTask,
} from "../../state/use-pending-new-tasks";
import { useQueuedThreadKeys } from "../../state/use-thread-outbox";
import { useWorkspaceState } from "../../state/workspace";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { useThreadListV2 } from "./useThreadListV2";
import { useThreadJumpShortcuts } from "../keyboard/threadKeyboardShortcuts";
import { requestThreadMessageJump } from "./threadMessageJump";
import { useThreadListSearchMatches } from "./useThreadListSearchMatches";
import {
  DEFAULT_OWNERSHIP_FILTER,
  DEFAULT_OWNERSHIP_RELATION,
  useHomeListOptions,
} from "../home/home-list-options";
import { buildHomeListFilterMenuItems } from "../home/home-list-filter-menu";
import { DEFAULT_HOME_THREAD_GROUPING } from "../home/homeListMode";
import { buildHomeProjectScopes, resolveHomeProjectFilterScope } from "../home/homeThreadList";
import { SwipeableScrollGateProvider, useSwipeableScrollGate } from "../home/thread-swipe-actions";
import { usePendingTaskListActions } from "../home/usePendingTaskListActions";
import { useThreadListActions } from "../home/useThreadListActions";
import { useFabScroll } from "../home/FabScrollContext";
import { WorkspaceListHeader } from "../layout/workspace/WorkspaceListHeader";
import { WorkspaceSidebarColumn } from "../layout/workspace/WorkspaceSidebarColumn";
import {
  ThreadListV2PendingRow,
  ThreadListV2Row,
  ThreadListV2SettledShelfHeader,
  ThreadListV2ShowMoreRow,
  ThreadListV2SnoozedShelfHeader,
  ThreadListV2WorkingShelfHeader,
} from "./thread-list-v2-items";
import { useThreadRowProviderInstanceResolver } from "./thread-provider-instance";
import type { ThreadPrPresentation } from "../../state/thread-pr-presentation";
import { ThreadPrDemandProvider } from "../../state/thread-pr-demand";
import {
  isThreadListV2ListItem,
  threadListV2ListItemsAreEqual,
  THREAD_LIST_V2_SETTLED_INITIAL_COUNT,
  THREAD_LIST_V2_SETTLED_PAGE_COUNT,
  type ThreadListV2ListItem,
} from "./threadListV2";
import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";
import { NativeScrollView } from "../../native/NativeScrollViewMarker";

type SidebarListItem =
  | ThreadListV2ListItem
  | {
      readonly type: "v2-show-more";
      readonly key: string;
      readonly hiddenCount: number;
      readonly state?: "loading" | "failed";
    };

interface ThreadNavigationSidebarProps {
  readonly width: number;
  readonly visible: boolean;
  readonly selectedThreadKey: string | null;
  readonly onOpenSettings: () => void;
  readonly onOpenEnvironmentSettings: () => void;
  readonly onNewThreadOnBranch: (thread: EnvironmentThreadShell) => void;
  readonly onNewThreadInProject: (project: EnvironmentProject) => void;
  readonly onOpenPendingTask: (pendingTask: PendingNewTask) => void;
  readonly onSearchQueryChange: (query: string) => void;
  readonly onSelectThread: (thread: EnvironmentThreadShell) => void;
  readonly onOpenThreadPullRequests: (
    thread: EnvironmentThreadShell,
    pr: ThreadPrPresentation,
  ) => void;
  readonly onRequestVisibility: () => void;
  readonly searchQuery: string;
}

export function ThreadNavigationSidebar(props: ThreadNavigationSidebarProps) {
  return (
    <ThreadPrDemandProvider visible={props.visible}>
      <WorkspaceSidebarColumn width={props.width}>
        <ThreadNavigationSidebarPane {...props} />
      </WorkspaceSidebarColumn>
    </ThreadPrDemandProvider>
  );
}

function ThreadNavigationSidebarPane(props: ThreadNavigationSidebarProps) {
  const floatingTabsEnabled = useAndroidFloatingTabs();
  const { themeVariables: materialTheme } = useAppearancePreferences();
  const drawerColor = materialTheme["--color-drawer"];

  const insets = useSafeAreaInsets();
  const { fabClearance, fabSize } = useAndroidControlSizing();
  const projects = useProjects();
  const threads = useAtomValue(steadyNavigationThreadShellsAtom);
  const { environments: workspaceEnvironments, state: catalogState } = useWorkspaceState();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const openSwipeableRef = useRef<SwipeableMethods | null>(null);
  const sidebarScrollGesture = useNativeGesture();
  const {
    archiveThread,
    confirmDeleteThread,
    settleThread,
    snoozeThread,
    unsnoozeThread,
    unsettleThread,
    pinThread,
    unpinThread,
    setThreadAutoSettle,
    moveThread,
    renameThread,
    regenerateThreadTitle,
  } = useThreadListActions();
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const pendingTasks = usePendingNewTasks();
  const activeNewTask = useActiveNewTask();
  const queuedThreadKeys = useQueuedThreadKeys();
  const selectDetail = useSelectWorkspaceDetail();
  const { confirmDeletePendingTask } = usePendingTaskListActions((params) =>
    selectDetail({ name: "Thread", params }),
  );
  const environments = Object.values(savedConnectionsById)
    .map((connection) => ({
      environmentId: connection.environmentId,
      label: connection.environmentLabel,
    }))
    .sort((left, right) => left.label.localeCompare(right.label));
  const availableEnvironmentIds = new Set(
    environments.map((environment) => environment.environmentId),
  );
  const {
    options,
    setSelectedProjectKey,
    toggleSelectedEnvironmentId,
    clearSelectedEnvironments,
    setOwnershipFilter,
    setOwnershipRelation,
    setThreadGrouping,
  } = useHomeListOptions(availableEnvironmentIds);
  const claimPersonIdByEnvironment = useAtomValue(identityClaimPersonIdByEnvironmentAtom);
  const searchEnvironmentIds = (() => {
    const connectedIds = workspaceEnvironments
      .filter((environment) => environment.connectionState === "connected")
      .map((environment) => environment.environmentId);
    if (options.selectedEnvironmentIds.length === 0) {
      return connectedIds;
    }
    const selected = new Set(options.selectedEnvironmentIds);
    return connectedIds.filter((environmentId) => selected.has(environmentId));
  })();
  const hideSettledOnRecent = AsyncResult.isSuccess(preferencesResult)
    ? resolveHideSettledOnRecent(preferencesResult.value)
    : true;
  const hideSettledOnProjects = AsyncResult.isSuccess(preferencesResult)
    ? resolveHideSettledOnProjects(preferencesResult.value)
    : false;
  const hideSettledThreads =
    options.threadGrouping === "project" ? hideSettledOnProjects : hideSettledOnRecent;
  const setHideSettledThreads = (hide: boolean) => {
    if (options.threadGrouping === "project") {
      savePreferences({ hideSettledOnProjects: hide });
      return;
    }
    savePreferences({ hideSettledOnRecent: hide });
  };

  const projectScopes = (() =>
    buildHomeProjectScopes({
      projects,
      selectedEnvironmentIds: options.selectedEnvironmentIds,
      projectGroupingMode: options.projectGroupingMode,
    }))();
  const projectFilterOptions = (() =>
    pickableProjectGroups(projectScopes).map((scope) => ({
      key: scope.key,
      label: scope.title,
    })))();
  const projectTitleByProjectKey = (() =>
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
    ))();
  const selectedProjectScope = resolveHomeProjectFilterScope(projectScopes, projects, options);
  const threadSearch = useThreadSearch(
    searchEnvironmentIds,
    props.searchQuery,
    selectedProjectScope === null
      ? {}
      : { projectIds: selectedProjectScope.projectRefs.map((ref) => ref.projectId) },
  );
  const selectedProjectRefs =
    selectedProjectScope === null
      ? null
      : new Set(
          selectedProjectScope.projectRefs.map((ref) =>
            scopedProjectKey(ref.environmentId, ref.projectId),
          ),
        );
  const scopedThreads = threads.filter(
    (thread) =>
      (selectedProjectRefs === null ||
        selectedProjectRefs.has(scopedProjectKey(thread.environmentId, thread.projectId))) &&
      threadMatchesMine({
        claimPersonId: claimPersonIdForEnvironment(
          claimPersonIdByEnvironment,
          thread.environmentId,
        ),
        originPersonId: thread.originSource?.personId ?? null,
        participantPersonIds: (thread.participantSummaries ?? []).map(
          (participant) => participant.personId,
        ),
        mode: options.ownershipFilter,
        relation: options.ownershipRelation,
      }),
  );
  const launchingThreads = useLaunchingThreads(scopedThreads);
  const threadSearchMatchByKey = useThreadListSearchMatches(scopedThreads, threadSearch);
  const selectedProjectKey = selectedProjectScope?.key ?? null;
  const projectByKey = (() => {
    const map = new Map<string, EnvironmentProject>();
    for (const project of projects) {
      map.set(scopedProjectKey(project.environmentId, project.id), project);
    }
    return map;
  })();

  const [settledVisibleCount, setSettledVisibleCount] = useState(
    THREAD_LIST_V2_SETTLED_INITIAL_COUNT,
  );
  const settledResetKey = `${options.selectedEnvironmentIds.join(",") || "all"}:${selectedProjectKey ?? "all"}:${props.searchQuery.trim()}`;
  const [lastSettledResetKey, setLastSettledResetKey] = useState(settledResetKey);
  if (lastSettledResetKey !== settledResetKey) {
    setLastSettledResetKey(settledResetKey);
    setSettledVisibleCount(THREAD_LIST_V2_SETTLED_INITIAL_COUNT);
  }
  const showMoreSettled = () =>
    setSettledVisibleCount((count) => count + THREAD_LIST_V2_SETTLED_PAGE_COUNT);
  const {
    loaded: shelfPreferencesLoaded,
    settledShelfExpanded,
    snoozedShelfExpanded,
    workingShelfEnabled,
    workingShelfExpanded,
    toggleSettledShelf,
    toggleSnoozedShelf,
    toggleWorkingShelf,
  } = useThreadListV2ShelfPreferences();
  const now = useThreadListNow(threads);
  const listEnvironments = useAtomValue(threadListEnvironmentsAtom);
  const {
    providersByEnvironmentId,
    machineByEnvironmentId,
    settlementEnvironmentIds,
    snoozeEnvironmentIds,
    snoozePresetsByEnvironmentId,
    pinningEnvironmentIds,
    autoSettleOptOutEnvironmentIds,
    pinReorderEnvironmentIds,
    activeReorderEnvironmentIds,
    titleRegenerationEnvironmentIds,
  } = listEnvironments;
  const resolveProviderInstance = useThreadRowProviderInstanceResolver(providersByEnvironmentId);
  const pendingOrder = usePendingThreadOrder();
  const {
    layout: threadListV2Layout,
    items: threadListV2Items,
    contentOnlyThreadKeys,
    olderSettledShelf,
  } = useThreadListV2({
    threads: options.listMode === "threads" ? launchingThreads : [],
    pendingTasks: options.listMode === "threads" ? pendingTasks : [],
    environmentId: null,
    selectedEnvironmentIds: options.selectedEnvironmentIds,
    orderByRecency: options.threadGrouping === "recency",
    projectRefs: selectedProjectScope === null ? null : selectedProjectScope.projectRefs,
    searchQuery: props.searchQuery,
    searchMatches: threadSearchMatchByKey,
    settlementEnvironmentIds,
    snoozeEnvironmentIds,
    pinReorderEnvironmentIds,
    activeReorderEnvironmentIds,
    queuedThreadKeys,
    settledLimit: settledVisibleCount,
    now,
    pendingOrder,
    shelfPreferencesLoaded,
    workingShelfEnabled,
    workingShelfExpanded,
    snoozedShelfExpanded,
    settledShelfExpanded,
    selectedThreadKey: props.selectedThreadKey ?? null,
  });
  const listItems: readonly SidebarListItem[] =
    settledShelfExpanded && threadListV2Layout.hiddenSettledCount > 0
      ? [
          ...threadListV2Items,
          {
            type: "v2-show-more",
            key: "v2-show-more",
            hiddenCount: threadListV2Layout.hiddenSettledCount,
            ...(olderSettledShelf.loading
              ? { state: "loading" as const }
              : olderSettledShelf.failed
                ? { state: "failed" as const }
                : {}),
          },
        ]
      : threadListV2Items;

  const handleSwipeableWillOpen = (methods: SwipeableMethods) => {
    if (openSwipeableRef.current !== methods) {
      openSwipeableRef.current?.close();
      openSwipeableRef.current = methods;
    }
  };
  const handleSwipeableClose = (methods: SwipeableMethods) => {
    if (openSwipeableRef.current === methods) {
      openSwipeableRef.current = null;
    }
  };
  // Destructure callback props; capturing all props would invalidate these row-closing handlers on unrelated changes.
  const { onSelectThread, onOpenThreadPullRequests } = props;
  // A row listed for a message match opens the thread at that message, by
  // tap or by shortcut.
  const handleSelectThread = (thread: EnvironmentThreadShell) => {
    const key = threadSearchMatchKey({ environmentId: thread.environmentId, threadId: thread.id });
    const messageId = contentOnlyThreadKeys.has(key)
      ? threadSearchMatchByKey.get(key)?.messageId
      : undefined;
    if (messageId) {
      requestThreadMessageJump(scopedThreadKey(thread.environmentId, thread.id), messageId);
    }
    onSelectThread(thread);
    openSwipeableRef.current?.close();
  };
  const handleOpenThreadPullRequests = (
    thread: EnvironmentThreadShell,
    pr: ThreadPrPresentation,
  ) => {
    onOpenThreadPullRequests(thread, pr);
    openSwipeableRef.current?.close();
  };
  const handleScrollBeginDrag = () => {
    openSwipeableRef.current?.close();
  };
  const onFabScroll = useFabScroll();
  const { swipeEnabled, scrollGateHandlers } = useSwipeableScrollGate({
    onScroll: onFabScroll,
    onScrollBeginDrag: handleScrollBeginDrag,
  });
  // Recycle equality needs project/search data for titles and favicons; keep the minute clock on items to limit updates.
  const listExtraData = {
    activeNewTask,
    selectedThreadKey: props.selectedThreadKey ?? "",
    projectByKey,
    projectTitleByProjectKey,
    savedConnectionsById,
    listEnvironments,
    threadSearchMatchByKey,
    workingShelfEnabled,
  };
  useThreadJumpShortcuts(listItems, handleSelectThread);
  const sidebarItemsAreEqual = (previous: SidebarListItem, item: SidebarListItem): boolean => {
    if (isThreadListV2ListItem(previous) && isThreadListV2ListItem(item)) {
      return threadListV2ListItemsAreEqual(previous, item);
    }
    if (previous.type === "v2-show-more" && item.type === "v2-show-more") {
      return previous.hiddenCount === item.hiddenCount && previous.state === item.state;
    }
    if (previous.type === "v2-recency-header" && item.type === "v2-recency-header") {
      return previous.key === item.key && previous.label === item.label;
    }
    return false;
  };
  const renderListItem = ({ item }: { readonly item: SidebarListItem }) => {
    switch (item.type) {
      case "v2-pending": {
        const pendingScopeKey = scopedProjectKey(
          item.pendingTask.environmentId,
          item.pendingTask.projectId,
        );
        return (
          <ThreadListV2PendingRow
            pendingTask={item.pendingTask}
            selected={
              activeNewTask?.pendingKey === item.pendingTask.key ||
              (item.pendingTask.kind === "pending" &&
                scopedThreadKey(
                  item.pendingTask.environmentId,
                  item.pendingTask.message.threadId,
                ) === props.selectedThreadKey)
            }
            project={projectByKey.get(pendingScopeKey) ?? null}
            projectTitle={projectTitleByProjectKey.get(pendingScopeKey)}
            environmentLabel={
              Object.keys(savedConnectionsById).length > 1
                ? (savedConnectionsById[item.pendingTask.environmentId]?.environmentLabel ?? null)
                : null
            }
            environmentMachine={machineByEnvironmentId.get(item.pendingTask.environmentId)}
            pane="sidebar"
            showPendingDivider={item.showPendingDivider}
            onSelectPendingTask={props.onOpenPendingTask}
            onDeletePendingTask={confirmDeletePendingTask}
            fullSwipeWidth={props.width - 20}
            onSwipeableClose={handleSwipeableClose}
            onSwipeableWillOpen={handleSwipeableWillOpen}
            simultaneousSwipeGesture={sidebarScrollGesture}
          />
        );
      }
      case "v2-thread": {
        const thread = item.item.thread;
        const scopeKey = scopedProjectKey(thread.environmentId, thread.projectId);
        return (
          <ThreadListV2Row
            onNewThreadOnBranch={props.onNewThreadOnBranch}
            thread={thread}
            variant={item.item.variant}
            hasQueuedMessages={item.hasQueuedMessages}
            snoozed={item.item.snoozed}
            pinned={item.item.pinned}
            wokeAt={item.item.wokeAt}
            snoozePresetMinute={item.snoozePresetMinute ?? ""}
            snoozeWakeLabelText={item.snoozeWakeLabelText}
            timeLabel={item.timeLabel}
            project={projectByKey.get(scopeKey) ?? null}
            providerInstance={resolveProviderInstance(thread)}
            providers={providersByEnvironmentId.get(thread.environmentId)}
            environmentLabel={
              Object.keys(savedConnectionsById).length > 1
                ? (savedConnectionsById[thread.environmentId]?.environmentLabel ?? null)
                : null
            }
            environmentMachine={machineByEnvironmentId.get(thread.environmentId)}
            searchMatch={
              // Only rows listed for their messages show one and open at it.
              contentOnlyThreadKeys.has(
                threadSearchMatchKey({ environmentId: thread.environmentId, threadId: thread.id }),
              )
                ? threadSearchMatchByKey.get(
                    threadSearchMatchKey({
                      environmentId: thread.environmentId,
                      threadId: thread.id,
                    }),
                  )
                : undefined
            }
            searchQuery={threadSearch.query}
            pane="sidebar"
            selected={
              !activeNewTask &&
              scopedThreadKey(thread.environmentId, thread.id) === props.selectedThreadKey
            }
            fullSwipeWidth={props.width - 20}
            onSelectThread={handleSelectThread}
            onOpenThreadPullRequests={handleOpenThreadPullRequests}
            onDeleteThread={confirmDeleteThread}
            onArchiveThread={archiveThread}
            onRenameThread={renameThread}
            onRegenerateThreadTitle={regenerateThreadTitle}
            titleRegenerationSupported={titleRegenerationEnvironmentIds.has(thread.environmentId)}
            settlementSupported={settlementEnvironmentIds.has(thread.environmentId)}
            onSettleThread={settleThread}
            snoozeSupported={snoozeEnvironmentIds.has(thread.environmentId)}
            snoozePresets={snoozePresetsByEnvironmentId.get(thread.environmentId)}
            pinningSupported={pinningEnvironmentIds.has(thread.environmentId)}
            autoSettleOptOutSupported={autoSettleOptOutEnvironmentIds.has(thread.environmentId)}
            reorderSupported={
              item.item.pinned
                ? pinReorderEnvironmentIds.has(thread.environmentId)
                : !workingShelfEnabled && activeReorderEnvironmentIds.has(thread.environmentId)
            }
            canMoveUp={item.canMoveUp}
            canMoveDown={item.canMoveDown}
            onSnoozeThread={snoozeThread}
            onUnsnoozeThread={unsnoozeThread}
            onUnsettleThread={unsettleThread}
            onPinThread={pinThread}
            onUnpinThread={unpinThread}
            onSetThreadAutoSettle={setThreadAutoSettle}
            onMoveThread={moveThread}
            onSwipeableClose={handleSwipeableClose}
            onSwipeableWillOpen={handleSwipeableWillOpen}
            simultaneousSwipeGesture={sidebarScrollGesture}
          />
        );
      }
      case "v2-recency-header":
        return (
          <View className="px-3 pb-1 pt-3">
            <Text className="text-xs font-t3-medium text-foreground-muted">{item.label}</Text>
          </View>
        );
      case "v2-working-shelf":
        return (
          <ThreadListV2WorkingShelfHeader
            count={item.count}
            disabled={item.disabled}
            expanded={item.expanded}
            onToggle={toggleWorkingShelf}
            pane="sidebar"
          />
        );
      case "v2-snoozed-shelf":
        return (
          <ThreadListV2SnoozedShelfHeader
            count={item.count}
            disabled={item.disabled}
            expanded={item.expanded}
            onToggle={toggleSnoozedShelf}
            pane="sidebar"
          />
        );
      case "v2-settled-shelf":
        return (
          <ThreadListV2SettledShelfHeader
            count={item.count}
            disabled={item.disabled}
            expanded={item.expanded}
            onToggle={toggleSettledShelf}
            pane="sidebar"
          />
        );
      case "v2-show-more":
        return (
          <ThreadListV2ShowMoreRow
            pane="sidebar"
            hiddenCount={item.hiddenCount}
            {...(item.state === undefined ? {} : { state: item.state })}
            onPress={() => {
              olderSettledShelf.retry();
              showMoreSettled();
            }}
          />
        );
    }
  };
  // Snoozed threads need no special case: the shelf header is a list row
  // even while collapsed.
  const snoozedCount = threadListV2Layout.snoozedCount;
  const header = (
    <WorkspaceListHeader
      accessibilityLabel="T3 Code, Threads"
      onOpenEnvironments={props.onOpenEnvironmentSettings}
      onOpenSettings={props.onOpenSettings}
      search={{
        value: props.searchQuery,
        onChangeText: props.onSearchQueryChange,
        placeholder: "Search",
        accessibilityLabel: "Search threads",
      }}
      filter={{
        customized:
          options.selectedEnvironmentIds.length > 0 ||
          options.ownershipFilter !== DEFAULT_OWNERSHIP_FILTER ||
          options.ownershipRelation !== DEFAULT_OWNERSHIP_RELATION ||
          selectedProjectKey !== null ||
          options.threadGrouping !== DEFAULT_HOME_THREAD_GROUPING ||
          hideSettledThreads !== (options.threadGrouping !== "project"),
        items: buildHomeListFilterMenuItems({
          environments,
          projects: projectFilterOptions,
          selectedEnvironmentIds: options.selectedEnvironmentIds,
          selectedProjectKey,
          ownershipFilter: options.ownershipFilter,
          ownershipRelation: options.ownershipRelation,
          threadGrouping: options.threadGrouping,
          hideSettledThreads,
          onClearEnvironments: clearSelectedEnvironments,
          onToggleEnvironment: toggleSelectedEnvironmentId,
          onProjectChange: setSelectedProjectKey,
          onOwnershipFilterChange: setOwnershipFilter,
          onOwnershipRelationChange: setOwnershipRelation,
          onThreadGroupingChange: setThreadGrouping,
          onHideSettledThreadsChange: setHideSettledThreads,
        }),
      }}
      sidebar={{
        width: props.width,
        visible: props.visible,
        onRequestVisibility: props.onRequestVisibility,
      }}
    />
  );
  const showAddEnvironment =
    !catalogState.isLoadingConnections &&
    !catalogState.hasReadyEnvironment &&
    !catalogState.hasConnectingEnvironment;
  const listEmpty = (
    <View>
      <Text
        className={
          Platform.OS === "android"
            ? "px-4 py-4 text-center text-sm text-drawer-foreground-muted"
            : "px-2 py-4 text-sm text-drawer-foreground-muted"
        }
      >
        {catalogState.isLoadingConnections
          ? "Loading threads…"
          : showAddEnvironment
            ? "No environments connected"
            : props.searchQuery.trim().length > 0
              ? threadSearch.isPending
                ? "Searching thread messages…"
                : snoozedCount > 0
                  ? snoozedCount === 1
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
      {showAddEnvironment ? (
        <View className={Platform.OS === "android" ? "self-center" : "px-2"}>
          <Button
            tone="primary"
            size="compact"
            icon="plus"
            label="Add environment"
            onPress={props.onOpenEnvironmentSettings}
          />
        </View>
      ) : null}
    </View>
  );

  if (Platform.OS === "ios") {
    return (
      <>
        {header}
        <View className="flex-1">
          <SwipeableScrollGateProvider enabled={swipeEnabled}>
            <GestureDetector gesture={sidebarScrollGesture}>
              <AnimatedLegendList
                renderScrollComponent={NativeScrollView}
                itemLayoutAnimation={THREAD_SIDEBAR_ROW_LAYOUT}
                data={listItems}
                drawDistance={500}
                estimatedItemSize={64}
                extraData={listExtraData}
                getItemType={(item) => item.type}
                itemsAreEqual={sidebarItemsAreEqual}
                keyExtractor={(item) => item.key}
                renderItem={renderListItem}
                automaticallyAdjustsScrollIndicatorInsets
                // The column lays the list under its bar, glass or solid; UIKit insets it past both.
                contentInsetAdjustmentBehavior="automatic"
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
                ListEmptyComponent={listEmpty}
              />
            </GestureDetector>
          </SwipeableScrollGateProvider>
          <ThreadUndoNotice visible={props.visible} />
        </View>
      </>
    );
  }

  // Android: the bar floats below the list.
  return (
    <View testID="thread-navigation-sidebar" className="flex-1 bg-header">
      <View
        className="flex-1"
        style={{
          marginHorizontal: 4,
          paddingBottom: insets.bottom,
          backgroundColor: drawerColor,
          borderTopLeftRadius: 28,
          borderTopRightRadius: 28,
          overflow: "hidden",
        }}
      >
        {listItems.length === 0 ? (
          <View className="flex-1 items-center justify-center">{listEmpty}</View>
        ) : (
          <SwipeableScrollGateProvider enabled={swipeEnabled}>
            <GestureDetector gesture={sidebarScrollGesture}>
              {/* oxlint-disable-next-line t3code/require-registered-list-scroll -- The Android sidebar has no native header to register with. */}
              <AnimatedLegendList
                itemLayoutAnimation={THREAD_SIDEBAR_ROW_LAYOUT}
                data={listItems}
                drawDistance={500}
                estimatedItemSize={64}
                extraData={listExtraData}
                getItemType={(item) => item.type}
                itemsAreEqual={sidebarItemsAreEqual}
                keyExtractor={(item) => item.key}
                renderItem={renderListItem}
                contentContainerStyle={{
                  paddingBottom: floatingTabsEnabled
                    ? FLOATING_TABS.bottom + FLOATING_TABS.edge + fabSize
                    : Math.max(insets.bottom, 16) + fabClearance - insets.bottom,
                  paddingTop: 6,
                }}
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
      {header}
      <ThreadUndoNotice visible={props.visible} />
    </View>
  );
}

const styles = StyleSheet.create({
  threadList: {
    flex: 1,
  },
  threadListContent: {
    paddingHorizontal: 8,
  },
});
