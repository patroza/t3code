// @effect-diagnostics nodeBuiltinImport:off globalErrorInEffectFailure:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import {
  T3_PROJECT_FILE_NAME,
  type OrchestrationProjectShell,
  type T3ProjectFile,
  type VcsRef,
} from "@t3tools/contracts";
import { resolveNewThreadEnvMode, resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { parseT3ProjectFile } from "@t3tools/shared/t3ProjectFile";
import * as Effect from "effect/Effect";

import { T3Session, T3SessionError } from "./T3Session.ts";

export interface LaunchWorkspace {
  /** Use the project's main checkout. */
  readonly local: boolean;
  /** Worktree base. Null when the turn stays on the main checkout. */
  readonly baseBranch: string | null;
  /** Fetch that base from its remote before creating the worktree. */
  readonly startFromOrigin: boolean;
}

/**
 * Where a new Discord or Teams thread starts.
 *
 * The workspace mode and the "start from remote" switch come from the project's
 * T3 settings: project override, then the environment, then `t3.json`, then the
 * built-in default. A worktree's base branch is the repository default branch,
 * then the checkout's current branch, the same order the composer uses.
 * `--local` and `--base` override that turn.
 */
export const resolveLaunchWorkspace = Effect.fn("resolveLaunchWorkspace")(function* (input: {
  readonly project: OrchestrationProjectShell;
  readonly explicitLocal: boolean;
  /** `--base`, or a Teams workspace base. Blank is the same as omitted. */
  readonly explicitBase?: string | undefined;
}) {
  if (input.explicitLocal) {
    return localCheckout();
  }
  const explicitBase = blankToUndefined(input.explicitBase);

  const t3 = yield* T3Session;
  const serverConfig = yield* t3.serverConfig();
  if (serverConfig === null) {
    return yield* Effect.fail(new T3SessionError("T3 settings are not loaded yet."));
  }

  const shell = yield* t3.shell();
  const projectHasThreads =
    shell?.threads.some(
      (thread) => thread.projectId === input.project.id && thread.deletedAt === null,
    ) ?? false;
  const projectSettings = resolveProjectSettings(
    serverConfig.settings,
    input.project.id,
    {
      defaultModelSelection: input.project.defaultModelSelection,
      ...(input.project.defaultThreadEnvMode === undefined
        ? {}
        : { defaultThreadEnvMode: input.project.defaultThreadEnvMode }),
    },
    readWorkspaceProjectFile(input.project.workspaceRoot),
  );
  const envMode =
    explicitBase === undefined
      ? resolveNewThreadEnvMode({
          projectSettings,
          workspaceRoot: input.project.workspaceRoot,
          newProjectsRoot: serverConfig.newProjectsRoot,
          projectHasThreads,
        })
      : "worktree";
  if (envMode === "local") {
    return localCheckout();
  }

  const baseBranch =
    explicitBase ?? (yield* configuredWorktreeBaseBranch(input.project.workspaceRoot));
  if (baseBranch === null) {
    return yield* Effect.fail(
      new T3SessionError(
        `No base branch for ${input.project.workspaceRoot}. The repository has no default branch.`,
      ),
    );
  }
  return {
    local: false,
    baseBranch,
    startFromOrigin: projectSettings.settings.newWorktreesStartFromOrigin,
  } satisfies LaunchWorkspace;
});

function localCheckout(): LaunchWorkspace {
  return { local: true, baseBranch: null, startFromOrigin: false };
}

function blankToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

/** Fields for `startTurnWithWorktree`. A main checkout omits the base branch. */
export function launchWorkspaceFields(workspace: LaunchWorkspace): {
  readonly local: boolean;
  readonly startFromOrigin: boolean;
  readonly baseBranch?: string;
} {
  return {
    local: workspace.local,
    startFromOrigin: workspace.startFromOrigin,
    ...(workspace.baseBranch === null ? {} : { baseBranch: workspace.baseBranch }),
  };
}

/** Missing or unreadable `t3.json` defers to the environment setting. */
function readWorkspaceProjectFile(workspaceRoot: string): T3ProjectFile | null {
  let contents: string;
  try {
    contents = NodeFS.readFileSync(NodePath.join(workspaceRoot, T3_PROJECT_FILE_NAME), "utf8");
  } catch {
    return null;
  }
  return parseT3ProjectFile(contents);
}

/**
 * First default ref in list order, else the current checkout branch.
 * `vcs.listRefs` sorts the default ref ahead of the rest, matching the composer picker.
 */
const configuredWorktreeBaseBranch = Effect.fn("configuredWorktreeBaseBranch")(function* (
  workspaceRoot: string,
) {
  const listed = yield* (yield* T3Session).listRefs(workspaceRoot);
  if (!listed.isRepo) return null;
  return worktreeBaseBranchFromRefs(listed.refs);
});

export function worktreeBaseBranchFromRefs(
  refs: ReadonlyArray<Pick<VcsRef, "name" | "isDefault" | "current">>,
): string | null {
  return refs.find((ref) => ref.isDefault)?.name ?? refs.find((ref) => ref.current)?.name ?? null;
}
