/**
 * ProjectLifecycleScriptRunner - runs blocking project lifecycle scripts
 * (worktree remove / PR merged) via a real process, waiting for exit before
 * the caller continues (e.g. `git worktree remove`).
 *
 * Unlike setup scripts (fire-and-forget in a terminal), teardown must finish
 * and succeed before filesystem teardown proceeds.
 *
 * @module ProjectLifecycleScriptRunner
 */
import { type ProjectScript, ProjectId } from "@t3tools/contracts";
import {
  prMergedProjectScript,
  projectLifecycleRuntimeEnv,
  type ProjectLifecycleKind,
  worktreeRemoveProjectScript,
} from "@t3tools/shared/projectScripts";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProcessRunner from "../processRunner.ts";

const LIFECYCLE_SCRIPT_TIMEOUT = "10 minutes";
const LIFECYCLE_SCRIPT_MAX_OUTPUT_BYTES = 1_024 * 1_024;

export interface ProjectLifecycleScriptRunnerResultNoScript {
  readonly status: "no-script";
}

export interface ProjectLifecycleScriptRunnerResultCompleted {
  readonly status: "completed";
  readonly scriptId: string;
  readonly scriptName: string;
  readonly lifecycle: ProjectLifecycleKind;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export type ProjectLifecycleScriptRunnerResult =
  | ProjectLifecycleScriptRunnerResultNoScript
  | ProjectLifecycleScriptRunnerResultCompleted;

export interface ProjectLifecycleScriptRunnerInput {
  readonly projectId?: string;
  readonly projectCwd?: string;
  readonly worktreePath: string;
}

export class ProjectLifecycleScriptOperationError extends Schema.TaggedErrorClass<ProjectLifecycleScriptOperationError>()(
  "ProjectLifecycleScriptOperationError",
  {
    lifecycle: Schema.Literals(["worktree-remove", "pr-merged"]),
    projectId: Schema.optional(Schema.String),
    projectCwd: Schema.optional(Schema.String),
    worktreePath: Schema.String,
    operation: Schema.Literals(["resolveProject", "runScript"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Project lifecycle script operation '${this.operation}' failed for '${this.lifecycle}' in '${this.worktreePath}'.`;
  }
}

export class ProjectLifecycleScriptFailedError extends Schema.TaggedErrorClass<ProjectLifecycleScriptFailedError>()(
  "ProjectLifecycleScriptFailedError",
  {
    lifecycle: Schema.Literals(["worktree-remove", "pr-merged"]),
    projectId: Schema.optional(Schema.String),
    projectCwd: Schema.optional(Schema.String),
    worktreePath: Schema.String,
    scriptId: Schema.String,
    scriptName: Schema.String,
    exitCode: Schema.NullOr(Schema.Number),
    timedOut: Schema.Boolean,
    stdout: Schema.String,
    stderr: Schema.String,
  },
) {
  override get message(): string {
    if (this.timedOut) {
      return `Lifecycle script '${this.scriptName}' (${this.lifecycle}) timed out in '${this.worktreePath}'.`;
    }
    const code = this.exitCode === null ? "unknown" : String(this.exitCode);
    return `Lifecycle script '${this.scriptName}' (${this.lifecycle}) exited with code ${code} in '${this.worktreePath}'.`;
  }
}

export const ProjectLifecycleScriptRunnerError = Schema.Union([
  ProjectLifecycleScriptOperationError,
  ProjectLifecycleScriptFailedError,
]);
export type ProjectLifecycleScriptRunnerError = typeof ProjectLifecycleScriptRunnerError.Type;

export class ProjectLifecycleScriptRunner extends Context.Service<
  ProjectLifecycleScriptRunner,
  {
    readonly runWorktreeRemove: (
      input: ProjectLifecycleScriptRunnerInput,
    ) => Effect.Effect<ProjectLifecycleScriptRunnerResult, ProjectLifecycleScriptRunnerError>;
    readonly runPrMerged: (
      input: ProjectLifecycleScriptRunnerInput,
    ) => Effect.Effect<ProjectLifecycleScriptRunnerResult, ProjectLifecycleScriptRunnerError>;
  }
>()("t3/project/ProjectLifecycleScriptRunner") {}

const selectScript = (
  lifecycle: ProjectLifecycleKind,
  scripts: readonly ProjectScript[],
): ProjectScript | null =>
  lifecycle === "worktree-remove"
    ? worktreeRemoveProjectScript(scripts)
    : prMergedProjectScript(scripts);

export const make = Effect.gen(function* () {
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const platform = yield* HostProcessPlatform;
  const hostEnvironment = yield* HostProcessEnvironment;

  const resolveProject = Effect.fn("ProjectLifecycleScriptRunner.resolveProject")(function* (
    input: ProjectLifecycleScriptRunnerInput,
    lifecycle: ProjectLifecycleKind,
  ) {
    const errorContext = {
      lifecycle,
      worktreePath: input.worktreePath,
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      ...(input.projectCwd === undefined ? {} : { projectCwd: input.projectCwd }),
    };
    const projectById = input.projectId
      ? yield* projectionSnapshotQuery.getProjectShellById(ProjectId.make(input.projectId)).pipe(
          Effect.map(Option.getOrUndefined),
          Effect.mapError(
            (cause) =>
              new ProjectLifecycleScriptOperationError({
                ...errorContext,
                operation: "resolveProject",
                cause,
              }),
          ),
        )
      : null;
    if (projectById) {
      return projectById;
    }
    if (!input.projectCwd) {
      return null;
    }
    return yield* projectionSnapshotQuery.getActiveProjectByWorkspaceRoot(input.projectCwd).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.mapError(
        (cause) =>
          new ProjectLifecycleScriptOperationError({
            ...errorContext,
            operation: "resolveProject",
            cause,
          }),
      ),
    );
  });

  const runLifecycle = Effect.fn("ProjectLifecycleScriptRunner.runLifecycle")(function* (
    input: ProjectLifecycleScriptRunnerInput,
    lifecycle: ProjectLifecycleKind,
  ) {
    const errorContext = {
      lifecycle,
      worktreePath: input.worktreePath,
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      ...(input.projectCwd === undefined ? {} : { projectCwd: input.projectCwd }),
    };

    const project = yield* resolveProject(input, lifecycle);
    if (!project) {
      // Bare VCS removes (no T3 project) skip lifecycle scripts rather than failing.
      return { status: "no-script" } as const;
    }
    const script = selectScript(lifecycle, project.scripts);
    if (!script) {
      return { status: "no-script" } as const;
    }

    const lifecycleEnv = projectLifecycleRuntimeEnv({
      project: { cwd: project.workspaceRoot },
      worktreePath: input.worktreePath,
      lifecycle,
    });
    const env: NodeJS.ProcessEnv = {
      ...hostEnvironment,
      ...lifecycleEnv,
    };

    const isWindows = platform === "win32";
    const output = yield* processRunner
      .run({
        command: isWindows ? "cmd.exe" : "sh",
        args: isWindows ? ["/d", "/s", "/c", script.command] : ["-c", script.command],
        cwd: input.worktreePath,
        env,
        timeout: LIFECYCLE_SCRIPT_TIMEOUT,
        outputMode: "truncate",
        maxOutputBytes: LIFECYCLE_SCRIPT_MAX_OUTPUT_BYTES,
        truncatedMarker: "\n…[truncated]\n",
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ProjectLifecycleScriptOperationError({
              ...errorContext,
              operation: "runScript",
              cause,
            }),
        ),
      );

    if (output.timedOut || output.code === null || output.code !== 0) {
      return yield* new ProjectLifecycleScriptFailedError({
        ...errorContext,
        scriptId: script.id,
        scriptName: script.name,
        exitCode: output.code,
        timedOut: output.timedOut,
        stdout: output.stdout,
        stderr: output.stderr,
      });
    }

    return {
      status: "completed",
      scriptId: script.id,
      scriptName: script.name,
      lifecycle,
      exitCode: output.code,
      stdout: output.stdout,
      stderr: output.stderr,
    } as const;
  });

  return ProjectLifecycleScriptRunner.of({
    runWorktreeRemove: (input) => runLifecycle(input, "worktree-remove"),
    runPrMerged: (input) => runLifecycle(input, "pr-merged"),
  });
});

export const layer = Layer.effect(ProjectLifecycleScriptRunner, make);
