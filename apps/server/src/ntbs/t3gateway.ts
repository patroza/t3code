/*
The T3 gateway module exposes the interface that the NTBS processor uses to communicate
with T3, similar to how adapter models the interaction with the external platform.
 */

import { MessageId, type ProjectId, ThreadId } from "@t3tools/contracts";
import type * as NTBS from "./exchange.ts";
import { Context, Crypto, Data, Effect, Layer, Option, Stream } from "effect";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionTurnRepository } from "../persistence/Services/ProjectionTurns.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { ProjectSetupScriptRunner } from "../project/ProjectSetupScriptRunner.ts";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";

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

export class RetryableError extends Data.TaggedError("RetryableError")<{
  reason: string;
  cause: unknown;
  method: string;
}> {}

/** T3 will never accept this work. */
export class FatalError extends Data.TaggedError("FatalError")<{
  reason: string;
  cause: unknown;
  method: string;
}> {}

type T3GatewayRequirements =
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

/** A branch on `origin` and the commit it pointed at when it was resolved. */
interface RemoteBranchTip {
  readonly branchName: string;
  readonly commitSha: string;
}

export interface T3Gateway {
  /**
   * Pins the requested branch to its current commit on `origin` and mints the thread, message, and
   * worktree branch identifiers recorded at claim.
   *
   * Creates nothing: no thread, no worktree, no turn. Every call mints fresh identifiers, so call it
   * once per request and persist the result — a second call orphans the work the first one planned.
   */
  readonly planCoordinates: (
    projectId: ProjectId,
    startBranchName: string,
  ) => Effect.Effect<NTBS.WorkCoordinates, RetryableError | FatalError>;

  readonly getThreadStatus: (
    state: NTBS.RequestClaimed,
  ) => Effect.Effect<NTBS.RequestClaimedContext, RetryableError>;

  /** Reentrant: worktree, thread creation and setup scripts, each skipped if already done. */
  readonly provisionThread: (
    state: NTBS.RequestClaimed,
  ) => Effect.Effect<void, RetryableError | FatalError>;

  /** Reports turn progress, interpreting a finished turn into a verbatim `Reply`. */
  readonly getTurnStatus: (
    state: NTBS.ThreadCreated,
  ) => Effect.Effect<NTBS.ThreadCreatedContext, RetryableError>;

  readonly startTurn: (
    state: NTBS.ThreadCreated,
  ) => Effect.Effect<void, RetryableError | FatalError>;

  /** Threads whose T3 state just changed; the processor reconciles each. */
  readonly threadActivity: Stream.Stream<ThreadId>;
}

export const T3Gateway = Context.Service<T3Gateway>("t3code/ntbs/t3Gateway");

