import { ThreadId, type OrchestrationEvent, type ProjectId } from "@t3tools/contracts";
import type * as NTBS from "./schemas.ts";
import { Context, Crypto, Data, Effect } from "effect";
import type { NTBSAdapter } from "./adapter.ts";
import type { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { GitWorkflowService } from "../git/GitWorkflowService.ts";
import type { ProjectSetupScriptRunner } from "../project/ProjectSetupScriptRunner.ts";

/*
  NTBS architectural description:
  1. Generic NTBS processor:
    - Contains the shared workflow for every adapter. The business logic, regardless of the actual NTBS is identical
    - Makes queries to the specific platform adapter
    - Uses private T3-specific effect to create a fresh thread and worktree, then starts the turn with `snapshot`
    - Saves `ThreadStarted`
    - Posts to the NTBS platform through the adapter and saves `ThreadStartAcknowledgment`

    - Watches T3 events for completed work.
    - Finds the adapter record by T3 thread ID, posts the final result
    and saves `ResponseAvailable` and `ResponsePosted`

  2. Platform handler
    - Receives raw platform data (Jira, Discord, Github, Teams)
    - Builds `RequestAccepted<P> and `T3Context`
    - Calls the processor

  3. Adapter
    - Owns platform storage, duplicate detection and platform API calls
    - Knows how to post acknowledgments and responses
    - Knows how platform identifiers are represented
    - Knows nothing about creating T3 threads or interpreting T3 events
*/

export type T3Context = {
  readonly projectId: ProjectId;
  readonly revision: string;
};

export type ProcessorEvent<P extends NTBS.PlatformData> =
  | {
      readonly source: "adapter";
      readonly event: NTBS.RequestAccepted<P>;
      readonly t3Context: T3Context;
    }
  | {
      readonly source: "t3";
      readonly event: OrchestrationEvent;
    };

export class NTBSProcessorError extends Data.TaggedError("NTBSProcessorError")<{
  reason: string;
}> {}

export interface NTBSProcessor<P extends NTBS.PlatformData> {
  readonly process: (event: ProcessorEvent<P>) => Effect.Effect<void, NTBSProcessorError>;

  readonly subscribeToT3Events: Effect.Effect<void>;
}

export const makeNTBSProcessor = <P extends NTBS.PlatformData>(key: string) =>
  Context.Service<NTBSProcessor<P>>(key);

type NTBSProcessorRequirements =
  /*
    Dispatches thread creation and turn-start commands.
    Provides the T3 event stream used to detect outcomes.
   */
  | OrchestrationEngineService
  /*
    Loads the selected T3 project and reads the completed thread
    state and response tex.
  */
  | ProjectionSnapshotQuery
  /*
    Creates the isolated branch and worktree for each accepted external request.
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
 * Creates an isolated worktree and a new T3 thread.
 *
 * Does not start a turn, read platform data or call the adapter.
 */
declare const createT3Thread: (
  snapshot: string,
  t3Context: T3Context,
) => Effect.Effect<ThreadId, NTBSProcessorError>;

/**
 * Stars the first turn in an existing T3 thread.
 */
declare const startT3Turn: (
  threadId: ThreadId,
  snapshot: string,
) => Effect.Effect<void, NTBSProcessorError>;

/**
 * Handles an external request in this order:
 *
 * 1. Ask the adapter to accept it and stop if it is a duplicate.
 * 2. Create the worktree and T3 thread.
 * 3. Record `ThreadStarted`
 * 4. Post and record the acknowledgement.
 * 5. Start the first T3 turn with the source snapshot
 */
declare const processAcceptedRequest: <P extends NTBS.PlatformData>(
  request: NTBS.RequestAccepted<P>,
  t3Context: T3Context,
) => Effect.Effect<void, NTBSProcessorError>;

/**
 * Provider runtimes (like Claude Code) emit `turn.completed` but
 * T3 consumes those internally and represents the result externally emitting only a `thread.session-set` event.
 * This works for non-NTBS surfaces as they are notified to simply
 * rerender the latest projection.
 *
 * But it does not work for NTBS ones that do not consume projections.
 *
 * Thus, we need to listen for re-emitted `thread.session-set` events and manually check the state of the thread.
 *
 * We read the project thread identified by the session event.
 * - return `null` if the thread isn't done.
 * - return final assistant text or plain error text otherwise.
 * Reads the projected thread identified by the session event.
 */
declare const resolveT3Outcome: (
  event: Extract<OrchestrationEvent, { type: "thread.session-set" }>,
) => Effect.Effect<
  { readonly threadId: ThreadId; readonly text: string } | null,
  NTBSProcessorError
>;

/**
 * Handles T3 events that may indicate that a turn has ended.
 *
 * Ignores other events, threads with no adapter record, and responses that have been already posted.
 *
 * When a turn has ended, reads its result, posts it through the adapter and updates the lifecycle.
 */
declare const processT3Event: <P extends NTBS.PlatformData>(
  event: OrchestrationEvent,
) => Effect.Effect<void, NTBSProcessorError>;

/**
 * Creates an NTBS processor for one adapter.
 *
 * Resolves the required T3 services and returns processor operations with no remaining requirements.
 */
declare const makeProcessor: <P extends NTBS.PlatformData>(
  adapter: NTBSAdapter<P>,
) => Effect.Effect<NTBSProcessor<P>, never, NTBSProcessorRequirements>;
