# Archived Worktree Cleanup Plan

## Goal

Offer to remove a worktree when the user archives the final active thread using it, while preserving archived threads well enough to recreate the worktree if one is later unarchived.

## Agreed Behavior

- Prompt only when archiving the final non-archived thread associated with a worktree.
- Use the same generic confirmation behavior as the current thread deletion flow.
- If the user confirms, force-remove the worktree after the archive succeeds.
- If the user declines, archive the thread and leave the worktree unchanged.
- Keep the branch when removing the worktree.
- Recreate a missing worktree at its original path when a thread is unarchived.
- Attempt cleanup only as part of the final archive. Do not add a startup sweep, delayed retention, or periodic cleanup.
- Treat soft-deleted threads as non-references when deciding whether every remaining thread is archived.

## Current-State Findings

- Worktrees are not first-class persisted entities. Threads store nullable `branch` and `worktreePath` values.
- Multiple threads can intentionally share one worktree.
- Active and archived threads are returned by separate snapshot queries.
- The existing web deletion flow checks only client-side active thread state before offering worktree deletion.
- Mobile has no worktree cleanup flow.
- `vcs.removeWorktree` accepts a client-provided path and does not check thread references.
- `git worktree remove` leaves the branch in place, which makes later recreation possible.
- Archive currently retains `branch` and `worktreePath`.
- Archive dispatches a session-stop command after the thread has disappeared from active-only projection queries. The real provider reactor can therefore skip the stop, so cleanup must not be added until that path is corrected.

## Design

### Server-Authoritative Preview

Add a narrow RPC that accepts a `threadId` and returns an optional cleanup candidate.

The server should:

1. Load the target thread, including nondeleted archived records where required.
2. Require a non-null branch and worktree path so removal remains restorable.
3. Compare normalized worktree paths across all nondeleted thread projections.
4. Return the worktree path only when the target is active and no other active thread references that path.

Clients use this response only to decide whether to show the confirmation prompt. They must not make the final safety decision.

### Conditional Cleanup

Add a second RPC that accepts the archived `threadId` rather than a client-provided repository root and path.

The server should:

1. Resolve the project workspace root, branch, and worktree path from persisted state.
2. Require the target thread to be archived and nondeleted.
3. Re-read all nondeleted references to the normalized worktree path.
4. Return a retained result if any reference is active.
5. Ensure the provider session and terminals no longer use the worktree.
6. Force-remove the worktree, as explicitly selected in the prompt.
7. Refresh VCS status for the project.
8. Return a structured result such as `removed`, `retained-active`, or `already-missing`.

The second check is mandatory because another client may unarchive or attach a thread between preview, confirmation, and removal.

### Unarchive Restoration

Before committing `thread.unarchive`, the server should:

1. Load the archived thread and its project.
2. If `worktreePath` is null, continue normally.
3. If the path exists, continue normally.
4. If the path is missing, require a retained branch and recreate the worktree at the original path.
5. Dispatch unarchive only after recreation succeeds.
6. Refresh VCS status.
7. Run the configured worktree creation setup script again because dependencies and generated files were removed with the checkout.

If recreation fails, leave the thread archived and return an actionable error. Do not silently detach it to the main project checkout.

### Concurrency

Use a per-worktree-path semaphore in the server lifecycle service.

- Conditional removal and unarchive restoration must use the same lock.
- Recheck active references while holding the lock immediately before removal.
- Hold the lock through worktree recreation and unarchive dispatch.
- Recheck after removal and compensate by recreating the worktree if an active reference appeared during an unavoidable external race.

### Archive Runtime Cleanup

Fix provider shutdown before enabling physical cleanup.

The current provider stop reactor resolves thread detail through an active-only query. Add a narrow projection query for session-stop context that includes archived, nondeleted threads, or otherwise make session stopping independent of active-shell visibility.

The archive flow must ensure:

- A non-stopped provider session is actually stopped.
- Session projection reaches `stopped`.
- Thread terminals are closed.
- Worktree removal cannot start while a provider still uses that cwd.

## Client Changes

