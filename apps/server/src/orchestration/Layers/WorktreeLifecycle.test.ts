import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WorktreeLifecycleError,
  type ModelSelection,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

import { ServerConfig } from "../../config.ts";
import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import { ProjectionThreadRepositoryLive } from "../../persistence/Layers/ProjectionThreads.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  ProjectionThreadRepository,
  type ProjectionThread,
} from "../../persistence/Services/ProjectionThreads.ts";
import { ProjectSetupScriptRunner } from "../../project/ProjectSetupScriptRunner.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { WorktreeLifecycle } from "../Services/WorktreeLifecycle.ts";
import { WorktreeLifecycleLive } from "./WorktreeLifecycle.ts";

const isWorktreeLifecycleError = Schema.is(WorktreeLifecycleError);

const now = "2026-03-01T00:00:00.000Z";
const projectId = ProjectId.make("project-1");
const modelSelection: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5-codex",
};

interface HarnessRefs {
  workspaceRoot: string;
  readonly stopSessionCalls: Array<string>;
  readonly terminalCloseCalls: Array<string>;
  readonly setupScriptCalls: Array<{ readonly threadId: string; readonly worktreePath: string }>;
  removeWorktreeStarted: Deferred.Deferred<void> | null;
  removeWorktreeRelease: Deferred.Deferred<void> | null;
}

const makeRefs = (): HarnessRefs => ({
  workspaceRoot: "",
  stopSessionCalls: [],
  terminalCloseCalls: [],
  setupScriptCalls: [],
  removeWorktreeStarted: null,
  removeWorktreeRelease: null,
});

const emptyVcsStatus = {
  isRepo: true,
  hasPrimaryRemote: false,
  isDefaultRef: false,
  refName: null,
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
  hasUpstream: false,
  aheadCount: 0,
  behindCount: 0,
  pr: null,
};

const gitWorkflowFromDriver = (refs: HarnessRefs) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const driver = yield* GitVcsDriver.GitVcsDriver;
      return Layer.mock(GitWorkflowService)({
        createWorktree: (input) => driver.createWorktree(input),
        removeWorktree: (input) =>
          Effect.gen(function* () {
            if (refs.removeWorktreeStarted) {
              yield* Deferred.succeed(refs.removeWorktreeStarted, undefined);
            }
            if (refs.removeWorktreeRelease) {
              yield* Deferred.await(refs.removeWorktreeRelease);
            }
            yield* driver.removeWorktree(input);
          }),
      });
    }),
  );

const makeTestLayer = (refs: HarnessRefs) =>
  WorktreeLifecycleLive.pipe(
    Layer.provideMerge(ProjectionThreadRepositoryLive),
    Layer.provideMerge(
      Layer.mock(ProjectionSnapshotQuery)({
        getProjectShellById: (id) =>
          Effect.sync(() =>
            id === projectId && refs.workspaceRoot.length > 0
              ? Option.some({
                  id: projectId,
                  title: "Project 1",
                  workspaceRoot: refs.workspaceRoot,
                  repositoryIdentity: null,
                  defaultModelSelection: modelSelection,
                  scripts: [],
                  createdAt: now,
                  updatedAt: now,
                })
              : Option.none(),
          ),
      }),
    ),
    Layer.provideMerge(
      Layer.mock(ProviderService)({
        stopSession: ({ threadId }) =>
          Effect.sync(() => {
            refs.stopSessionCalls.push(threadId);
          }),
      }),
    ),
    Layer.provideMerge(
      Layer.mock(TerminalManager.TerminalManager)({
        close: (input) =>
          Effect.sync(() => {
            refs.terminalCloseCalls.push(input.threadId);
          }),
      }),
    ),
    Layer.provideMerge(
      Layer.mock(VcsStatusBroadcaster)({
        refreshStatus: () => Effect.succeed(emptyVcsStatus),
      }),
    ),
    Layer.provideMerge(
      Layer.mock(ProjectSetupScriptRunner)({
        runForThread: (input) =>
          Effect.sync(() => {
            refs.setupScriptCalls.push({
              threadId: input.threadId,
              worktreePath: input.worktreePath,
            });
            return { status: "no-script" } as const;
          }),
      }),
    ),
    Layer.provideMerge(gitWorkflowFromDriver(refs)),
    Layer.provideMerge(
      GitVcsDriver.layer.pipe(
        Layer.provide(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-worktree-lifecycle-config-" }),
        ),
      ),
    ),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  );

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const result = yield* driver.execute({
      operation: "WorktreeLifecycle.test.git",
      cwd,
      args,
      timeoutMs: 10_000,
    });
    return result.stdout.trim();
  });

