import * as Arr from "effect/Array";
import * as Order from "effect/Order";
import { useNavigation } from "@react-navigation/native";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useEffect, useMemo, useState } from "react";

import { NativeHeaderToolbar, NativeStackScreenOptions } from "../../native/StackHeader";
import { useProjects, useThreadShells } from "../../state/entities";
import {
  resolveHideSettledOnProjects,
  resolveHideSettledOnRecent,
} from "../../persistence/mobile-preferences";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { prefetchEnvironmentThread, warmSelectedEnvironmentThread } from "../../state/threads";
import { usePendingNewTasks } from "../../state/use-pending-new-tasks";
import { useWorkspaceState } from "../../state/workspace";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { WorkspaceEmptyDetail } from "../layout/WorkspaceEmptyDetail";
import { WorkspaceSidebarToolbar } from "../layout/workspace-sidebar-toolbar";
import { AndroidHomeFabLayout } from "./AndroidHomeFab";
import { HomeScreen } from "./HomeScreen";
import { HomeHeader } from "./HomeHeader";
import { useHomeListOptions } from "./home-list-options";
import { buildHomeProjectScopes } from "./homeThreadList";
import { usePendingTaskListActions } from "./usePendingTaskListActions";
import { useThreadListActions } from "./useThreadListActions";

/* ─── Route screen ───────────────────────────────────────────────────── */

