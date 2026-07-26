import * as Arr from "effect/Array";
import * as Order from "effect/Order";
import { useNavigation } from "@react-navigation/native";
import { useEffect, useMemo, useState } from "react";

import { NativeHeaderToolbar, NativeStackScreenOptions } from "../../native/StackHeader";
import { useProjects, useThreadShells } from "../../state/entities";
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
    setProjectSortOrder,
    setThreadSortOrder,
  } = useHomeListOptions(availableEnvironmentIds);
  const selectedEnvironmentIds = listOptions.selectedEnvironmentIds;
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
          selectedEnvironmentIds={selectedEnvironmentIds}
          selectedProjectKey={selectedProjectKey}
          projectSortOrder={listOptions.projectSortOrder}
          threadSortOrder={listOptions.threadSortOrder}
          onListModeChange={setListMode}
          onClearEnvironments={clearSelectedEnvironments}
          onToggleEnvironment={toggleSelectedEnvironmentId}
          onProjectChange={setSelectedProjectKey}
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