/** Creates a real repo with an initial commit plus a feature-branch worktree. */
const setupRepoWithWorktree = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const driver = yield* GitVcsDriver.GitVcsDriver;

  const repoDir = yield* fileSystem.makeTempDirectoryScoped({
    prefix: "t3-worktree-lifecycle-repo-",
  });
  yield* driver.initRepo({ cwd: repoDir });
  yield* git(repoDir, ["config", "user.email", "test@test.com"]);
  yield* git(repoDir, ["config", "user.name", "Test"]);
  yield* fileSystem.writeFileString(pathService.join(repoDir, "README.md"), "# test\n");
  yield* git(repoDir, ["add", "."]);
  yield* git(repoDir, ["-c", "commit.gpgsign=false", "commit", "-m", "initial commit"]);
  const initialBranch = yield* git(repoDir, ["branch", "--show-current"]);

  const worktreesDir = yield* fileSystem.makeTempDirectoryScoped({
    prefix: "t3-worktree-lifecycle-wt-",
  });
  const worktreePath = pathService.join(worktreesDir, "feature-1");
  yield* driver.createWorktree({
    cwd: repoDir,
    refName: initialBranch,
    newRefName: "feature-1",
    path: worktreePath,
  });

  return { repoDir, worktreePath, initialBranch, branch: "feature-1" };
});

const makeThreadRow = (input: {
  readonly threadId: string;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly archivedAt?: string | null;
  readonly deletedAt?: string | null;
}): ProjectionThread => ({
  threadId: ThreadId.make(input.threadId),
  projectId,
  title: `Thread ${input.threadId}`,
  modelSelection,
  runtimeMode: "full-access",
  interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
  branch: input.branch,
  worktreePath: input.worktreePath,
  latestTurnId: null,
  createdAt: now,
  updatedAt: now,
  archivedAt: input.archivedAt ?? null,
  settledOverride: null,
  settledAt: null,
  snoozedUntil: null,
  snoozedAt: null,
  latestUserMessageAt: null,
  pendingApprovalCount: 0,
  pendingUserInputCount: 0,
  hasActionableProposedPlan: 0,
  deletedAt: input.deletedAt ?? null,
});

const seedThreads = (rows: ReadonlyArray<ProjectionThread>) =>
  Effect.gen(function* () {
    const repository = yield* ProjectionThreadRepository;
    yield* Effect.forEach(rows, (row) => repository.upsert(row), { discard: true });
  });

const runWithHarness = <A, E>(
  refs: HarnessRefs,
  body: Effect.Effect<
    A,
    E,
    | WorktreeLifecycle
    | ProjectionThreadRepository
    | GitVcsDriver.GitVcsDriver
    | FileSystem.FileSystem
    | Path.Path
    | Scope.Scope
  >,
) => Effect.scoped(body).pipe(Effect.provide(makeTestLayer(refs)));

it.effect("preview returns a candidate for the only active worktree thread", () => {
  const refs = makeRefs();
  return runWithHarness(
    refs,
    Effect.gen(function* () {
      const lifecycle = yield* WorktreeLifecycle;
      const repo = yield* setupRepoWithWorktree;
      refs.workspaceRoot = repo.repoDir;
      yield* seedThreads([
        makeThreadRow({ threadId: "t1", branch: repo.branch, worktreePath: repo.worktreePath }),
      ]);

      const preview = yield* lifecycle.previewCleanup({ threadId: ThreadId.make("t1") });
      assert.deepStrictEqual(preview.candidate, {
        worktreePath: repo.worktreePath,
        branch: repo.branch,
      });
    }),
  );
});

it.effect("preview returns no candidate when another active thread shares the path", () => {
  const refs = makeRefs();
  return runWithHarness(
    refs,
    Effect.gen(function* () {
      const lifecycle = yield* WorktreeLifecycle;
      const repo = yield* setupRepoWithWorktree;
      refs.workspaceRoot = repo.repoDir;
      yield* seedThreads([
        makeThreadRow({ threadId: "t1", branch: repo.branch, worktreePath: repo.worktreePath }),
        makeThreadRow({ threadId: "t2", branch: repo.branch, worktreePath: repo.worktreePath }),
      ]);

      const preview = yield* lifecycle.previewCleanup({ threadId: ThreadId.make("t1") });
      assert.isNull(preview.candidate);
    }),
  );
});

