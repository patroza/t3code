import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import { useNavigation } from "@react-navigation/native";
import { useMemo } from "react";
import { Platform } from "react-native";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useProjects, useThreadShells } from "../../state/entities";
import { mobilePreferencesAtom } from "../../state/preferences";
import { prefetchEnvironmentThread, warmSelectedEnvironmentThread } from "../../state/threads";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { resolveProjectGroupingMode } from "../home/home-list-options";
import { useThreadListActions } from "../home/useThreadListActions";
import { BoardScreen } from "./BoardScreen";

export function BoardRouteScreen() {
  const navigation = useNavigation();
  const projects = useProjects();
  const threads = useThreadShells();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const { archiveThread, confirmDeleteThread, settleThread, unsettleThread } =
    useThreadListActions();

  const projectGroupingMode = resolveProjectGroupingMode(
    AsyncResult.isSuccess(preferencesResult)
      ? preferencesResult.value.projectGroupingEnabled
      : undefined,
  );

  const environmentLabelById = useMemo(() => {
    const map = new Map<string, string>();
    for (const connection of Object.values(savedConnectionsById)) {
      map.set(connection.environmentId, connection.environmentLabel);
    }
    return map;
  }, [savedConnectionsById]);

  return (
    <>
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title="Board" onBack={() => navigation.goBack()} />
        </>
      ) : (
        <NativeStackScreenOptions options={{ title: "Board", headerTitle: "Board" }} />
      )}
      <BoardScreen
        projects={projects}
        threads={threads}
        projectGroupingMode={projectGroupingMode}
        environmentLabelById={environmentLabelById}
        onSelectThread={(thread) => {
          prefetchEnvironmentThread(thread.environmentId, thread.id);
          warmSelectedEnvironmentThread(thread.environmentId, thread.id);
          navigation.navigate("Thread", {
            environmentId: thread.environmentId,
            threadId: thread.id,
          });
        }}
        onArchiveThread={archiveThread}
        onDeleteThread={confirmDeleteThread}
        onSettleThread={settleThread}
        onUnsettleThread={unsettleThread}
      />
    </>
  );
}
