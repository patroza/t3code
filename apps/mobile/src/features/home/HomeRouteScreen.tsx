import { uuidv4 } from "../../lib/uuid";
import { ThreadUndoNotice } from "./ThreadUndoNotice";
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
import { use, useCallback, useMemo, useState } from "react";
import { Platform } from "react-native";

import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  pickableProjectGroups,
  resolveScratchProjectScopeKey,
} from "@t3tools/client-runtime/state/project-grouping";

import { useProjects } from "../../state/entities";
import { environmentThreadShells } from "../../state/threads";
import { usePendingNewTasks } from "../../state/use-pending-new-tasks";
import { useWorkspaceState } from "../../state/workspace";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { AndroidHomeFabLayout } from "./AndroidHomeFab";
import { HomeScreen } from "./HomeScreen";
import {
  DEFAULT_OWNERSHIP_FILTER,
  DEFAULT_OWNERSHIP_RELATION,
  useHomeListOptions,
} from "./home-list-options";
import { DEFAULT_HOME_THREAD_GROUPING } from "./homeListMode";
import { useAtomValueWhileVisible, useHomeRouteVisible } from "./home-route-visibility";
import { buildHomeProjectScopes } from "./homeThreadList";
import { usePendingTaskListActions } from "./usePendingTaskListActions";
import { useThreadListActions } from "./useThreadListActions";
import { useWorkspaceTabs } from "../layout/workspace/WorkspaceTabsContext";
import { openSettings } from "../settings/settings-navigation";
import { useSelectWorkspaceTab } from "../layout/workspace/useSelectWorkspaceTab";
import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";
import { WorkspaceListEmptyDetail } from "../layout/workspace/WorkspaceListEmptyDetail";
import { WorkspaceListHeader } from "../layout/workspace/WorkspaceListHeader";
import { buildHomeListFilterMenuItems } from "./home-list-filter-menu";

export function HomeRouteScreen() {
  const nativePrimaryColumn = use(NativePrimaryColumnContext);
  const { layout, primarySidebarSearchQuery, setPrimarySidebarSearchQuery, startNewTask } =
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
  const handleSelectThread = (thread: EnvironmentThreadShell) =>
    selectDetail({
      name: "Thread",
      params: { environmentId: String(thread.environmentId), threadId: String(thread.id) },
    });
  const selectThreadRoute = (params: ReactNavigation.RootParamList["Thread"]) =>
    selectDetail({ name: "Thread", params });
  const handleNewThreadOnBranch = (thread: EnvironmentThreadShell) => {
    selectThreadRoute({
      draft: {
        requestId: uuidv4(),
        environmentId: String(thread.environmentId),
        projectId: String(thread.projectId),
        branch: thread.branch,
        worktreePath: thread.worktreePath,
      },
    });
  };

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
  const connectionStateByEnvironmentId = new Map(
    workspaceEnvironments.map(
      (environment) => [environment.environmentId, environment.connectionState] as const,
    ),
  );
  const environments = Arr.sort(
    Object.values(savedConnectionsById).map((connection) => ({
      environmentId: connection.environmentId,
      label: connection.environmentLabel,
      connectionState: connectionStateByEnvironmentId.get(connection.environmentId) ?? "available",
    })),
    Order.mapInput(Order.String, (environment: { readonly label: string }) => environment.label),
  );
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

  const projectFilterOptions = useMemo(
    () =>
      pickableProjectGroups(
        buildHomeProjectScopes({
          projects,
          selectedEnvironmentIds,
          projectGroupingMode: listOptions.projectGroupingMode,
        }),
      ).map((scope) => ({
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
  const filterCustomized =
    selectedEnvironmentIds.length > 0 ||
    listOptions.ownershipFilter !== DEFAULT_OWNERSHIP_FILTER ||
    listOptions.ownershipRelation !== DEFAULT_OWNERSHIP_RELATION ||
    selectedProjectKey !== null ||
    listOptions.threadGrouping !== DEFAULT_HOME_THREAD_GROUPING ||
    hideSettledThreads !== (listOptions.threadGrouping !== "project");

  if (layout.usesSplitView && !nativePrimaryColumn) {
    return (
      <WorkspaceListEmptyDetail
        hasConnections={catalogState.hasConnections}
        onAddConnection={() => openSettings(navigation, "SettingsEnvironmentNew")}
        onStartNewTask={startNewTask}
      />
    );
  }

  return (
    <AndroidHomeFabLayout onStartNewTask={startNewTask}>
      <>
        <WorkspaceListHeader
          accessibilityLabel="T3 Code, Threads"
          onOpenEnvironments={() => openSettings(navigation, "SettingsEnvironments")}
          search={{
            value: searchQuery,
            onChangeText: setSearchQuery,
            placeholder: "Search",
            accessibilityLabel: "Search threads",
          }}
          filter={{
            customized: filterCustomized,
            items: buildHomeListFilterMenuItems({
              environments,
              projects: projectFilterOptions,
              selectedEnvironmentIds,
              selectedProjectKey,
              ownershipFilter: listOptions.ownershipFilter,
              ownershipRelation: listOptions.ownershipRelation,
              threadGrouping: listOptions.threadGrouping,
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
