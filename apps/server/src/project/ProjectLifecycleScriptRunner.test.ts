import { describe, expect, it, vi } from "@effect/vitest";
import { type OrchestrationProject, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ProjectLifecycleScriptRunner from "./ProjectLifecycleScriptRunner.ts";

const okProcessOutput = (
  overrides: Partial<ProcessRunner.ProcessRunOutput> = {},
): ProcessRunner.ProcessRunOutput => ({
  stdout: "",
  stderr: "",
  code: ChildProcessSpawner.ExitCode(0),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
  ...overrides,
});

const isLifecycleFailed = Schema.is(ProjectLifecycleScriptRunner.ProjectLifecycleScriptFailedError);

const makeProject = (scripts: OrchestrationProject["scripts"]): OrchestrationProject => ({
  id: ProjectId.make("project-1"),
  title: "Project",
  workspaceRoot: "/repo/project",
  defaultModelSelection: null,
  scripts,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  deletedAt: null,
});

const makeProjectionSnapshotQueryLayer = (
  project: OrchestrationProject | null,
  options?: { readonly worktreePath?: string },
) =>
  Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
    getUserInputActivity: () => Effect.die("unused"),
    getCommandReadModel: () => Effect.die("unused"),
    getThreadRuntimeContext: () => Effect.die("unused"),
    getThreadActivitiesPage: () => Effect.die("unused"),
    getSnapshot: () => Effect.die("unused"),
    getShellSnapshot: () =>
      Effect.succeed({
        snapshotSequence: 1,
        projects: project ? [project] : [],
        threads:
          project && options?.worktreePath
            ? [
                {
                  id: "thread-1" as never,
                  projectId: project.id,
                  title: "Thread",
                  modelSelection: {
                    instanceId: "codex" as never,
                    model: "gpt",
                  },
                  runtimeMode: "full-access" as never,
                  interactionMode: "default" as never,
                  branch: null,
                  worktreePath: options.worktreePath,
                  latestTurn: null,
                  createdAt: "2026-01-01T00:00:00.000Z",
                  updatedAt: "2026-01-01T00:00:00.000Z",
                  archivedAt: null,
                  settledOverride: null,
                  settledAt: null,
                  session: null,
                  latestUserMessageAt: null,
                  hasPendingApprovals: false,
                  hasPendingUserInput: false,
                  hasActionableProposedPlan: false,
                },
              ]
            : [],
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    getArchivedShellSnapshot: () => Effect.die("unused"),
    getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 1 }),
    getCounts: () => Effect.die("unused"),
    getActiveProjectByWorkspaceRoot: (workspaceRoot) =>
      Effect.succeed(
        project && workspaceRoot === project.workspaceRoot ? Option.some(project) : Option.none(),
      ),
    getProjectShellById: (projectId) =>
      Effect.succeed(project && projectId === project.id ? Option.some(project) : Option.none()),
    getFirstActiveThreadIdByProjectId: () => Effect.die("unused"),
    getThreadCheckpointContext: () => Effect.die("unused"),
    getFullThreadDiffContext: () => Effect.die("unused"),
    getThreadShellById: () => Effect.die("unused"),
    getSessionStopContextById: () => Effect.die("unused"),
    getThreadDetailById: () => Effect.die("unused"),
    getThreadDetailSnapshot: () => Effect.die("unused"),
    searchThreads: () => Effect.succeed({ matches: [] }),
    getThreadLifecycleById: () => Effect.die("unused"),
    getEventReplayStats: () => Effect.die("unused"),
  });

const makeProcessRunnerLayer = (run: ProcessRunner.ProcessRunner["Service"]["run"]) =>
  Layer.succeed(ProcessRunner.ProcessRunner, { run });

const testLayer = (
  project: OrchestrationProject | null,
  run: ProcessRunner.ProcessRunner["Service"]["run"],
  options?: { readonly worktreePath?: string },
) =>
  ProjectLifecycleScriptRunner.layer.pipe(
    Layer.provideMerge(makeProjectionSnapshotQueryLayer(project, options)),
    Layer.provideMerge(makeProcessRunnerLayer(run)),
  );

