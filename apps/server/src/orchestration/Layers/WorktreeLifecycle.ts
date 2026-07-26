import { WorktreeLifecycleError, type ThreadId } from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as SynchronizedRef from "effect/SynchronizedRef";

import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import {
  ProjectionThreadRepository,
  type ProjectionThread,
  type ProjectionThreadWorktreeReference,
} from "../../persistence/Services/ProjectionThreads.ts";
import { ProjectSetupScriptRunner } from "../../project/ProjectSetupScriptRunner.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { WorktreeLifecycle, type WorktreeLifecycleShape } from "../Services/WorktreeLifecycle.ts";

// Best-effort cleanup steps must not surface their own error types through
// the lifecycle API: swallow and log everything except interruption.
const swallowCauseUnlessInterrupted = <A, E, R>(input: {
  readonly effect: Effect.Effect<A, E, R>;
  readonly message: string;
  readonly threadId: ThreadId;
}): Effect.Effect<void, never, R> =>
  input.effect.pipe(
    Effect.asVoid,
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) {
        return Effect.failCause(cause as Cause.Cause<never>);
      }
      return Effect.logDebug(input.message, {
        threadId: input.threadId,
        cause: Cause.pretty(cause),
      });
    }),
  );

function nonEmptyOrNull(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

const make = Effect.gen(function* () {
  const threadRepository = yield* ProjectionThreadRepository;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const gitWorkflow = yield* GitWorkflowService;
  const providerService = yield* ProviderService;
  const terminalManager = yield* TerminalManager.TerminalManager;
  const vcsStatusBroadcaster = yield* VcsStatusBroadcaster;
  const setupScriptRunner = yield* ProjectSetupScriptRunner;
  const fileSystem = yield* FileSystem.FileSystem;

  // Conditional removal and unarchive restoration serialize on the same
  // per-normalized-path lock so a cleanup can never interleave with a
  // restoration of the same worktree.
  const pathLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
  const getPathSemaphore = (pathKey: string) =>
    SynchronizedRef.modifyEffect(pathLocksRef, (current) => {
      const existing: Option.Option<Semaphore.Semaphore> = Option.fromNullishOr(
        current.get(pathKey),
      );
      return Option.match(existing, {
        onNone: () =>
          Semaphore.make(1).pipe(
            Effect.map((semaphore) => {
              const next = new Map(current);
              next.set(pathKey, semaphore);
              return [semaphore, next] as const;
            }),
          ),
        onSome: (semaphore) => Effect.succeed([semaphore, current] as const),
      });
    });
  const withWorktreePathLock = <A, E, R>(pathKey: string, effect: Effect.Effect<A, E, R>) =>
    Effect.flatMap(getPathSemaphore(pathKey), (semaphore) => semaphore.withPermit(effect));

  const lifecycleError = (input: {
    readonly operation: string;
    readonly threadId: ThreadId;
    readonly detail: string;
    readonly cause?: unknown;
  }) =>
    new WorktreeLifecycleError({
      operation: input.operation,
      threadId: input.threadId,
      detail: input.detail,
      ...(input.cause !== undefined ? { cause: input.cause } : {}),
    });

  const loadNondeletedThreadRow = (operation: string, threadId: ThreadId) =>
    threadRepository.getById({ threadId }).pipe(
      Effect.mapError((cause) =>
        lifecycleError({ operation, threadId, detail: "Failed to load thread state.", cause }),
      ),
      Effect.map(Option.filter((row: ProjectionThread) => row.deletedAt === null)),
    );

  const listWorktreeReferences = (operation: string, threadId: ThreadId) =>
    threadRepository.listWorktreeReferences().pipe(
      Effect.mapError((cause) =>
        lifecycleError({
          operation,
          threadId,
          detail: "Failed to load worktree references.",
          cause,
        }),
      ),
    );

  const referencesForPath = (
    references: ReadonlyArray<ProjectionThreadWorktreeReference>,
    normalizedPath: string,
  ) =>
    references.filter(
      (reference) => normalizeProjectPathForComparison(reference.worktreePath) === normalizedPath,
    );

  const requireProjectWorkspaceRoot = (input: {
    readonly operation: string;
    readonly thread: ProjectionThread;
  }) =>
    projectionSnapshotQuery.getProjectShellById(input.thread.projectId).pipe(
      Effect.mapError((cause) =>
        lifecycleError({
          operation: input.operation,
          threadId: input.thread.threadId,
          detail: "Failed to load the thread's project.",
          cause,
        }),
      ),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              lifecycleError({
                operation: input.operation,
                threadId: input.thread.threadId,
                detail: "The thread's project was not found.",
              }),
            ),
          onSome: (project) => Effect.succeed(project.workspaceRoot),
        }),
      ),
    );

  const stopThreadRuntime = (threadId: ThreadId) =>
    swallowCauseUnlessInterrupted({
      effect: providerService.stopSession({ threadId }),
      message: "worktree cleanup skipped provider session stop",
      threadId,
    }).pipe(
      Effect.andThen(
        swallowCauseUnlessInterrupted({
          effect: terminalManager.close({ threadId }),
          message: "worktree cleanup skipped terminal close",
          threadId,
        }),
      ),
    );

  const refreshVcsStatus = (workspaceRoot: string) =>
    vcsStatusBroadcaster
      .refreshStatus(workspaceRoot)
      .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach, Effect.asVoid);

  const worktreePathExists = (input: {
    readonly operation: string;
    readonly threadId: ThreadId;
    readonly worktreePath: string;
  }) =>
    fileSystem.exists(input.worktreePath).pipe(
      Effect.mapError((cause) =>
        lifecycleError({
          operation: input.operation,
          threadId: input.threadId,
          detail: `Failed to inspect the worktree path ${input.worktreePath}.`,
          cause,
        }),
      ),
    );

  const previewCleanup: WorktreeLifecycleShape["previewCleanup"] = Effect.fn(
    "WorktreeLifecycle.previewCleanup",
  )(function* ({ threadId }) {
    const operation = "cleanup preview";
    const threadRow = yield* loadNondeletedThreadRow(operation, threadId);
    if (Option.isNone(threadRow)) {
      return { candidate: null };
    }
    const thread = threadRow.value;
    const worktreePath = nonEmptyOrNull(thread.worktreePath);
    const branch = nonEmptyOrNull(thread.branch);
    // Only an active thread with a restorable worktree (path + retained
    // branch) can produce a candidate.
    if (thread.archivedAt !== null || worktreePath === null || branch === null) {
      return { candidate: null };
    }

    const normalizedPath = normalizeProjectPathForComparison(worktreePath);
    const references = yield* listWorktreeReferences(operation, threadId);
    const sharedWithActiveThread = referencesForPath(references, normalizedPath).some(
      (reference) => reference.threadId !== threadId && reference.archivedAt === null,
    );

    return {
      candidate: sharedWithActiveThread ? null : { worktreePath, branch },
    };
  });

  const cleanupThreadWorktree: WorktreeLifecycleShape["cleanupThreadWorktree"] = Effect.fn(
    "WorktreeLifecycle.cleanupThreadWorktree",
  )(function* ({ threadId }) {
    const operation = "cleanup";
    const threadRow = yield* loadNondeletedThreadRow(operation, threadId);
    if (Option.isNone(threadRow)) {
      return yield* lifecycleError({ operation, threadId, detail: "The thread was not found." });
    }
    const thread = threadRow.value;
    const worktreePath = nonEmptyOrNull(thread.worktreePath);
    if (worktreePath === null) {
      return yield* lifecycleError({
        operation,
        threadId,
        detail: "The thread has no worktree path recorded.",
      });
    }
    // A thread that was unarchived between confirmation and cleanup is an
    // active reference again, not an error.
    if (thread.archivedAt === null) {
      return { status: "retained-active", worktreePath } as const;
    }

    const workspaceRoot = yield* requireProjectWorkspaceRoot({ operation, thread });
    const normalizedPath = normalizeProjectPathForComparison(worktreePath);

    return yield* withWorktreePathLock(
      normalizedPath,
      Effect.gen(function* () {
        // Mandatory recheck under the lock: another client may have
        // unarchived or attached a thread since the preview.
        const references = referencesForPath(
          yield* listWorktreeReferences(operation, threadId),
          normalizedPath,
        );
        if (references.some((reference) => reference.archivedAt === null)) {
          return { status: "retained-active", worktreePath } as const;
        }

        // Every remaining reference is archived; make sure none of them
        // still runs a provider session or terminal inside the worktree.
        const threadIdsToStop = new Set<ThreadId>([
          threadId,
          ...references.map((reference) => reference.threadId),
        ]);
        yield* Effect.forEach(threadIdsToStop, stopThreadRuntime, { discard: true });

        const exists = yield* worktreePathExists({ operation, threadId, worktreePath });
        if (!exists) {
          return { status: "already-missing", worktreePath } as const;
        }

        yield* gitWorkflow
          .removeWorktree({ cwd: workspaceRoot, path: worktreePath, force: true })
          .pipe(
            Effect.mapError((cause) =>
              lifecycleError({
                operation,
                threadId,
                detail: `Failed to remove the worktree at ${worktreePath}: ${cause.detail}`,
                cause,
              }),
            ),
          );

        // Compensate for unavoidable external races: if an active reference
        // appeared while the removal ran, recreate the worktree from the
        // retained branch at the original path.
        const postRemovalReferences = referencesForPath(
          yield* listWorktreeReferences(operation, threadId),
          normalizedPath,
        );
        if (postRemovalReferences.some((reference) => reference.archivedAt === null)) {
          const branch = nonEmptyOrNull(thread.branch);
          if (branch === null) {
            return yield* lifecycleError({
              operation,
              threadId,
              detail: `The worktree at ${worktreePath} was removed while another thread became active, and no branch is recorded to recreate it.`,
            });
          }
          yield* gitWorkflow
            .createWorktree({ cwd: workspaceRoot, refName: branch, path: worktreePath })
            .pipe(
              Effect.mapError((cause) =>
                lifecycleError({
                  operation,
                  threadId,
                  detail: `Failed to recreate the worktree at ${worktreePath} after another thread became active.`,
                  cause,
                }),
              ),
            );
          yield* refreshVcsStatus(workspaceRoot);
          return { status: "retained-active", worktreePath } as const;
        }

        yield* refreshVcsStatus(workspaceRoot);
        return { status: "removed", worktreePath } as const;
      }),
    );
  });

  const restoreThreadWorktree: WorktreeLifecycleShape["restoreThreadWorktree"] = <A, E, R>(
    { threadId }: { readonly threadId: ThreadId },
    commitUnarchive: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | WorktreeLifecycleError, R> =>
    Effect.gen(function* () {
      const operation = "restore";
      const threadRow = yield* loadNondeletedThreadRow(operation, threadId);
      if (Option.isNone(threadRow)) {
        // Let the dispatch path produce its canonical "unknown thread" error.
        return yield* commitUnarchive;
      }
      const thread = threadRow.value;
      const worktreePath = nonEmptyOrNull(thread.worktreePath);
      if (worktreePath === null) {
        return yield* commitUnarchive;
      }

      const normalizedPath = normalizeProjectPathForComparison(worktreePath);
      return yield* withWorktreePathLock(
        normalizedPath,
        Effect.gen(function* () {
          const exists = yield* worktreePathExists({ operation, threadId, worktreePath });
          if (exists) {
            return yield* commitUnarchive;
          }

          const branch = nonEmptyOrNull(thread.branch);
          if (branch === null) {
            return yield* lifecycleError({
              operation,
              threadId,
              detail: `The worktree at ${worktreePath} is missing and no branch is recorded to recreate it. The thread stays archived.`,
            });
          }

          const workspaceRoot = yield* requireProjectWorkspaceRoot({ operation, thread });
          yield* gitWorkflow
            .createWorktree({ cwd: workspaceRoot, refName: branch, path: worktreePath })
            .pipe(
              Effect.mapError((cause) =>
                lifecycleError({
                  operation,
                  threadId,
                  detail: `Failed to recreate the worktree at ${worktreePath} from branch '${branch}': ${cause.detail}. The thread stays archived.`,
                  cause,
                }),
              ),
            );
          yield* refreshVcsStatus(workspaceRoot);

          const result = yield* commitUnarchive;

          // The checkout was recreated from scratch, so dependencies and
          // generated files are gone: run the worktree setup script again.
          yield* swallowCauseUnlessInterrupted({
            effect: setupScriptRunner.runForThread({
              threadId,
              projectId: thread.projectId,
              worktreePath,
            }),
            message: "worktree restoration could not start the setup script",
            threadId,
          });

          return result;
        }),
      );
    });

  return {
    previewCleanup,
    cleanupThreadWorktree,
    restoreThreadWorktree,
  } satisfies WorktreeLifecycleShape;
});

export const WorktreeLifecycleLive = Layer.effect(WorktreeLifecycle, make);
