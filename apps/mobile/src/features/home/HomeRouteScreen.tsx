import { HOME_LIST_MODE_TITLES } from "./homeListMode";
import { uuidv4 } from "../../lib/uuid";
import { ThreadUndoNotice } from "./ThreadUndoNotice";
import { Toolbar } from "../../components/ui/Toolbar";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import {
  claimPersonIdForEnvironment,
  threadMatchesMine,
} from "@t3tools/client-runtime/state/identity";
import { AsyncResult } from "effect/reactivity";
import {
  resolveHideSettledOnProjects,
  resolveHideSettledOnRecent,
} from "../../persistence/mobile-preferences";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { prefetchEnvironmentThread, warmSelectedEnvironmentThread } from "../../state/threads";
import { identityClaimPersonIdByEnvironmentAtom } from "../../state/identity";
import { NativePrimaryColumnContext } from "../../native/v5-workspace-context";
import * as Arr from "effect/Array";
import * as Order from "effect/Order";
import { useNavigation } from "@react-navigation/native";
import { use, useCallback, useEffect, useMemo, useState } from "react";
import { Platform, useWindowDimensions } from "react-native";

import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { resolveScratchProjectScopeKey } from "@t3tools/client-runtime/state/project-grouping";

import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useProjects } from "../../state/entities";
import { environmentThreadShells } from "../../state/threads";
import { usePendingNewTasks } from "../../state/use-pending-new-tasks";
import { useWorkspaceState } from "../../state/workspace";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { getConnectionAwareBrandHeaderOptions } from "./WorkspaceConnectionTitle";
import { useDeviceType, useNativeColumnLayoutMetrics } from "../../native/native-layout-metrics";
import { WorkspaceEmptyDetail } from "../layout/WorkspaceEmptyDetail";
import { AndroidScreenHeader } from "../../components/ui/AndroidScreenHeader";
import { checkForAppUpdateOnLaunch, startAppUpdateForegroundRecheck } from "../updates/app-updates";
import { AndroidHomeFabLayout } from "./AndroidHomeFab";
import { HomeScreen } from "./HomeScreen";
import { HomeHeader } from "./HomeHeader";
import { useHomeListOptions } from "./home-list-options";
import { useAtomValueWhileVisible, useHomeRouteVisible } from "./home-route-visibility";
import { buildHomeProjectScopes } from "./homeThreadList";
import { usePendingTaskListActions } from "./usePendingTaskListActions";
import { useThreadListActions } from "./useThreadListActions";
import { useWorkspaceTabs } from "../workspace/WorkspaceTabsContext";
import { openSettings } from "../settings/settings-navigation";
import { useSelectWorkspaceTab } from "../workspace/useSelectWorkspaceTab";
import { useSelectWorkspaceDetail } from "../workspace/useSelectWorkspaceDetail";

