import * as Arr from "effect/Array";
import * as Order from "effect/Order";
import { useNavigation } from "@react-navigation/native";
import { useMemo, useState } from "react";

import { useProjects, useThreadShells } from "../../state/entities";
import { useWorkspaceState } from "../../state/workspace";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { HomeScreen } from "./HomeScreen";
import { HomeHeader } from "./HomeHeader";
import { useHomeListOptions } from "./home-list-options";
import { useThreadListActions } from "./useThreadListActions";

/* ─── Route screen ───────────────────────────────────────────────────── */

export function HomeRouteScreen() {
  const projects = useProjects();
  const threads = useThreadShells();
  const { state: catalogState } = useWorkspaceState();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const navigation = useNavigation();
  const [searchQuery, setSearchQuery] = useState("");
  const { archiveThread, confirmDeleteThread } = useThreadListActions();
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
    setSelectedEnvironmentId,
    setProjectGroupingMode,
    setProjectSortOrder,
    setThreadSortOrder,
  } = useHomeListOptions(availableEnvironmentIds);
  const selectedEnvironmentId = listOptions.selectedEnvironmentId;

  return (
    <>
      <HomeHeader
        environments={environments}
        selectedEnvironmentId={selectedEnvironmentId}
        projectSortOrder={listOptions.projectSortOrder}
        threadSortOrder={listOptions.threadSortOrder}
        projectGroupingMode={listOptions.projectGroupingMode}
        onEnvironmentChange={setSelectedEnvironmentId}
        onOpenSettings={() => navigation.navigate("SettingsSheet", { screen: "Settings" })}
        onProjectGroupingModeChange={setProjectGroupingMode}
        onProjectSortOrderChange={setProjectSortOrder}
        onSearchQueryChange={setSearchQuery}
        onStartNewTask={() => navigation.navigate("NewTaskSheet", { screen: "NewTask" })}
        onThreadSortOrderChange={setThreadSortOrder}
      />

      <HomeScreen
        catalogState={catalogState}
        environments={environments}
        onAddConnection={() =>
          navigation.navigate("SettingsSheet", { screen: "SettingsEnvironmentNew" })
        }
        onArchiveThread={archiveThread}
        onDeleteThread={confirmDeleteThread}
        onEnvironmentChange={setSelectedEnvironmentId}
        onOpenEnvironments={() =>
          navigation.navigate("SettingsSheet", { screen: "SettingsEnvironments" })
        }
        onOpenSettings={() => navigation.navigate("SettingsSheet", { screen: "Settings" })}
        onProjectGroupingModeChange={setProjectGroupingMode}
        onProjectSortOrderChange={setProjectSortOrder}
        onSearchQueryChange={setSearchQuery}
        onSelectThread={(thread) => {
          navigation.navigate("Thread", {
            environmentId: thread.environmentId,
            threadId: thread.id,
          });
        }}
        onStartNewTask={() => navigation.navigate("NewTaskSheet", { screen: "NewTask" })}
        onThreadSortOrderChange={setThreadSortOrder}
        projectGroupingMode={listOptions.projectGroupingMode}
        projects={projects}
        projectSortOrder={listOptions.projectSortOrder}
        savedConnectionsById={savedConnectionsById}
        searchQuery={searchQuery}
        selectedEnvironmentId={selectedEnvironmentId}
        threads={threads}
        threadSortOrder={listOptions.threadSortOrder}
      />
    </>
  );
}