### Web

Update `apps/web/src/hooks/useThreadActions.ts`:

1. Ask the server for a cleanup preview before dispatching archive.
2. If eligible, show the existing-style confirmation with the formatted final path segment.
3. Archive regardless of whether the user declines cleanup.
4. After successful archive, call conditional cleanup only when the user confirmed.
5. Show a nonfatal toast if the thread archived but worktree cleanup failed or was retained because another thread became active.

Bulk archive remains sequential. Each item should request a fresh server preview, so earlier successful archives are visible immediately without depending on client shell propagation.

### Mobile

Update `apps/mobile/src/features/home/useThreadListActions.ts`:

1. Use the same preview RPC before archive.
2. Present the confirmation through `Alert.alert` on iOS and `ConfirmDialogHost` elsewhere.
3. Preserve the current archive guard for an active turn.
4. Archive on decline and archive-plus-cleanup on confirmation.
5. Report cleanup failures without presenting the archive itself as failed.

## Server and Contract Changes

Expected areas:

- `packages/contracts/src/rpc.ts`
- A focused worktree lifecycle contract in `packages/contracts/src/git.ts` or `packages/contracts/src/orchestration.ts`
- `packages/client-runtime/src/state/vcs.ts` or a focused orchestration command module
- `apps/server/src/persistence/Services/ProjectionThreads.ts`
- `apps/server/src/persistence/Layers/ProjectionThreads.ts`
- `apps/server/src/orchestration/Services/ProjectionSnapshotQuery.ts`
- `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts`
- A new server worktree lifecycle service and layer
- `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts`
- `apps/server/src/ws.ts`
- Server layer composition and test layers

Keep the query lightweight. A repository method can load nondeleted rows with worktree paths and compare them using the shared path normalization helper. This avoids introducing a worktree table solely for this feature while still handling legacy path spellings more safely than raw client-side string equality.

## Existing Deletion Flow

Do not expand this change into a deletion redesign. Keep the current deletion prompt behavior, but reuse display formatting and server lifecycle primitives where that reduces duplication without changing deletion semantics.

## Tests

### Server

- Preview returns a candidate for one active worktree thread.
- Preview returns no candidate when another active thread shares the path.
- Archived siblings do not prevent a candidate.
- Deleted siblings do not prevent a candidate.
- Different normalized spellings of the same path are treated as one worktree.
- Cleanup removes a worktree when all nondeleted references are archived.
- Cleanup is retained when a reference becomes active after preview.
- Cleanup force-removes a dirty worktree after confirmation.
- Cleanup preserves the branch.
- Cleanup reports an already-missing path without failing the archive.
- Cleanup failures leave the thread archived and return a typed error.
- Unarchive recreates a missing worktree from the retained branch at the retained path.
- Unarchive starts the worktree setup script after recreation.
- Recreation failure leaves the thread archived.
- Concurrent cleanup and unarchive serialize correctly.
- Real archive-to-provider-reactor coverage proves the provider session stops and its projection reaches `stopped`.

### Web

- Final active reference prompts for worktree removal.
- A shared active worktree does not prompt.
- Declining archives without cleanup.
- Confirming archives and requests conditional cleanup.
- Archive success plus cleanup failure is reported as a cleanup-only failure.
- Sequential bulk archive prompts only when each worktree reaches its final active reference.

### Mobile

- Final active reference displays the platform-appropriate prompt.
- Decline and confirm paths preserve the agreed behavior.
- Cleanup failures do not report the completed archive as failed.
- Unarchive restoration errors are surfaced.

## Verification

Run the smallest focused checks for changed packages and files:

- Focused server tests for projection queries, lifecycle service, provider reactor, and RPC handling.
- Focused contract and client-runtime tests.
- Focused web hook and sidebar tests.
- Focused mobile action tests.
- Targeted formatting, lint, and type checks for affected packages.
- One integrated web verification pass using the `test-t3-app` skill.
- One integrated mobile verification pass using the `test-t3-mobile` skill.

Do not run the repository-wide test or typecheck suites as a routine local verification step.