export function HomeRouteScreen() {
  const { layout } = useAdaptiveWorkspaceLayout();
  const projects = useProjects();
  const threads = useThreadShells();
  const { state: catalogState } = useWorkspaceState();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const navigation = useNavigation();
  const [searchQuery, setSearchQuery] = useState("");
  const { archiveThread, confirmDeleteThread, settleThread, unsettleThread } =
    useThreadListActions();
  const pendingTasks = usePendingNewTasks();
  const { openPendingTask, confirmDeletePendingTask } = usePendingTaskListActions();
  const environments = useMemo(
    () =>
      Arr.sort(
        Object.values(savedConnectionsById).map((connection) => ({
          environmentId: connection.environmentId,
          label: connection.environmentLabel,
        })),
        Order.mapInput(
          Order.String,
          (environment: { readonly label: string }) => environment.label,
        ),
      ),
    [savedConnectionsById],
  );
  const availableEnvironmentIds = useMemo(
    () => new Set(environments.map((environment) => environment.environmentId)),
    [environments],
  );
  const {
    options: listOptions,
    toggleSelectedEnvironmentId,
    clearSelectedEnvironments,
    setListMode,
    setThreadGrouping,
    setProjectSortOrder,
    setThreadSortOrder,
  } = useHomeListOptions(availableEnvironmentIds);
  const selectedEnvironmentIds = listOptions.selectedEnvironmentIds;
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  // Recency/none default to hide settled; project grouping defaults to show.
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
  const [selectedProjectKey, setSelectedProjectKey] = useState<string | null>(null);
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
  useEffect(() => {
    if (
      selectedProjectKey !== null &&
      !projectFilterOptions.some((project) => project.key === selectedProjectKey)
    ) {
      setSelectedProjectKey(null);
    }
  }, [projectFilterOptions, selectedProjectKey]);

  // In split layouts the persistent sidebar IS the thread list — Home becomes
  // an empty detail pane so selecting a thread never transitions layouts.
  if (layout.usesSplitView) {
    return (
      <>
        <NativeStackScreenOptions options={{ title: "", headerTitle: "" }} />
        <WorkspaceSidebarToolbar
          afterSidebarButton={
            <NativeHeaderToolbar.Button
              accessibilityLabel="New task"
              icon="square.and.pencil"
              onPress={() => navigation.navigate("NewTaskSheet", { screen: "NewTask" })}
            />
          }
        />
        <WorkspaceEmptyDetail
          onStartNewTask={() => navigation.navigate("NewTaskSheet", { screen: "NewTask" })}
        />
      </>
    );
  }

  return (
    <AndroidHomeFabLayout
      onStartNewTask={() => navigation.navigate("NewTaskSheet", { screen: "NewTask" })}
    >
      <>
        {/* Title is owned by HomeHeader (tracks list mode). */}
        <HomeHeader
          environments={environments}
          projects={projectFilterOptions}
          searchQuery={searchQuery}
          listMode={listOptions.listMode}
          threadGrouping={listOptions.threadGrouping}
          selectedEnvironmentIds={selectedEnvironmentIds}
          selectedProjectKey={selectedProjectKey}
          hideSettledThreads={hideSettledThreads}
          projectSortOrder={listOptions.projectSortOrder}
          threadSortOrder={listOptions.threadSortOrder}
          onListModeChange={setListMode}
          onThreadGroupingChange={setThreadGrouping}
          onClearEnvironments={clearSelectedEnvironments}
          onToggleEnvironment={toggleSelectedEnvironmentId}
          onProjectChange={setSelectedProjectKey}
          onHideSettledThreadsChange={setHideSettledThreads}
          onOpenSettings={() => navigation.navigate("SettingsSheet", { screen: "Settings" })}
          onProjectSortOrderChange={setProjectSortOrder}
          onSearchQueryChange={setSearchQuery}
          onStartNewTask={() => navigation.navigate("NewTaskSheet", { screen: "NewTask" })}
          onThreadSortOrderChange={setThreadSortOrder}
        />

        <HomeScreen
          catalogState={catalogState}
          environments={environments}
          listMode={listOptions.listMode}
          threadGrouping={listOptions.threadGrouping}
          hideSettledThreads={hideSettledThreads}
          onAddConnection={() =>
            navigation.navigate("SettingsSheet", { screen: "SettingsEnvironmentNew" })
          }
          onArchiveThread={archiveThread}
          onDeleteThread={confirmDeleteThread}
          onSettleThread={settleThread}
          onUnsettleThread={unsettleThread}
          onClearEnvironments={clearSelectedEnvironments}
          onToggleEnvironment={toggleSelectedEnvironmentId}
          onProjectChange={setSelectedProjectKey}
          onOpenEnvironments={() =>
            navigation.navigate("SettingsSheet", { screen: "SettingsEnvironments" })
          }
          onOpenSettings={() => navigation.navigate("SettingsSheet", { screen: "Settings" })}
          onProjectSortOrderChange={setProjectSortOrder}
          onSearchQueryChange={setSearchQuery}
          onSelectThread={(thread) => {
            // Settled threads are live shells: opening one is plain
            // navigation, and sending a message un-settles server-side.
            // Warm detail (SQLite/HTTP) before the route mounts so open
            // latency overlaps the stack transition.
            prefetchEnvironmentThread(thread.environmentId, thread.id);
            warmSelectedEnvironmentThread(thread.environmentId, thread.id);
            navigation.navigate("Thread", {
              environmentId: thread.environmentId,
              threadId: thread.id,
            });
          }}
          onSelectPendingTask={openPendingTask}
          onDeletePendingTask={confirmDeletePendingTask}
          onNewThreadInProject={(project) => {
            navigation.navigate("NewTaskSheet", {
              screen: "NewTaskDraft",
              params: {
                environmentId: String(project.environmentId),
                projectId: String(project.id),
                title: project.title,
              },
            });
          }}
          onStartNewTask={() => navigation.navigate("NewTaskSheet", { screen: "NewTask" })}
          onThreadSortOrderChange={setThreadSortOrder}
          pendingTasks={pendingTasks}
          projectGroupingMode={listOptions.projectGroupingMode}
          projects={projects}
          projectSortOrder={listOptions.projectSortOrder}
          savedConnectionsById={savedConnectionsById}
          searchQuery={searchQuery}
          selectedEnvironmentIds={selectedEnvironmentIds}
          selectedProjectKey={selectedProjectKey}
          threads={threads}
          threadSortOrder={listOptions.threadSortOrder}
        />
      </>
    </AndroidHomeFabLayout>
  );
}