describe("ProjectLifecycleScriptRunner", () => {
  it.effect("returns no-script when no teardown script exists", () => {
    const run = vi.fn(() => Effect.die("unexpected run"));
    const project = makeProject([]);

    return Effect.gen(function* () {
      const runner = yield* ProjectLifecycleScriptRunner.ProjectLifecycleScriptRunner;
      const result = yield* runner.runWorktreeRemove({
        projectCwd: "/repo/project",
        worktreePath: "/repo/worktrees/a",
      });
      expect(result).toEqual({ status: "no-script" });
      expect(run).not.toHaveBeenCalled();
    }).pipe(Effect.provide(testLayer(project, run)));
  });

  it.effect("returns no-script when no project can be resolved", () => {
    const run = vi.fn(() => Effect.die("unexpected run"));
    return Effect.gen(function* () {
      const runner = yield* ProjectLifecycleScriptRunner.ProjectLifecycleScriptRunner;
      const result = yield* runner.runWorktreeRemove({
        projectCwd: "/missing",
        worktreePath: "/repo/worktrees/a",
      });
      expect(result).toEqual({ status: "no-script" });
      expect(run).not.toHaveBeenCalled();
    }).pipe(Effect.provide(testLayer(null, run)));
  });

  it.effect("runs the worktree-remove script and waits for a successful exit", () => {
    const run = vi.fn(() => Effect.succeed(okProcessOutput({ stdout: "cleaned\n" })));
    const project = makeProject([
      {
        id: "teardown",
        name: "Teardown",
        command: "echo cleaned",
        icon: "configure",
        runOnWorktreeCreate: false,
        runOnWorktreeRemove: true,
      },
    ]);

    return Effect.gen(function* () {
      const runner = yield* ProjectLifecycleScriptRunner.ProjectLifecycleScriptRunner;
      const result = yield* runner.runWorktreeRemove({
        projectCwd: "/repo/project",
        worktreePath: "/repo/worktrees/a",
      });

      expect(result).toMatchObject({
        status: "completed",
        scriptId: "teardown",
        scriptName: "Teardown",
        lifecycle: "worktree-remove",
        exitCode: 0,
      });
      expect(run).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "sh",
          args: ["-c", "echo cleaned"],
          cwd: "/repo/worktrees/a",
          env: expect.objectContaining({
            T3CODE_PROJECT_ROOT: "/repo/project",
            T3CODE_WORKTREE_PATH: "/repo/worktrees/a",
            T3CODE_LIFECYCLE: "worktree-remove",
          }),
        }),
      );
    }).pipe(Effect.provide(testLayer(project, run)));
  });

  it.effect("fails when the lifecycle script exits non-zero", () => {
    const run = vi.fn(() =>
      Effect.succeed(
        okProcessOutput({
          stderr: "still running\n",
          code: ChildProcessSpawner.ExitCode(2),
        }),
      ),
    );
    const project = makeProject([
      {
        id: "teardown",
        name: "Teardown",
        command: "exit 2",
        icon: "configure",
        runOnWorktreeCreate: false,
        runOnWorktreeRemove: true,
      },
    ]);

    return Effect.gen(function* () {
      const runner = yield* ProjectLifecycleScriptRunner.ProjectLifecycleScriptRunner;
      const error = yield* runner
        .runWorktreeRemove({
          projectCwd: "/repo/project",
          worktreePath: "/repo/worktrees/a",
        })
        .pipe(Effect.flip);

      expect(isLifecycleFailed(error)).toBe(true);
      if (isLifecycleFailed(error)) {
        expect(error.exitCode).toBe(2);
        expect(error.scriptName).toBe("Teardown");
        expect(error.stderr).toContain("still running");
      }
    }).pipe(Effect.provide(testLayer(project, run)));
  });

  it.effect("runs the pr-merged lifecycle script when requested", () => {
    const run = vi.fn(() => Effect.succeed(okProcessOutput()));
    const project = makeProject([
      {
        id: "merged",
        name: "On merge",
        command: "echo reaped",
        icon: "configure",
        runOnWorktreeCreate: false,
        runOnPrMerged: true,
      },
    ]);

    return Effect.gen(function* () {
      const runner = yield* ProjectLifecycleScriptRunner.ProjectLifecycleScriptRunner;
      const result = yield* runner.runPrMerged({
        projectCwd: "/repo/project",
        worktreePath: "/repo/worktrees/a",
        pr: {
          number: 42,
          url: "https://github.com/org/repo/pull/42",
          title: "Ship it",
          baseRef: "main",
          headRef: "feature/x",
          state: "merged",
        },
      });
      expect(result.status).toBe("completed");
      expect(run).toHaveBeenCalledWith(
        expect.objectContaining({
          env: expect.objectContaining({
            T3CODE_LIFECYCLE: "pr-merged",
            T3CODE_PR: "https://github.com/org/repo/pull/42",
            T3CODE_PR_NUMBER: "42",
            T3CODE_PR_URL: "https://github.com/org/repo/pull/42",
            T3CODE_PR_TITLE: "Ship it",
            T3CODE_PR_BASE_REF: "main",
            T3CODE_PR_HEAD_REF: "feature/x",
            T3CODE_PR_STATE: "merged",
          }),
        }),
      );
    }).pipe(Effect.provide(testLayer(project, run)));
  });

  it.effect(
    "resolves the project via thread worktree path when cwd is not the workspace root",
    () => {
      const run = vi.fn(() => Effect.succeed(okProcessOutput()));
      const project = makeProject([
        {
          id: "merged",
          name: "On merge",
          command: "echo reaped",
          icon: "configure",
          runOnWorktreeCreate: false,
          runOnPrMerged: true,
        },
      ]);
      const worktreePath = "/repo/worktrees/a";

      return Effect.gen(function* () {
        const runner = yield* ProjectLifecycleScriptRunner.ProjectLifecycleScriptRunner;
        const result = yield* runner.runPrMerged({
          worktreePath,
        });
        expect(result.status).toBe("completed");
        expect(run).toHaveBeenCalledWith(
          expect.objectContaining({
            cwd: worktreePath,
            env: expect.objectContaining({
              T3CODE_PROJECT_ROOT: "/repo/project",
              T3CODE_WORKTREE_PATH: worktreePath,
            }),
          }),
        );
      }).pipe(Effect.provide(testLayer(project, run, { worktreePath })));
    },
  );
});
