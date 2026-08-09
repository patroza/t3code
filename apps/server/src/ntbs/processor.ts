import {
  type ChatAttachment,
  type MessageId,
  type OrchestrationEvent,
  type ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import type * as NTBS from "./lifecycle.ts";
import { Context, Crypto, Data, Effect } from "effect";
import type { NTBSAdapter, NTBSResponse } from "./adapter.ts";
import type { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { GitWorkflowService } from "../git/GitWorkflowService.ts";
import type { ProjectSetupScriptRunner } from "../project/ProjectSetupScriptRunner.ts";

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
  readonly revision: string;
};

export class NTBSProcessorError extends Data.TaggedError("NTBSProcessorError")<{
  reason: string;
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
    const crypto = yield* Crypto.Crypto;

    /**
     * Creates an isolated worktree and a new T3 thread.
     *
     * Uses the supplied project and revision. The thread starts with T3's default
     * title, the project's default model or T3's fallback model, `full-access`
     * runtime mode, and `default` interaction mode.
     *
     * Does not start a turn, read platform data or call the adapter.
     *
     * The final title of the thread is generated by T3 after the first turn starts.
     */
    const createT3Thread = (t3Context: T3Context): Effect.Effect<ThreadId, NTBSProcessorError> =>
      Effect.sync(function () {
        // TODO: Continue from here
        const threadId = ThreadId.make("somethread");
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
        const existingRequest = yield* adapter.findByRequest(request).pipe(
          Effect.mapError(
            () =>
              new NTBSProcessorError({
                reason: "Error getting the existing request in processAdapterRequest",
              }),
          ),
        );
        if (existingRequest) {
          return Effect.void;
        } else {
          // create the worktree and T3 thread
          // generate the first user message ID and record it with ThreadStarted
          // Start the first T3 turn with that message Id, the snapshot and attachments
          // start monitoring the turn in the background (TODO: aren't we already subscribing for this?)
          // Attempt to post the acknowledgement independently
        }
        return Effect.void;
      });

    const process = (request: NTBS.NTBSInput<P>, t3Context: T3Context) =>
      processAdapterRequest(request, t3Context);

    const subscribeToT3Events = Effect.void;

    return {
      process,
      subscribeToT3Events,
    };
  });
