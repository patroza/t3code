import type { ProjectId, ProjectScript, ServerSettings } from "@t3tools/contracts";

/** Missing entries preserve existing actions; null explicitly resets a checkout to machine defaults. */
export function resolveProjectScripts(
  settings: Pick<ServerSettings, "defaultProjectScripts" | "projectScriptOverrides">,
  project: { id: ProjectId; scripts: readonly ProjectScript[] },
): readonly ProjectScript[] {
  const override = settings.projectScriptOverrides[project.id];
  if (override === null) return settings.defaultProjectScripts;
  return (
    override ?? (project.scripts.length > 0 ? project.scripts : settings.defaultProjectScripts)
  );
}

export function projectScriptsInheritDefaults(
  settings: Pick<ServerSettings, "projectScriptOverrides">,
  project: { id: ProjectId; scripts: readonly ProjectScript[] },
): boolean {
  const override = settings.projectScriptOverrides[project.id];
  return override === null || (override === undefined && project.scripts.length === 0);
}

interface ProjectScriptRuntimeEnvInput {
  project: {
    cwd: string;
  };
  worktreePath?: string | null;
  extraEnv?: Record<string, string>;
}

export function projectScriptCwd(input: {
  project: {
    cwd: string;
  };
  worktreePath?: string | null;
}): string {
  return input.worktreePath ?? input.project.cwd;
}

export function projectScriptRuntimeEnv(
  input: ProjectScriptRuntimeEnvInput,
): Record<string, string> {
  const env: Record<string, string> = {
    T3CODE_PROJECT_ROOT: input.project.cwd,
  };
  if (input.worktreePath) {
    env.T3CODE_WORKTREE_PATH = input.worktreePath;
  }
  if (input.extraEnv) {
    return { ...env, ...input.extraEnv };
  }
  return env;
}

export function setupProjectScript(scripts: readonly ProjectScript[]): ProjectScript | null {
  return scripts.find((script) => script.runOnWorktreeCreate) ?? null;
}

export function worktreeRemoveProjectScript(
  scripts: readonly ProjectScript[],
): ProjectScript | null {
  return scripts.find((script) => script.runOnWorktreeRemove === true) ?? null;
}

export function prMergedProjectScript(scripts: readonly ProjectScript[]): ProjectScript | null {
  return scripts.find((script) => script.runOnPrMerged === true) ?? null;
}

export type ProjectLifecycleKind = "worktree-remove" | "pr-merged";

/** Change request (PR/MR) associated with a lifecycle run, when known. */
export interface ProjectLifecyclePrAssociation {
  readonly number: number;
  readonly url: string;
  readonly title?: string | null;
  readonly baseRef?: string | null;
  readonly headRef?: string | null;
  readonly state?: string | null;
}

/**
 * Env for the linked PR/MR. `T3CODE_PR` is the primary handle (URL preferred).
 */
export function projectLifecyclePrEnv(
  pr: ProjectLifecyclePrAssociation | null | undefined,
): Record<string, string> {
  if (!pr) {
    return {};
  }
  const url = pr.url.trim();
  const env: Record<string, string> = {
    T3CODE_PR: url.length > 0 ? url : String(pr.number),
    T3CODE_PR_NUMBER: String(pr.number),
  };
  if (url.length > 0) {
    env.T3CODE_PR_URL = url;
  }
  const title = pr.title?.trim();
  if (title) {
    env.T3CODE_PR_TITLE = title;
  }
  const baseRef = pr.baseRef?.trim();
  if (baseRef) {
    env.T3CODE_PR_BASE_REF = baseRef;
  }
  const headRef = pr.headRef?.trim();
  if (headRef) {
    env.T3CODE_PR_HEAD_REF = headRef;
  }
  const state = pr.state?.trim();
  if (state) {
    env.T3CODE_PR_STATE = state;
  }
  return env;
}

export function projectLifecycleRuntimeEnv(input: {
  project: { cwd: string };
  worktreePath: string;
  lifecycle: ProjectLifecycleKind;
  pr?: ProjectLifecyclePrAssociation | null;
  /** @deprecated Prefer `pr`. */
  prNumber?: number | null;
  /** @deprecated Prefer `pr`. */
  prUrl?: string | null;
  extraEnv?: Record<string, string>;
}): Record<string, string> {
  const pr =
    input.pr ??
    (input.prNumber !== undefined && input.prNumber !== null
      ? {
          number: input.prNumber,
          url: input.prUrl?.trim() ?? "",
        }
      : null);
  return projectScriptRuntimeEnv({
    project: input.project,
    worktreePath: input.worktreePath,
    extraEnv: {
      T3CODE_LIFECYCLE: input.lifecycle,
      ...projectLifecyclePrEnv(pr),
      ...input.extraEnv,
    },
  });
}
