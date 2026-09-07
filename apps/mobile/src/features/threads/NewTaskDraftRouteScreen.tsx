import { useNavigation, usePreventRemove, type StaticScreenProps } from "@react-navigation/native";
import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, View } from "react-native";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { AppText as Text } from "../../components/AppText";
import { useProjects } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import { useWorkspaceState } from "../../state/workspace";
import { vcsEnvironment } from "../../state/vcs";
import { checkoutNewTaskBranch } from "./checkout-new-task-branch";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import type { ComposerDraftWorkspaceSelection } from "../../state/use-composer-drafts";

import { NewTaskDraftScreen } from "./NewTaskDraftScreen";

type NewTaskDraftRouteParams = {
  readonly environmentId?: string | string[];
  readonly projectId?: string | string[];
  readonly title?: string | string[];
  readonly pendingTaskId?: string | string[];
  readonly draftId?: string | string[];
  readonly incomingShareId?: string | string[];
  readonly workspaceMode?: string | string[];
  readonly branch?: string | string[] | null;
  readonly worktreePath?: string | string[] | null;
};

function firstParam(value: string | string[] | null | undefined): string | undefined {
  if (value == null) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

export function NewTaskDraftRouteScreen({ route }: StaticScreenProps<NewTaskDraftRouteParams>) {
  const params = useMemo(() => route.params ?? {}, [route.params]);
  const pendingTaskId = firstParam(params.pendingTaskId);
  const draftId = firstParam(params.draftId);
  const workspaceMode = firstParam(params.workspaceMode);
  const projects = useProjects();
  const { state: catalogState } = useWorkspaceState();
  const navigation = useNavigation();
  const switchRef = useAtomCommand(vcsEnvironment.switchRef, { reportFailure: false });

  // Keyed on the params object so a fresh navigation to this (already
  // mounted) screen produces a new reference, letting the draft screen
  // re-apply the requested project.
  const initialProjectRef = useMemo(() => {
    const environmentId = firstParam(params.environmentId);
    const projectId = firstParam(params.projectId);
    // Workspace-picker routes own branch via initialWorkspaceSelection. Putting
    // it on initialProjectRef would force local mode and fight a worktree pick.
    const workspacePicker = workspaceMode === "local" || workspaceMode === "worktree";
    return {
      environmentId,
      projectId,
      branch: workspacePicker ? null : (firstParam(params.branch) ?? null),
      worktreePath: workspacePicker ? null : (firstParam(params.worktreePath) ?? null),
    };
  }, [params, workspaceMode]);
  const initialWorkspaceSelection = useMemo<ComposerDraftWorkspaceSelection | undefined>(() => {
    if (workspaceMode !== "local" && workspaceMode !== "worktree") return undefined;
    return {
      mode: workspaceMode,
      branch: firstParam(params.branch) ?? null,
      worktreePath: firstParam(params.worktreePath) ?? null,
    };
  }, [params.branch, params.worktreePath, workspaceMode]);

  const [preparation, setPreparation] = useState<{
    request: typeof initialProjectRef;
    result: Awaited<ReturnType<typeof checkoutNewTaskBranch>>;
    workspaceRoot: string | undefined;
  } | null>(null);
  const project = projects.find(
    (candidate) =>
      candidate.environmentId === initialProjectRef.environmentId &&
      candidate.id === initialProjectRef.projectId,
  );
  const environmentId = project?.environmentId;
  const workspaceRoot = project?.workspaceRoot;
  const needsPreparation = Boolean(initialProjectRef.branch && !pendingTaskId && !draftId);

  const [pendingCheckouts, setPendingCheckouts] = useState(0);
  const checkoutTail = useRef(Promise.resolve());
  const waitingForProject =
    !project &&
    (catalogState.isLoadingConnections ||
      (!catalogState.hasLoadedShellSnapshot &&
        catalogState.hasConnectingEnvironment &&
        catalogState.connectionError === null));

  useEffect(() => {
    if (!needsPreparation || !initialProjectRef.branch || waitingForProject) return;
    const branchName = initialProjectRef.branch;
    let active = true;
    setPendingCheckouts((count) => count + 1);
    // Serialize replacements: ignoring a stale result cannot undo its Git mutation.
    checkoutTail.current = checkoutTail.current.then(async () => {
      if (!active) {
        setPendingCheckouts((count) => count - 1);
        return;
      }
      const result = await checkoutNewTaskBranch({
        // A thread's branch is historical; only switchRef can establish that
        // the shared project checkout now matches it.
        branch: {
          name: branchName,
          current: false,
          isDefault: false,
          worktreePath: initialProjectRef.worktreePath ?? null,
        },
        project: environmentId && workspaceRoot ? { environmentId, workspaceRoot } : null,
        workspaceMode: "local",
        switchRef,
      });
      setPendingCheckouts((count) => count - 1);
      if (active) setPreparation({ request: initialProjectRef, result, workspaceRoot });
    });
    return () => {
      active = false;
    };
  }, [
    environmentId,
    workspaceRoot,
    initialProjectRef,
    needsPreparation,
    switchRef,
    waitingForProject,
  ]);

  const result =
    preparation?.request === initialProjectRef && preparation.workspaceRoot === workspaceRoot
      ? preparation.result
      : null;
  // The native-stack guard covers iOS swipe dismissal as well as back actions.
  // A replaced request must settle too before the shared checkout is left behind.
  const checkoutPending = pendingCheckouts > 0 || (needsPreparation && result === null);
  usePreventRemove(checkoutPending, () => undefined);
  useEffect(() => {
    if (checkoutPending || result?._tag !== "Failure") return;
    if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      Alert.alert(
        "Could not switch branch",
        error instanceof Error ? error.message : "The branch could not be checked out.",
      );
    }
    navigation.goBack();
  }, [checkoutPending, result, navigation]);

  const preparedProjectRef = useMemo(
    () =>
      result?._tag === "Success"
        ? { ...initialProjectRef, branch: result.value.name }
        : initialProjectRef,
    [initialProjectRef, result],
  );
  // Send/queue remain unavailable on failure while the unlocked route closes.
  const preparingBranch = checkoutPending || (needsPreparation && result?._tag !== "Success");

  return (
    <>
      <NativeStackScreenOptions
        options={{
          title: firstParam(params.title) ?? "New task",
        }}
      />
      {preparingBranch ? (
        <View className="flex-1 items-center justify-center bg-screen">
          <Text className="text-foreground">Switching branch...</Text>
        </View>
      ) : (
        <NewTaskDraftScreen
          initialProjectRef={preparedProjectRef}
          initialWorkspaceSelection={initialWorkspaceSelection}
          incomingShareId={firstParam(params.incomingShareId)}
          pendingTaskId={pendingTaskId}
          draftId={draftId}
        />
      )}
    </>
  );
}
