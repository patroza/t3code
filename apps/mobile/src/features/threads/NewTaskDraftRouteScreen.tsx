import type { StaticScreenProps } from "@react-navigation/native";
import { useMemo } from "react";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import type { ComposerDraftWorkspaceSelection } from "../../state/use-composer-drafts";

import { NewTaskDraftScreen } from "./NewTaskDraftScreen";

type NewTaskDraftRouteParams = {
  readonly environmentId?: string | string[];
  readonly projectId?: string | string[];
  readonly title?: string | string[];
  readonly pendingTaskId?: string | string[];
  readonly incomingShareId?: string | string[];
  readonly workspaceMode?: string | string[];
  readonly branch?: string | string[];
  readonly worktreePath?: string | string[];
};

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function NewTaskDraftRouteScreen({ route }: StaticScreenProps<NewTaskDraftRouteParams>) {
  const params = route.params ?? {};

  // Keyed on the params object so a fresh navigation to this (already
  // mounted) screen produces a new reference, letting the draft screen
  // re-apply the requested project.
  const initialProjectRef = useMemo(
    () => ({
      environmentId: Array.isArray(params.environmentId)
        ? params.environmentId[0]
        : params.environmentId,
      projectId: Array.isArray(params.projectId) ? params.projectId[0] : params.projectId,
    }),
    [route.params],
  );
  const initialWorkspaceSelection = useMemo<ComposerDraftWorkspaceSelection | undefined>(() => {
    const mode = firstParam(params.workspaceMode);
    if (mode !== "local" && mode !== "worktree") return undefined;
    return {
      mode,
      branch: firstParam(params.branch) ?? null,
      worktreePath: firstParam(params.worktreePath) ?? null,
    };
  }, [route.params]);

  return (
    <>
      <NativeStackScreenOptions
        options={{
          title: Array.isArray(params.title) ? params.title[0] : (params.title ?? "New task"),
        }}
      />
      <NewTaskDraftScreen
        initialProjectRef={initialProjectRef}
        initialWorkspaceSelection={initialWorkspaceSelection}
        incomingShareId={
          Array.isArray(params.incomingShareId) ? params.incomingShareId[0] : params.incomingShareId
        }
        pendingTaskId={
          Array.isArray(params.pendingTaskId) ? params.pendingTaskId[0] : params.pendingTaskId
        }
      />
    </>
  );
}
