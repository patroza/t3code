// Keep archive cleanup and unarchive restoration authoritative on the server, keyed by thread ID.
// Clients may preview the decision but never choose which path is removed or recreated.
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
  // Offer cleanup only for an active thread with a branch, restorable worktree path, and no other live path references.
  // Clients use the candidate only to decide whether confirmation is needed.
  readonly previewCleanup: (
    input: WorktreeCleanupThreadInput,
  ) => Effect.Effect<WorktreeCleanupPreviewResult, WorktreeLifecycleError>;

  // Under the per-path lock, recheck live references, stop users of the path, and remove only an orphaned worktree.
  // Keep its branch and refresh VCS; retained or already-missing paths return structured status.
  readonly cleanupThreadWorktree: (
    input: WorktreeCleanupThreadInput,
  ) => Effect.Effect<WorktreeCleanupResult, WorktreeLifecycleError>;

  // Restore a missing worktree from its retained branch under the cleanup lock before committing unarchive.
  // Failed restoration never dispatches the commit, so the thread stays archived.
  readonly restoreThreadWorktree: <A, E, R>(
    input: WorktreeCleanupThreadInput,
    commitUnarchive: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | WorktreeLifecycleError, R>;
}

/**
 * WorktreeLifecycle - Service tag for thread worktree lifecycle operations.
 */
export class WorktreeLifecycle extends Context.Service<WorktreeLifecycle, WorktreeLifecycleShape>()(
  "t3/orchestration-v2/WorktreeLifecycleService/WorktreeLifecycle",
) {}