export function HomeRouteScreen() {
  const { width: windowWidth } = useWindowDimensions();
  const nativePrimaryColumn = use(NativePrimaryColumnContext);
  const columnMetrics = useNativeColumnLayoutMetrics();
  const deviceType = useDeviceType();
  const headerWidth = nativePrimaryColumn ? (columnMetrics?.width ?? windowWidth) : windowWidth;
  const { layout, panes, primarySidebarSearchQuery, setPrimarySidebarSearchQuery, startNewTask } =
    useAdaptiveWorkspaceLayout();
  const selectDetail = useSelectWorkspaceDetail();
  const projects = useProjects();
  // Stop rebuilding the streaming thread list while Thread covers Home.
  const visible = useHomeRouteVisible();
  const threads = useAtomValueWhileVisible(
    environmentThreadShells.navigationThreadShellsAtom,
    visible,
  );
  const { environments: workspaceEnvironments, state: catalogState } = useWorkspaceState();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const navigation = useNavigation();
  const selectTab = useSelectWorkspaceTab();
  const workspace = useWorkspaceTabs();
  const [localSearchQuery, setLocalSearchQuery] = useState("");
  const searchQuery =
    Platform.OS === "android"
      ? primarySidebarSearchQuery
      : (workspace?.state.tabs.threads.query ?? localSearchQuery);
  const setSearchQuery = (query: string) => {
    if (Platform.OS === "android") setPrimarySidebarSearchQuery(query);
    else if (workspace) workspace.dispatch({ type: "query", query, tab: "threads" });
    else setLocalSearchQuery(query);
  };
  const handleSelectThread = useCallback(
    (thread: EnvironmentThreadShell) =>
      selectDetail({
        name: "Thread",
        params: { environmentId: String(thread.environmentId), threadId: String(thread.id) },
      }),
    [selectDetail],
  );
  const selectThreadRoute = useCallback(
    (params: ReactNavigation.RootParamList["Thread"]) => selectDetail({ name: "Thread", params }),
    [selectDetail],
  );
  const handleNewThreadOnBranch = useCallback(
    (thread: EnvironmentThreadShell) => {
      selectThreadRoute({
        draft: {
          requestId: uuidv4(),
          environmentId: String(thread.environmentId),
          projectId: String(thread.projectId),
          branch: thread.branch,
          worktreePath: thread.worktreePath,
        },
      });
    },
    [selectThreadRoute],
  );

  useEffect(() => {
    void checkForAppUpdateOnLaunch();
    startAppUpdateForegroundRecheck();
  }, []);

  const {
    archiveThread,
    confirmDeleteThread,
    settleThread,
    snoozeThread,
    unsnoozeThread,
    pinThread,
    unpinThread,
    setThreadAutoSettle,
    moveThread,
    renameThread,
    regenerateThreadTitle,
    unsettleThread,
  } = useThreadListActions();
  const pendingTasks = usePendingNewTasks();
  const { openPendingTask, confirmDeletePendingTask } =
    usePendingTaskListActions(selectThreadRoute);
  const environments = useMemo(() => {
    const connectionStateByEnvironmentId = new Map(
      workspaceEnvironments.map(
        (environment) => [environment.environmentId, environment.connectionState] as const,
      ),
    );
    return Arr.sort(
      Object.values(savedConnectionsById).map((connection) => ({
        environmentId: connection.environmentId,
        label: connection.environmentLabel,
        connectionState:
          connectionStateByEnvironmentId.get(connection.environmentId) ?? "available",
      })),
      Order.mapInput(Order.String, (environment: { readonly label: string }) => environment.label),
    );
  }, [savedConnectionsById, workspaceEnvironments]);
  const availableEnvironmentIds = useMemo(
    () => new Set(environments.map((environment) => environment.environmentId)),
    [environments],
  );
  const {
    options: listOptions,
    setSelectedProjectKey,
    toggleSelectedEnvironmentId,
    clearSelectedEnvironments,
    setOwnershipFilter,
    setOwnershipRelation,
    setListMode,
    setThreadGrouping,
  } = useHomeListOptions(availableEnvironmentIds);
  const selectedEnvironmentIds = listOptions.selectedEnvironmentIds;
  const claimPersonIdByEnvironment = useAtomValue(identityClaimPersonIdByEnvironmentAtom);
  const ownershipFilteredThreads = useMemo(
    () =>
      threads.filter((thread) =>
        threadMatchesMine({
          claimPersonId: claimPersonIdForEnvironment(
            claimPersonIdByEnvironment,
            thread.environmentId,
          ),
          originPersonId: thread.originSource?.personId ?? null,
          participantPersonIds: (thread.participantSummaries ?? []).map(
            (participant) => participant.personId,
          ),
          mode: listOptions.ownershipFilter,
          relation: listOptions.ownershipRelation,
        }),
      ),
    [
      claimPersonIdByEnvironment,
      listOptions.ownershipFilter,
      listOptions.ownershipRelation,
      threads,
    ],
  );
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  // Recency/none default to hide settled; default/project grouping defaults to show.
  const hideSettledOnRecent = AsyncResult.isSuccess(preferencesResult)
    ? resolveHideSettledOnRecent(preferencesResult.value)
    : true;
  const hideSettledOnProjects = AsyncResult.isSuccess(preferencesResult)
    ? resolveHideSettledOnProjects(preferencesResult.value)
    : false;
  const hideSettledThreads =
    listOptions.threadGrouping === "project" ? hideSettledOnProjects : hideSettledOnRecent;
  const setHideSettledThreads = useCallback(
    (hide: boolean) => {
      if (listOptions.threadGrouping === "project") {
        savePreferences({ hideSettledOnProjects: hide });
        return;
      }
      savePreferences({ hideSettledOnRecent: hide });
    },
    [listOptions.threadGrouping, savePreferences],
  );
  const projectScopeKey = listOptions.selectedProjectKey;
  const resolvedProjectKey = resolveScratchProjectScopeKey(projectScopeKey, projects, {
    sidebarProjectGroupingMode: listOptions.projectGroupingMode,
    sidebarProjectGroupingOverrides: {},
  });
  useEffect(() => {
    if (resolvedProjectKey !== projectScopeKey) {
      setSelectedProjectKey(resolvedProjectKey);
    }
  }, [projectScopeKey, resolvedProjectKey, setSelectedProjectKey]);

  const projectFilterOptions = useMemo(
    () =>
      buildHomeProjectScopes({
        projects,
        selectedEnvironmentIds,
        projectGroupingMode: listOptions.projectGroupingMode,
      }).map((scope) => ({
        key: scope.key,
        label: scope.title,
      })),
    [listOptions.projectGroupingMode, projects, selectedEnvironmentIds],
  );
  const selectedProjectKey = projectFilterOptions.some(
    (project) => project.key === resolvedProjectKey,
  )
    ? resolvedProjectKey
    : null;

  if (layout.usesSplitView && !nativePrimaryColumn) {
    return (
      <>
        <NativeStackScreenOptions
          options={
            Platform.OS === "android"
              ? { headerShown: false }
              : {
                  title: "",
                  headerTitle: "",
                  unstable_headerLeftItems: () => [],
                  headerSearchBarOptions: undefined,
                  unstable_headerRightItems: () => [],
                  unstable_headerToolbarItems: () => [],
                }
          }
        />
        {Platform.OS === "ios" ? (
          <Toolbar placement="left">
            <Toolbar.Button
              accessibilityLabel="New task"
              icon="square.and.pencil"
              onPress={startNewTask}
            />
          </Toolbar>
        ) : null}
        {Platform.OS === "android" ? <AndroidScreenHeader title="Threads" /> : null}
        <WorkspaceEmptyDetail
          onAddConnection={
            Platform.OS === "android" && !catalogState.hasConnections
              ? () => openSettings(navigation, "SettingsEnvironmentNew")
              : undefined
          }
          onStartNewTask={
            Platform.OS === "android" && panes.primarySidebarVisible ? undefined : startNewTask
          }
        />
      </>
    );
  }

  return (
    <AndroidHomeFabLayout
      disabled={workspace !== null && Platform.OS !== "android"}
      onStartNewTask={startNewTask}
    >
      <>
        {/* Screen options merge shallowly; restore the header after split view. */}
        {workspace !== null && Platform.OS === "ios" ? null : (
          <NativeStackScreenOptions
            optionsVersion={headerWidth}
            options={{
              ...getConnectionAwareBrandHeaderOptions({
                title: HOME_LIST_MODE_TITLES[listOptions.listMode],
                headerWidth,
                trailingItemCount: nativePrimaryColumn && deviceType === "pad" ? 2 : 1,
                onOpenEnvironments: () => openSettings(navigation, "SettingsEnvironments"),
              }),
              headerShown: Platform.OS !== "android",
            }}
          />
        )}
        <HomeHeader
          environments={environments}
          projects={projectFilterOptions}
          searchQuery={searchQuery}
          listMode={listOptions.listMode}
          threadGrouping={listOptions.threadGrouping}
          selectedEnvironmentIds={selectedEnvironmentIds}
          selectedProjectKey={selectedProjectKey}
          ownershipFilter={listOptions.ownershipFilter}
          ownershipRelation={listOptions.ownershipRelation}
          hideSettledThreads={hideSettledThreads}
          onListModeChange={setListMode}
          onThreadGroupingChange={setThreadGrouping}
          onClearEnvironments={clearSelectedEnvironments}
          onToggleEnvironment={toggleSelectedEnvironmentId}
          onProjectChange={setSelectedProjectKey}
          onOwnershipFilterChange={setOwnershipFilter}
          onOwnershipRelationChange={setOwnershipRelation}
          onHideSettledThreadsChange={setHideSettledThreads}
          onOpenEnvironments={() => openSettings(navigation, "SettingsEnvironments")}
          onOpenSettings={() => selectTab("settings")}
          onSearchQueryChange={setSearchQuery}
          onStartNewTask={startNewTask}
        />

        <HomeScreen
          catalogState={catalogState}
          environments={environments}
          listMode={listOptions.listMode}
          threadGrouping={listOptions.threadGrouping}
          onAddConnection={() => openSettings(navigation, "SettingsEnvironmentNew")}
          onArchiveThread={archiveThread}
          onDeleteThread={confirmDeleteThread}
          onSettleThread={settleThread}
          onSnoozeThread={snoozeThread}
          onUnsnoozeThread={unsnoozeThread}
          onUnsettleThread={unsettleThread}
          onPinThread={pinThread}
          onUnpinThread={unpinThread}
          onClearEnvironments={clearSelectedEnvironments}
          onToggleEnvironment={toggleSelectedEnvironmentId}
          onSetThreadAutoSettle={setThreadAutoSettle}
          onMoveThread={moveThread}
          onRenameThread={renameThread}
          onRegenerateThreadTitle={regenerateThreadTitle}
          onProjectChange={setSelectedProjectKey}
          onOpenSettings={() => selectTab("settings")}
          onSearchQueryChange={setSearchQuery}
          onSelectThread={(thread) => {
            // Settled threads are live shells: opening one is plain
            // navigation, and sending a message un-settles server-side.
            // Warm detail (SQLite/HTTP) before the route mounts so open
            // latency overlaps the stack transition.
            prefetchEnvironmentThread(thread.environmentId, thread.id);
            warmSelectedEnvironmentThread(thread.environmentId, thread.id);
            handleSelectThread(thread);
          }}
          onSelectPendingTask={openPendingTask}
          onDeletePendingTask={confirmDeletePendingTask}
          onNewThreadOnBranch={handleNewThreadOnBranch}
          onNewThreadInProject={(project) => {
            selectThreadRoute({
              draft: {
                requestId: uuidv4(),
                environmentId: String(project.environmentId),
                projectId: String(project.id),
                title: project.title,
              },
            });
          }}
          onStartNewTask={startNewTask}
          pendingTasks={pendingTasks}
          projectGroupingMode={listOptions.projectGroupingMode}
          projects={projects}
          projectSortOrder={listOptions.projectSortOrder}
          savedConnectionsById={savedConnectionsById}
          searchQuery={searchQuery}
          selectedEnvironmentIds={selectedEnvironmentIds}
          selectedProjectKey={selectedProjectKey}
          ownershipFilter={listOptions.ownershipFilter}
          ownershipRelation={listOptions.ownershipRelation}
          onOwnershipFilterChange={setOwnershipFilter}
          onOwnershipRelationChange={setOwnershipRelation}
          threads={ownershipFilteredThreads}
        />
        <ThreadUndoNotice visible={visible} />
      </>
    </AndroidHomeFabLayout>
  );
}
