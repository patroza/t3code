import {
  type ChatAttachment,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  type MessageId,
  OrchestrationCommand,
  type OrchestrationEvent,
  type ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import type * as NTBS from "./lifecycle.ts";
import { Context, Crypto, Data, DateTime, Effect } from "effect";
import type { NTBSAdapter, NTBSResponse } from "./adapter.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { ProjectSetupScriptRunner } from "../project/ProjectSetupScriptRunner.ts";
import { getAutoBootstrapDefaultModelSelection } from "../serverRuntimeStartup.ts";
import { DEFAULT_THREAD_TITLE } from "@t3tools/shared/threadTitle";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";
import { setInputType } from "effect/Schedule";

/*
  NTBS architecture:

  1. Generic NTBS processor:
    - Runs the shared workflow for every platform.
    - Creates a fresh worktree and T3 thread.
    - Saves `ThreadStarted`.
    - Starts the first turn with the snapshot and attachments.
    - Monitors the turn for completion and timeouts.
    - Attempts to post the acknowledgement independently.
    - Watches T3 events for completed work.
    - Posts the final result through the adapter and saves `ResponsePosted`.
    - Archives the T3 thread after its response has been recorded.

  2. Platform-specific inbound code:
    - Receives raw platform data from Jira, Discord, GitHub, or Teams.
    - Applies platform trigger and actor checks.
    - Builds `NTBSInput<P>` and `T3Context`.
    - Calls the processor.

  3. Adapter
    - Owns platform storage and platform API calls.
    - Posts acknowledgements and responses.
    - Knows how platform identifiers are represented.
    - Knows nothing about creating T3 threads or interpreting T3 events.
*/

export type T3Context = {
  readonly projectId: ProjectId;
  /**
   * The starting point for the thread's worktree: the new branch is created
   * from this ref.
   *
   * Usually a branch name such as `main`. Before use it is resolved against
   * `origin`, so the worktree starts from the latest remote commit even when
   * the local copy of the branch is behind. A commit SHA is also accepted and
   * is used as-is.
   *
   * Set by the platform-specific inbound code.
   */
  readonly baseRef: string;
};

export class NTBSProcessorError extends Data.TaggedError("NTBSProcessorError")<{
  reason: string;
  cause: unknown;
}> {}

export interface NTBSProcessor<P extends NTBS.PlatformData> {
  /**
   * Processes a request received by a platform adapter.
   *
   * The request must already have passed its platform-specific trigger and actor
   * checks. The processor does not perform those.
   *
   * Accepts concurrent requests and applies no queue, concurrency cap
   * or backpressure for the time being. This choice can be reviewed later.
   */
  readonly process: (
    request: NTBS.NTBSInput<P>,
    t3Context: T3Context,
  ) => Effect.Effect<void, NTBSProcessorError>;

  /**
   * Consumes T3 events and passes them to `processT3Event`.
   *
   * After the live subscription begins, loads stored `ThreadStarted` records
   * and restarts their monitors from each turn's original `requestedAt` time.
   *
   * Runs until interrupted by its caller.
   * Logs individual processing failures and continues with later events.
   */
  readonly subscribeToT3Events: Effect.Effect<void>;
}

export const makeNTBSProcessorTag = <P extends NTBS.PlatformData>(key: string) =>
  Context.Service<NTBSProcessor<P>>(key);

type NTBSProcessorRequirements =
  /*
    Dispatches thread creation and turn-start commands.
    Provides the T3 event stream used to detect outcomes.
   */
  | OrchestrationEngineService
  /*
    Loads the selected T3 project and reads thread outcomes and archive state.
  */
  | ProjectionSnapshotQuery
  /*
    Creates the isolated branch and worktree for each external request.
  */
  | GitWorkflowService
  /*
    Runs the project setup scripts in the newly created worktree before agent work begins.
  */
  | ProjectSetupScriptRunner
  /*
    Generates unique identifiers for the new thread, message, commands, and worktree branch.
   */
  | Crypto.Crypto;

/**
 * Starts the first turn in an existing T3 thread.
 *
 * Uses the user message ID recorded in `ThreadStarted` so the resulting turn
 * and response can be matched to the external request.
 */
declare const startT3Turn: (
  threadId: ThreadId,
  userMessageId: MessageId,
  snapshot: string,
  attachments: ReadonlyArray<ChatAttachment>,
) => Effect.Effect<void, NTBSProcessorError>;

/**
 * Monitors one started T3 turn without blocking request processing.
 *
 * Starts in the background immediately after `startT3Turn` succeeds. It checks
 * the turn 30 minutes after its original `requestedAt` time, then checks again
 * at 45 minutes if it is still running. Startup recovery restarts this monitor
 * from the original `requestedAt` time rather than resetting the deadline.
 *
 * If the turn is still running after 45 minutes, interrupts it, waits for T3 to
 * confirm it stopped, posts a timeout response, and records `ResponsePosted`.
 * The timed-out thread remains unarchived for inspection or manual retry.
 */
declare const monitorT3Turn: <P extends NTBS.PlatformData>(
  state: NTBS.ThreadStarted<P>,
) => Effect.Effect<void, NTBSProcessorError>;

/**
 * Provider runtimes (like Claude Code) emit `turn.completed` events.
 * T3 consumes those internally and exposes the resulting session change through a `thread.session-set` event.
 *
 * Native T3 clients can react by refreshing the thread projection.
 * External NTBS adapters do not consume T3 projections automatically, so they must read the thread state themselves.
 *
 * This function reads the projected thread identified by the session event.
 * It finds the recorded user message, then resolves the response from that
 * message's turn rather than whichever turn happens to be latest.
 * It returns `null` if that turn has not ended.
 * Otherwise it returns the response and its type.
 */
declare const resolveT3Outcome: (
  event: Extract<OrchestrationEvent, { type: "thread.session-set" }>,
  userMessageId: MessageId,
) => Effect.Effect<
  { readonly threadId: ThreadId; readonly response: NTBSResponse } | null,
  NTBSProcessorError
>;

/**
 * Archives a T3 thread after its external response has been recorded.
 *
 * Returns successfully when the thread is already archived. A failure can be
 * retried without posting the external response again.
 * Timed-out threads are left unarchived for inspection or manual retry.
 */
declare const archiveT3Thread: (threadId: ThreadId) => Effect.Effect<void, NTBSProcessorError>;

/**
 * Handles T3 events that may indicate that a turn has ended.
 *
 * 1. Ignore events other than `thread.session-set`.
 * 2. Find the adapter record by thread ID.
 * 3. Stop if no record exists.
 * 4. Stop if the response was already posted.
 * 5. Resolve the T3 outcome and stop if the turn has not ended.
 * 6. Post the response.
 * 7. Record `ResponsePosted`.
 * 8. Archive the T3 thread.
 */
declare const processT3Event: (
  event: OrchestrationEvent,
) => Effect.Effect<void, NTBSProcessorError>;

/**
 * Creates an NTBS processor for one adapter.
 *
 * Resolves the required T3 services and returns processor operations with no remaining requirements.
 */
export const makeNTBSProcessor = <P extends NTBS.PlatformData>(
  adapter: NTBSAdapter<P>,
): Effect.Effect<NTBSProcessor<P>, never, NTBSProcessorRequirements> =>
  Effect.gen(function* () {
    const orFail = (reason: string) =>
      Effect.mapError((cause: unknown) => new NTBSProcessorError({ reason, cause }));

    const crypto = yield* Crypto.Crypto;
    const randomUUID = crypto.randomUUIDv4.pipe(orFail("Failed creating a UUID v4"));

    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;

    const gitWorkflowService = yield* GitWorkflowService;

    /**
     * Resolves where a new thread worktree starts from.
     *
     * Fetches `origin` and prefers the remote state of `baseRef`, so a branch name resolves to its latest remote commit even when the local copy is behind.
     *
     * When no remote branch with that name exists
     * (a commit SHA, a tag, a local-only branch, or no reachable remote),
     * the ref is returned as-is for git to resolve during worktree creation.
     *
     * Never fails: an unresolvable ref surfaces later as a worktree-creation error,
     * which carries the real git cause.
     *
     */
    const resolveWorktreeBase = (input: {
      readonly cwd: string;
      readonly baseRef: string;
    }): Effect.Effect<{ readonly refName: string; readonly baseRefName: string | null }> =>
      Effect.gen(function* () {
        // A failed fetch only means we resolve against the last-known remote state
        // The tracking ref may still exist locally
        yield* gitWorkflowService
          .fetchRemote({
            cwd: input.cwd,
            remoteName: "origin",
          })
          .pipe(
            Effect.catch((cause) =>
              Effect.logDebug("NTBS fetch of origin failed; resolving against local state.", {
                cwd: input.cwd,
                cause,
              }),
            ),
          );

        return yield* gitWorkflowService
          .resolveRemoteTrackingCommit({
            cwd: input.cwd,
            refName: input.baseRef,
            fallbackRemoteName: "origin",
          })
          .pipe(
            Effect.map((resolved) => ({
              refName: resolved.commitSha,
              baseRefName: input.baseRef,
            })),
            Effect.catch((cause) =>
              Effect.logDebug("NTBS base ref is not a remote branch; using it as-is", {
                baseRef: input.baseRef,
                cwd: input.cwd,
                cause,
              }).pipe(
                Effect.as({
                  refName: input.baseRef,
                  baseRefName: null,
                }),
              ),
            ),
          );
      });

    const orchestrationEngineService = yield* OrchestrationEngineService;

    const projectScriptRunner = yield* ProjectSetupScriptRunner;

    const inFlightRequests = new Set<string>();

    /**
     * Creates an isolated worktree and a new T3 thread.
     *
     * Uses the supplied project and base ref. The thread starts with T3's default
     * title, the project's default model or T3's fallback model, `full-access`
     * runtime mode, and `default` interaction mode.
     *
     * Does not start a turn, read platform data or call the adapter.
     *
     * The final title of the thread is generated by T3 after the first turn starts.
     */
    const createT3Thread = (t3Context: T3Context): Effect.Effect<ThreadId, NTBSProcessorError> =>
      Effect.gen(function* () {
        const maybeProject = yield* projectionSnapshotQuery
          .getProjectShellById(t3Context.projectId)
          .pipe(orFail("Could not load the T3 Project."));

        const project = yield* Effect.fromOption(maybeProject).pipe(
          orFail(`T3 project ${t3Context.projectId} does not exist.`),
        );

        const threadUUID = yield* randomUUID;
        const threadId = ThreadId.make(threadUUID);

        const createdAt = DateTime.formatIso(yield* DateTime.now);
        // TODO: Resolve the title in a better way
        const title = DEFAULT_THREAD_TITLE;
        const modelSelection =
          project.defaultModelSelection ?? getAutoBootstrapDefaultModelSelection();

        const commandId = CommandId.make(yield* randomUUID);

        // create the isolated branch and worktree
        const branchName = buildTemporaryWorktreeBranchName(() => threadUUID);

        const base = yield* resolveWorktreeBase({
          cwd: project.workspaceRoot,
          baseRef: t3Context.baseRef,
        });

        const gitWorktree = yield* gitWorkflowService
          .createWorktree({
            cwd: project.workspaceRoot,
            refName: base.refName,
            ...(base.baseRefName !== null
              ? {
                  baseRefName: base.baseRefName,
                }
              : {}),
            newRefName: branchName,
            path: null,
            // we run setup scripts later
            deferDependencyInstall: true,
          })
          .pipe(orFail("Could not create the T3 worktree"));

        yield* orchestrationEngineService
          .dispatch(
            OrchestrationCommand.make({
              type: "thread.create",
              branch: gitWorktree.worktree.refName,
              worktreePath: gitWorktree.worktree.path,
              threadId: threadId,
              title: title,
              modelSelection: modelSelection,
              commandId: commandId,
              createdAt: createdAt,
              projectId: project.id,
              runtimeMode: "full-access",
              interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            }),
          )
          .pipe(
            /*
              Removes the worktree, but deliberately not its temporary
              branch: GitWorkflowService has no branch-delete operation
              (branch retention is an invariant of the thread worktree 
              lifecycle — see WorktreeLifecycle.cleanupThreadWorktree), so
              the orphaned `t3/wt-…` ref is an accepted leak. It is a
              dangling ref to an existing commit and costs nothing beyond
              ref-listing noise.
            */
            Effect.onError(() =>
              gitWorkflowService
                .removeWorktree({
                  path: gitWorktree.worktree.path,
                  cwd: project.workspaceRoot,
                  /* We also want garbage collection, we cannot rely
                     on the directory to be pristine.
                  */
                  force: true,
                })
                .pipe(
                  Effect.catch((cleanupErr) =>
                    Effect.logWarning(
                      "Failed to remove worktree after thread.create did not complete",
                      {
                        threadId,
                        path: gitWorktree.worktree.path,
                        cause: cleanupErr,
                      },
                    ),
                  ),
                ),
            ),
            orFail("Failed to create a T3 thread"),
          );

        yield* projectScriptRunner
          .runForThread({
            threadId,
            projectId: project.id,
            projectCwd: project.workspaceRoot,
            worktreePath: gitWorktree.worktree.path,
          })
          .pipe(
            Effect.catch((err) =>
              Effect.logWarning("NTBS thread setup script failed.", {
                threadId,
                cause: err,
              }),
            ),
          );

        return threadId;
      });

    /*
      Handles an external request in this order:

      1. Ask the adapter whether this platform request already has a recorded
      `ThreadStarted` or `ResponsePosted`.
      If yes - stop. . If no - continue
      2. Create the worktree and T3 thread.
      3. Generate the first user message ID and record it with ThreadStarted.
      4. Start the first T3 turn with that message ID, the snapshot, and attachments.
      5. Start monitoring the turn in the background.
      6. Attempt to post the acknowledgement independently.
    */

    const processAdapterRequest = (request: NTBS.NTBSInput<P>, t3Context: T3Context) =>
      Effect.gen(function* () {
        /*
          In-flight dedup first. We check if the processor is *currently*
          working on this very request: it's being worked right now.
          Later we check for the *durable* dedup: are we receiving a request 
          for work that has *already* completed.
        */
        const key = adapter.getRequestKey(request);

        const isBeingWorkedNow = inFlightRequests.has(key);
        if (isBeingWorkedNow) {
          yield* Effect.logDebug("NTBS request already being worked on; dropping duplicate", {
            key,
          });
          return;
        }
        inFlightRequests.add(key);

        yield* Effect.gen(function* () {
          // durable dedup
          const existingRequest = yield* adapter
            .findByRequest(request)
            .pipe(orFail("Error getting the existing request in processAdapterRequest"));

          if (existingRequest) {
            return;
          } else {
            // create the worktree and T3 thread
            // generate the first user message ID and record it with ThreadStarted
            // Start the first T3 turn with that message Id, the snapshot and attachments
            // start monitoring the turn in the background (TODO: aren't we already subscribing for this?)
            // Attempt to post the acknowledgement independently
          }
          return;
        }).pipe(Effect.ensuring(Effect.sync(() => inFlightRequests.delete(key))));
      });

    const process = (request: NTBS.NTBSInput<P>, t3Context: T3Context) =>
      processAdapterRequest(request, t3Context);

    const subscribeToT3Events = Effect.void;

    return {
      process,
      subscribeToT3Events,
    };
  });
