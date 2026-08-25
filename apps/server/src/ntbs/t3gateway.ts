/*
The T3 gateway module exposes the interface that the NTBS processor uses to communicate
with T3, similar to how adapter models the interaction with the external platform.
 */

import { MessageId, type ProjectId, ThreadId } from "@t3tools/contracts";
import type * as NTBS from "./exchange.ts";
import { Context, Crypto, Data, Effect, Layer, Stream } from "effect";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionTurnRepository } from "../persistence/Services/ProjectionTurns.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { ProjectSetupScriptRunner } from "../project/ProjectSetupScriptRunner.ts";

/*
  NTBS architecture:

  1. Adapter
  Responsible for the communication with the external platform (Jira, Discord, Teams, etc).
  - `acknowledge` confirms T3 is processing the user request
  - `postReply` sends the reply to the platform
  - `findPostedReplies` retries the replies sent to the platform (but maybe not recorded due to crash)
  
  2. ExchangeRepository
  Responsible for saving `Exchange` data, entities that model the incoming message -> reply cycle and the relations to T3 data (threads, messages, turns).

  3. T3 gateway
  Models the interaction with T3's own api and VCS lifecycle: creating threads, worktrees, starting turns, etc.

  4. NTBS Processor
  The orchestrator between 1, 2, 3 and 4.

  TODO: Better description of the whole architecture.
*/

export class T3GatewayError extends Data.TaggedError("T3GatewayError")<{
  reason: string;
  cause: unknown;
}> {}

type _T3GatewayRequirements =
  /*
    Dispatches thread creation and turn-start commands.
    Provides the T3 event stream used to detect outcomes.
   */
  | OrchestrationEngineService
  /*
    Loads the selected T3 project and reads thread outcomes.
  */
  | ProjectionSnapshotQuery
  /*
    Finds the exact projected turn associated with the original T3 user message.
  */
  | ProjectionTurnRepository
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

/** T3 will never accept this work; the processor records a failure reply. */
export class T3Rejected extends Data.TaggedError("T3Rejected")<{
  reason: string;
  cause: unknown;
}> {}

export interface T3Gateway {
  /** Resolves the requested base ref to a commit SHA and mints the thread, message, and branch IDs recorded at claim. */
  readonly planT3Work: (
    projectId: ProjectId,
    baseRef: string,
  ) => Effect.Effect<NTBS.T3WorkCoordinates, T3GatewayError | T3Rejected>;

  readonly getThreadStatus: (
    state: NTBS.RequestClaimed,
  ) => Effect.Effect<NTBS.RequestClaimedContext, T3GatewayError>;

  /** Reentrant: worktree, thread creation and setup scripts, each skipped if already done. */
  readonly provisionThread: (
    state: NTBS.RequestClaimed,
  ) => Effect.Effect<void, T3GatewayError | T3Rejected>;

  /** Reports turn progress, interpreting a finished turn into a verbatim `Reply`. */
  readonly getTurnStatus: (
    state: NTBS.ThreadCreated,
  ) => Effect.Effect<NTBS.ThreadCreatedContext, T3GatewayError>;

  readonly startTurn: (
    state: NTBS.ThreadCreated,
  ) => Effect.Effect<void, T3GatewayError | T3Rejected>;

  /** Threads whose T3 state just changed; the processor reconciles each. */
  readonly threadActivity: Stream.Stream<ThreadId>;
}

export const T3Gateway = Context.Service<T3Gateway>("t3code/ntbs/t3Gateway");

const T3GatewayLive: Effect.Effect<T3Gateway> = Effect.sync(function () {
  const planT3Work = (
    projectId: ProjectId,
    baseRef: string,
  ): Effect.Effect<NTBS.T3WorkCoordinates, T3GatewayError | T3Rejected> =>
    Effect.succeed({
      projectId,
      baseRefSha: baseRef + " sha",
      threadId: ThreadId.make("some thread id"),
      userMessageId: MessageId.make("userMessageId"),
      branchName: baseRef + " branchName",
    });

  const getThreadStatus = (
    _state: NTBS.RequestClaimed,
  ): Effect.Effect<NTBS.RequestClaimedContext, T3GatewayError> =>
    Effect.succeed({
      thread: "missing",
    });

  const getTurnStatus = (
    _state: NTBS.ThreadCreated,
  ): Effect.Effect<NTBS.ThreadCreatedContext, T3GatewayError> =>
    Effect.succeed({
      turn: "missing",
    });

  const startTurn = (_state: NTBS.ThreadCreated) => Effect.void;

  const threadActivity = Stream.never;

  const provisionThread = (
    _state: NTBS.RequestClaimed,
  ): Effect.Effect<void, T3GatewayError | T3Rejected> => Effect.void;

  return {
    startTurn,
    getTurnStatus,
    threadActivity,
    planT3Work,
    getThreadStatus,
    provisionThread,
  };
});

export const t3GatewayLive = Layer.effect(T3Gateway, T3GatewayLive);