it.effect("archived and deleted siblings do not prevent a candidate", () => {
  const refs = makeRefs();
  return runWithHarness(
    refs,
    Effect.gen(function* () {
      const lifecycle = yield* WorktreeLifecycle;
      const repo = yield* setupRepoWithWorktree;
      refs.workspaceRoot = repo.repoDir;
      yield* seedThreads([
        makeThreadRow({ threadId: "t1", branch: repo.branch, worktreePath: repo.worktreePath }),
        makeThreadRow({
          threadId: "t2",
          branch: repo.branch,
          worktreePath: repo.worktreePath,
          archivedAt: now,
        }),
        makeThreadRow({
          threadId: "t3",
          branch: repo.branch,
          worktreePath: repo.worktreePath,
          deletedAt: now,
        }),
      ]);

      const preview = yield* lifecycle.previewCleanup({ threadId: ThreadId.make("t1") });
      assert.deepStrictEqual(preview.candidate, {
        worktreePath: repo.worktreePath,
        branch: repo.branch,
      });
    }),
  );
});

it.effect("preview treats different normalized spellings of the path as one worktree", () => {
  const refs = makeRefs();
  return runWithHarness(
    refs,
    Effect.gen(function* () {
      const lifecycle = yield* WorktreeLifecycle;
      const repo = yield* setupRepoWithWorktree;
      refs.workspaceRoot = repo.repoDir;
      yield* seedThreads([
        makeThreadRow({ threadId: "t1", branch: repo.branch, worktreePath: repo.worktreePath }),
        // Same worktree spelled with a trailing separator.
        makeThreadRow({
          threadId: "t2",
          branch: repo.branch,
          worktreePath: `${repo.worktreePath}/`,
        }),
      ]);

      const preview = yield* lifecycle.previewCleanup({ threadId: ThreadId.make("t1") });
      assert.isNull(preview.candidate);
    }),
  );
});

it.effect("preview returns no candidate without a retained branch", () => {
  const refs = makeRefs();
  return runWithHarness(
    refs,
    Effect.gen(function* () {
      const lifecycle = yield* WorktreeLifecycle;
      const repo = yield* setupRepoWithWorktree;
      refs.workspaceRoot = repo.repoDir;
      yield* seedThreads([
        makeThreadRow({ threadId: "t1", branch: null, worktreePath: repo.worktreePath }),
      ]);

      const preview = yield* lifecycle.previewCleanup({ threadId: ThreadId.make("t1") });
      assert.isNull(preview.candidate);
    }),
  );
});

it.effect(
  "cleanup force-removes a dirty worktree, preserves the branch, and stops archived runtimes",
  () => {
    const refs = makeRefs();
    return runWithHarness(
      refs,
      Effect.gen(function* () {
        const lifecycle = yield* WorktreeLifecycle;
        const fileSystem = yield* FileSystem.FileSystem;
        const pathService = yield* Path.Path;
        const repo = yield* setupRepoWithWorktree;
        refs.workspaceRoot = repo.repoDir;
        yield* seedThreads([
          makeThreadRow({
            threadId: "t1",
            branch: repo.branch,
            worktreePath: repo.worktreePath,
            archivedAt: now,
          }),
          makeThreadRow({
            threadId: "t2",
            branch: repo.branch,
            worktreePath: repo.worktreePath,
            archivedAt: now,
          }),
        ]);
        // Make the worktree dirty so a non-forced removal would fail.
        yield* fileSystem.writeFileString(
          pathService.join(repo.worktreePath, "dirty.txt"),
          "uncommitted\n",
        );

        const result = yield* lifecycle.cleanupThreadWorktree({ threadId: ThreadId.make("t1") });
        assert.strictEqual(result.status, "removed");
        assert.strictEqual(yield* fileSystem.exists(repo.worktreePath), false);
        // The branch survives removal so the worktree stays restorable.
        const branches = yield* git(repo.repoDir, ["branch", "--list", repo.branch]);
        assert.include(branches, repo.branch);
        // Every archived reference had its runtime stopped.
        assert.sameMembers(refs.stopSessionCalls, ["t1", "t2"]);
        assert.sameMembers(refs.terminalCloseCalls, ["t1", "t2"]);
      }),
    );
  },
);

it.effect("cleanup is retained when a reference becomes active after preview", () => {
  const refs = makeRefs();
  return runWithHarness(
    refs,
    Effect.gen(function* () {
      const lifecycle = yield* WorktreeLifecycle;
      const fileSystem = yield* FileSystem.FileSystem;
      const repo = yield* setupRepoWithWorktree;
      refs.workspaceRoot = repo.repoDir;
      yield* seedThreads([
        makeThreadRow({
          threadId: "t1",
          branch: repo.branch,
          worktreePath: repo.worktreePath,
          archivedAt: now,
        }),
        // Unarchived (active) sibling appeared between preview and cleanup.
        makeThreadRow({ threadId: "t2", branch: repo.branch, worktreePath: repo.worktreePath }),
      ]);

      const result = yield* lifecycle.cleanupThreadWorktree({ threadId: ThreadId.make("t1") });
      assert.strictEqual(result.status, "retained-active");
      assert.strictEqual(yield* fileSystem.exists(repo.worktreePath), true);
      assert.lengthOf(refs.stopSessionCalls, 0);
    }),
  );
});

