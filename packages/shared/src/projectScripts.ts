import type { ProjectScript } from "@t3tools/contracts";

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

export function projectLifecycleRuntimeEnv(input: {
  project: { cwd: string };
  worktreePath: string;
  lifecycle: ProjectLifecycleKind;
  extraEnv?: Record<string, string>;
}): Record<string, string> {
  return projectScriptRuntimeEnv({
    project: input.project,
    worktreePath: input.worktreePath,
    extraEnv: {
      T3CODE_LIFECYCLE: input.lifecycle,
      ...(input.extraEnv ?? {}),
    },
  });
}