const T3GatewayLive: Effect.Effect<T3Gateway, never, T3GatewayRequirements> = Effect.gen(
  function* () {
    const orFail = (method: string, reason: string) =>
      Effect.mapError(
        (cause: unknown) =>
          new RetryableError({
            reason,
            cause,
            method,
          }),
      );

    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;

    /*
      The lookup failing is operational; the project being absent is not.
      A deleted or archived project will never come back, so retrying is pointless.
    */
    const getProject = (projectId: ProjectId) =>
      projectionSnapshotQuery.getProjectShellById(projectId).pipe(
        orFail(
          "projectionSnapshotQuery.getProjectShellById",
          "Could not load project " + projectId,
        ),
        Effect.flatMap(
          Option.match({
            onSome: Effect.succeed,
            onNone: () =>
              Effect.fail(
                new FatalError({
                  method: "projectionSnapshotQuery.getProjectShellById",
                  reason: "Project " + projectId + " does not exist",
                  cause: null,
                }),
              ),
          }),
        ),
      );

    const gitWorkflowService = yield* GitWorkflowService;

    /**
     * Resolves `branchName` to the commit it currently points at on `origin`.
     *
     * Fetches first, so the answer reflects the current remote tip even when the local copy is behind. Only `origin` is consulted: local state is never a fallback, because two requests naming the same branch must start from the same commit.
     *
     * Rejects when the project has no `origin`, or when `branchName` is not a branch on it.
     */
    const resolveRemoteBranchTip = (
      cwd: string,
      startBranchName: string,
    ): Effect.Effect<RemoteBranchTip, FatalError | RetryableError> =>
      Effect.gen(function* () {
        // Check if origin exist. If not, T3 will never be able to accept this work.
        // The lookup failing is operational; a definitive `false` is not.
        yield* gitWorkflowService.remoteExists({ cwd, remoteName: "origin" }).pipe(
          orFail(
            "gitWorkflowService.remoteExists",
            "Could not check whether the remote 'origin' exists",
          ),
          Effect.filterOrFail(
            (exists) => exists,
            () =>
              new FatalError({
                method: "gitWorkflowService.remoteExists",
                reason: "Remote 'origin' does not exist",
                cause: null,
              }),
          ),
        );

        // Since it exists, let's fetch the latest remote state
        yield* gitWorkflowService
          .fetchRemote({ cwd, remoteName: "origin" })
          .pipe(orFail("gitWorkflowService.fetchRemote", "Could not fetch origin. try again"));

        /*
          Reads the local `refs/remotes/origin/*` namespace the fetch above just refreshed;
          no network is involved.

          A missing branch is permanent, but git can also fail here for reasons that are not:
          the command timing out behind the git process semaphore, or the process failing to
          spawn. Only a non-zero exit means git ran and rejected the ref, so only that becomes
          a rejection. Everything else is retried, because a wrong rejection is unrecoverable
          while a wrong retry is merely noisy.
        */
        return yield* gitWorkflowService
          .resolveRemoteTrackingCommit({
            cwd,
            refName: startBranchName,
            fallbackRemoteName: "origin",
          })
          .pipe(
            Effect.map((resolved) => ({
              branchName: startBranchName,
              commitSha: resolved.commitSha,
            })),
            Effect.mapError((cause) =>
              cause.exitCode === undefined
                ? new RetryableError({
                    method: "gitWorkflowService.resolveRemoteTrackingCommit",
                    reason: "Could not read the tip of '" + startBranchName + "' on origin",
                    cause,
                  })
                : new FatalError({
                    method: "gitWorkflowService.resolveRemoteTrackingCommit",
                    reason: "Branch '" + startBranchName + "' does not exist on origin",
                    cause,
                  }),
            ),
          );
      });

    const crypto = yield* Crypto.Crypto;
    const randomUUID = crypto.randomUUIDv4.pipe(
      orFail("crypto.randomUUIDv4", "Failed creating a UUID v4"),
    );

    const planCoordinates = (
      projectId: ProjectId,
      startBranchName: string,
    ): Effect.Effect<NTBS.WorkCoordinates, RetryableError | FatalError> =>
      Effect.gen(function* () {
        /*
          1. Resolve the target project
          2. Resolve the branch - commit pair against which we will create our work tree.
          3. Mind thread, branch, message IDs
        */

        const project = yield* getProject(projectId);

        const remoteBranchTip = yield* resolveRemoteBranchTip(
          project.workspaceRoot,
          startBranchName,
        );

        const threadUUID = yield* randomUUID;
        const threadId = ThreadId.make(threadUUID);

        const userMessageId = MessageId.make(yield* randomUUID);

        // Derived from the thread UUID so a stray branch points back at its thread.
        const worktreeBranchName = buildTemporaryWorktreeBranchName(() => threadUUID);

        const coordinates: NTBS.WorkCoordinates = {
          projectId,
          startBranchName: remoteBranchTip.branchName,
          startCommitSha: remoteBranchTip.commitSha,
          threadId,
          userMessageId,
          worktreeBranchName,
        };
        return coordinates;
      });

    const getThreadStatus = (
      _state: NTBS.RequestClaimed,
    ): Effect.Effect<NTBS.RequestClaimedContext, RetryableError> =>
      Effect.succeed({
        thread: "missing",
      });

    const getTurnStatus = (
      _state: NTBS.ThreadCreated,
    ): Effect.Effect<NTBS.ThreadCreatedContext, RetryableError> =>
      Effect.succeed({
        turn: "missing",
      });

    const startTurn = (_state: NTBS.ThreadCreated) => Effect.void;

    const threadActivity = Stream.never;

    const provisionThread = (
      _state: NTBS.RequestClaimed,
    ): Effect.Effect<void, RetryableError | FatalError> => Effect.void;

    return {
      startTurn,
      getTurnStatus,
      threadActivity,
      planCoordinates,
      getThreadStatus,
      provisionThread,
    };
  },
);

export const t3GatewayLive = Layer.effect(T3Gateway, T3GatewayLive);