it.effect("cleanup is retained when the target thread itself became active again", () => {
  const refs = makeRefs();
  return runWithHarness(
    refs,
    Effect.gen(function* () {
      const lifecycle = yield* WorktreeLifecycle;
      const fileSystem = yield* FileSystem.FileSystem;
      const repo = yield* setupRepoWithWorktree;
      refs.workspaceRoot = repo.repoDir;
      yield* seedThreads([
        makeThreadRow({ threadId: "t1", branch: repo.branch, worktreePath: repo.worktreePath }),
      ]);

      const result = yield* lifecycle.cleanupThreadWorktree({ threadId: ThreadId.make("t1") });
      assert.strictEqual(result.status, "retained-active");
      assert.strictEqual(yield* fileSystem.exists(repo.worktreePath), true);
    }),
  );
});

it.effect("cleanup reports an already-missing path without failing", () => {
  const refs = makeRefs();
  return runWithHarness(
    refs,
    Effect.gen(function* () {
      const lifecycle = yield* WorktreeLifecycle;
      const fileSystem = yield* FileSystem.FileSystem;
      const repo = yield* setupRepoWithWorktree;
      refs.workspaceRoot = repo.repoDir;
      yield* seedThreads([
        makeThreadRow({
          threadId: "t1",
          branch: repo.branch,
          worktreePath: repo.worktreePath,
          archivedAt: now,
        }),
      ]);
      yield* fileSystem.remove(repo.worktreePath, { recursive: true });

      const result = yield* lifecycle.cleanupThreadWorktree({ threadId: ThreadId.make("t1") });
      assert.strictEqual(result.status, "already-missing");
    }),
  );
});

it.effect("cleanup failures surface as a typed WorktreeLifecycleError", () => {
  const refs = makeRefs();
  return runWithHarness(
    refs,
    Effect.gen(function* () {
      const lifecycle = yield* WorktreeLifecycle;
      const fileSystem = yield* FileSystem.FileSystem;
      const repo = yield* setupRepoWithWorktree;
      refs.workspaceRoot = repo.repoDir;
      // Points at an existing directory that is not a registered worktree, so
      // `git worktree remove` fails.
      const bogusPath = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-worktree-lifecycle-bogus-",
      });
      yield* seedThreads([
        makeThreadRow({
          threadId: "t1",
          branch: repo.branch,
          worktreePath: bogusPath,
          archivedAt: now,
        }),
      ]);

      const result = yield* Effect.flip(
        lifecycle.cleanupThreadWorktree({ threadId: ThreadId.make("t1") }),
      );
      assert.isTrue(isWorktreeLifecycleError(result));
      assert.strictEqual(result.operation, "cleanup");
    }),
  );
});

it.effect("unarchive restoration recreates a missing worktree and runs the setup script", () => {
  const refs = makeRefs();
  return runWithHarness(
    refs,
    Effect.gen(function* () {
      const lifecycle = yield* WorktreeLifecycle;
      const fileSystem = yield* FileSystem.FileSystem;
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const repository = yield* ProjectionThreadRepository;
      const repo = yield* setupRepoWithWorktree;
      refs.workspaceRoot = repo.repoDir;
      const row = makeThreadRow({
        threadId: "t1",
        branch: repo.branch,
        worktreePath: repo.worktreePath,
        archivedAt: now,
      });
      yield* seedThreads([row]);
      yield* driver.removeWorktree({ cwd: repo.repoDir, path: repo.worktreePath, force: true });
      assert.strictEqual(yield* fileSystem.exists(repo.worktreePath), false);

      let committed = false;
      const commit = repository.upsert({ ...row, archivedAt: null }).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            committed = true;
          }),
        ),
        Effect.as({ sequence: 1 }),
      );
      const result = yield* lifecycle.restoreThreadWorktree({ threadId: row.threadId }, commit);
      assert.deepStrictEqual(result, { sequence: 1 });
      assert.isTrue(committed);
      assert.strictEqual(yield* fileSystem.exists(repo.worktreePath), true);
      const worktrees = yield* git(repo.repoDir, ["worktree", "list", "--porcelain"]);
      assert.include(worktrees, repo.worktreePath);
      const branchInWorktree = yield* git(repo.worktreePath, ["branch", "--show-current"]);
      assert.strictEqual(branchInWorktree, repo.branch);
      assert.deepStrictEqual(refs.setupScriptCalls, [
        { threadId: "t1", worktreePath: repo.worktreePath },
      ]);
    }),
  );
});

