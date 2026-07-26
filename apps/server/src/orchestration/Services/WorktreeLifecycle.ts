/**
 * WorktreeLifecycle - Server-authoritative worktree cleanup and restoration.
 *
 * Owns the archive-time cleanup decision (preview + conditional removal) and
 * the unarchive-time restoration of a missing worktree. All operations are
 * keyed by thread id so clients never make the final safety decision about
 * which path is removed or recreated.
 *
 * @module WorktreeLifecycle
 */
import type {
  ThreadId,
  WorktreeCleanupPreviewResult,
  WorktreeCleanupResult,
  WorktreeLifecycleError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export interface WorktreeCleanupThreadInput {
  readonly threadId: ThreadId;
}

/**
 * WorktreeLifecycleShape - Service API for thread worktree lifecycle.
 */
export interface WorktreeLifecycleShape {
  /**
   * Decide whether archiving this thread would orphan its worktree.
   *
   * Returns a candidate only when the thread is active, has both a branch
   * and a worktree path (so removal stays restorable), and no other active
   * nondeleted thread references the same normalized path. Clients use this
   * only to decide whether to show the confirmation prompt.
   */
  readonly previewCleanup: (
    input: WorktreeCleanupThreadInput,
  ) => Effect.Effect<WorktreeCleanupPreviewResult, WorktreeLifecycleError>;

  /**
   * Force-remove the archived thread's worktree if it is still orphaned.
   *
   * Re-reads all nondeleted references under a per-path lock before
   * removing, stops provider sessions and closes terminals that could still
   * use the path, keeps the branch, and refreshes VCS status. Returns a
   * structured status instead of failing when the worktree is retained or
   * already missing.
   */
  readonly cleanupThreadWorktree: (
    input: WorktreeCleanupThreadInput,
  ) => Effect.Effect<WorktreeCleanupResult, WorktreeLifecycleError>;

  /**
   * Recreate a missing worktree before committing a thread unarchive.
   *
   * Runs `commitUnarchive` unchanged when no restoration is needed. When the
   * recorded worktree path is missing, the worktree is recreated from the
   * retained branch at the original path while holding the same per-path
   * lock used by cleanup, and the commit is dispatched under that lock. If
   * recreation fails the commit never runs, so the thread stays archived.
   */
  readonly restoreThreadWorktree: <A, E, R>(
    input: WorktreeCleanupThreadInput,
    commitUnarchive: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | WorktreeLifecycleError, R>;
}

/**
 * WorktreeLifecycle - Service tag for thread worktree lifecycle operations.
 */
export class WorktreeLifecycle extends Context.Service<WorktreeLifecycle, WorktreeLifecycleShape>()(
  "t3/orchestration/Services/WorktreeLifecycle",
) {}