it.effect("unarchive restoration is a no-op when the worktree still exists", () => {
  const refs = makeRefs();
  return runWithHarness(
    refs,
    Effect.gen(function* () {
      const lifecycle = yield* WorktreeLifecycle;
      const repo = yield* setupRepoWithWorktree;
      refs.workspaceRoot = repo.repoDir;
      const row = makeThreadRow({
        threadId: "t1",
        branch: repo.branch,
        worktreePath: repo.worktreePath,
        archivedAt: now,
      });
      yield* seedThreads([row]);

      let committed = false;
      const commit = Effect.sync(() => {
        committed = true;
        return { sequence: 1 };
      });
      yield* lifecycle.restoreThreadWorktree({ threadId: row.threadId }, commit);
      assert.isTrue(committed);
      assert.lengthOf(refs.setupScriptCalls, 0);
    }),
  );
});

it.effect("failed recreation leaves the thread archived and never commits", () => {
  const refs = makeRefs();
  return runWithHarness(
    refs,
    Effect.gen(function* () {
      const lifecycle = yield* WorktreeLifecycle;
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const repo = yield* setupRepoWithWorktree;
      refs.workspaceRoot = repo.repoDir;
      const row = makeThreadRow({
        threadId: "t1",
        branch: repo.branch,
        worktreePath: repo.worktreePath,
        archivedAt: now,
      });
      yield* seedThreads([row]);
      yield* driver.removeWorktree({ cwd: repo.repoDir, path: repo.worktreePath, force: true });
      // Delete the branch so recreation cannot succeed.
      yield* git(repo.repoDir, ["branch", "-D", repo.branch]);

      let committed = false;
      const commit = Effect.sync(() => {
        committed = true;
        return { sequence: 1 };
      });
      const error = yield* Effect.flip(
        lifecycle.restoreThreadWorktree({ threadId: row.threadId }, commit),
      );
      assert.isTrue(isWorktreeLifecycleError(error));
      assert.strictEqual((error as WorktreeLifecycleError).operation, "restore");
      assert.isFalse(committed);
      assert.lengthOf(refs.setupScriptCalls, 0);
    }),
  );
});

it.effect("concurrent cleanup and unarchive restoration serialize on the worktree lock", () => {
  const refs = makeRefs();
  return runWithHarness(
    refs,
    Effect.gen(function* () {
      const lifecycle = yield* WorktreeLifecycle;
      const fileSystem = yield* FileSystem.FileSystem;
      const repository = yield* ProjectionThreadRepository;
      const repo = yield* setupRepoWithWorktree;
      refs.workspaceRoot = repo.repoDir;
      const row = makeThreadRow({
        threadId: "t1",
        branch: repo.branch,
        worktreePath: repo.worktreePath,
        archivedAt: now,
      });
      yield* seedThreads([row]);

      refs.removeWorktreeStarted = yield* Deferred.make<void>();
      refs.removeWorktreeRelease = yield* Deferred.make<void>();

      const cleanupFiber = yield* lifecycle
        .cleanupThreadWorktree({ threadId: row.threadId })
        .pipe(Effect.forkScoped);
      // Cleanup holds the per-path lock and is mid-removal.
      yield* Deferred.await(refs.removeWorktreeStarted);

      const commit = repository.upsert({ ...row, archivedAt: null }).pipe(Effect.asVoid);
      const restoreFiber = yield* lifecycle
        .restoreThreadWorktree({ threadId: row.threadId }, commit)
        .pipe(Effect.forkScoped);
      yield* Deferred.succeed(refs.removeWorktreeRelease, undefined);

      const cleanupResult = yield* Fiber.join(cleanupFiber);
      yield* Fiber.join(restoreFiber);

      // Restoration only ran after the removal finished: it saw the missing
      // path and recreated the worktree instead of skipping restoration
      // against a doomed checkout.
      assert.strictEqual(cleanupResult.status, "removed");
      assert.strictEqual(yield* fileSystem.exists(repo.worktreePath), true);
      const restored = yield* repository.getById({ threadId: row.threadId });
      assert.isTrue(Option.isSome(restored) && restored.value.archivedAt === null);
      assert.deepStrictEqual(refs.setupScriptCalls, [
        { threadId: "t1", worktreePath: repo.worktreePath },
      ]);
    }),
  );
});
