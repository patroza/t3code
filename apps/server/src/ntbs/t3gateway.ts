/*
The T3 gateway module exposes the interface that the NTBS processor uses to communicate
with T3, similar to how adapter models the interaction with the external platform.
 */

import * as NodePath from "node:path";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  OrchestrationCommand,
  type ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import type * as NTBS from "./exchange.ts";
import { Context, Crypto, Data, DateTime, Effect, FileSystem, Layer, Option, Stream } from "effect";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionTurnRepository } from "../persistence/Services/ProjectionTurns.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { ProjectSetupScriptRunner } from "../project/ProjectSetupScriptRunner.ts";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";
import { DEFAULT_THREAD_TITLE } from "@t3tools/shared/threadTitle";
import { ServerConfig } from "../config.ts";
import { getAutoBootstrapDefaultModelSelection } from "../serverRuntimeStartup.ts";

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
  | Crypto.Crypto
  | ServerConfig
  /*
    Probes and clears leftover worktree directories during reentrant provisioning.
  */
  | FileSystem.FileSystem;

/** A branch on `origin` and the commit it pointed at when it was resolved. */
interface RemoteBranchTip {
  readonly branchName: string;
  readonly commitSha: string;
}

/*
  Git refuses `worktree add` at a path whose directory is gone but is still listed
  in `.git/worktrees`. Healing needs `git worktree prune`, which the git driver
  does not expose yet, so this state is terminal for the exchange.
*/
const isStaleWorktreeRegistration = (cause: { readonly detail: string }): boolean =>
  /missing but (?:already registered|locked)/i.test(cause.detail);

/** Derives the worktree checkout path. Copied from GitVcsDriverCore.createWorktree. */
const deriveWorktreePath = (input: {
  readonly worktreesDir: string;
  readonly workspaceRoot: string;
  readonly worktreeBranchName: string;
}): string =>
  NodePath.join(
    input.worktreesDir,
    NodePath.basename(input.workspaceRoot),
    input.worktreeBranchName.replace(/\//g, "-"),
  );

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
    const orFail =
      <S extends "retryable" | "fatal">(severity: S) =>
      (method: string, reason: string) =>
        Effect.mapError(
          (cause: unknown) =>
            (severity === "fatal"
              ? new FatalError({ reason, cause, method })
              : new RetryableError({ reason, cause, method })) as S extends "fatal"
              ? FatalError
              : RetryableError,
        );

    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;

    const serverConfig = yield* ServerConfig;

    const orchestrationEngine = yield* OrchestrationEngineService;

    /*
      The lookup failing is operational; the project being absent is not.
      A deleted or archived project will never come back, so retrying is pointless.
    */
    const getProject = (projectId: ProjectId) =>
      projectionSnapshotQuery.getProjectShellById(projectId).pipe(
        orFail("retryable")(
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
          orFail("retryable")(
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
          .pipe(
            orFail("retryable")(
              "gitWorkflowService.fetchRemote",
              "Could not fetch origin. try again",
            ),
          );

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

    const fileSystem = yield* FileSystem.FileSystem;

    /**
     * Guarantees `worktreePath` is a registered checkout of `worktreeBranchName`,
     * adopting whatever an interrupted attempt left behind: an intact checkout is
     * reused, debris at the path is destroyed, a surviving branch is checked out
     * instead of re-created, and only then is anything created fresh from the
     * commit pinned at claim.
     */
    const ensureWorktree = (input: {
      readonly workspaceRoot: string;
      readonly worktreePath: string;
      readonly worktreeBranchName: string;
      readonly startCommitSha: string;
      readonly startBranchName: string;
    }): Effect.Effect<void, RetryableError | FatalError> =>
      Effect.gen(function* () {
        const pathExists = yield* fileSystem
          .exists(input.worktreePath)
          .pipe(orFail("retryable")("fileSystem.exists", "Could not inspect the worktree path"));

        if (pathExists) {
          // Ask git, not the filesystem: the step is only done when the
          // directory is a checkout of the minted branch.
          const status = yield* gitWorkflowService
            .localStatus({ cwd: input.worktreePath })
            .pipe(
              orFail("retryable")(
                "gitWorkflowService.localStatus",
                "Could not inspect the existing worktree",
              ),
            );

          if (status.isRepo && status.refName === input.worktreeBranchName) {
            return;
          }

          /*
            The path is namespaced by this exchange's minted branch, so whatever
            else sits here is our own debris (partial checkout, junk). Plain
            directory removal is the fallback for content git does not recognize
            as a worktree.
          */
          yield* gitWorkflowService
            .removeWorktree({ cwd: input.workspaceRoot, path: input.worktreePath, force: true })
            .pipe(
              Effect.catch(() => fileSystem.remove(input.worktreePath, { recursive: true })),
              orFail("retryable")(
                "gitWorkflowService.removeWorktree",
                "Could not clear the leftover worktree path",
              ),
            );
        }

        const branchExists = yield* gitWorkflowService
          .listRefs({
            cwd: input.workspaceRoot,
            query: input.worktreeBranchName,
            refKind: "local",
          })
          .pipe(
            Effect.map((result) =>
              result.refs.some((ref) => ref.name === input.worktreeBranchName),
            ),
            orFail("retryable")(
              "gitWorkflowService.listRefs",
              "Could not check whether the worktree branch already exists",
            ),
          );

        yield* gitWorkflowService
          .createWorktree(
            branchExists
              ? {
                  // A previous attempt created the branch; check it out instead of re-branching.
                  cwd: input.workspaceRoot,
                  path: input.worktreePath,
                  refName: input.worktreeBranchName,
                  deferDependencyInstall: true,
                }
              : {
                  // First real attempt: branch off the commit pinned at claim.
                  cwd: input.workspaceRoot,
                  path: input.worktreePath,
                  refName: input.startCommitSha,
                  newRefName: input.worktreeBranchName,
                  baseRefName: input.startBranchName,
                  deferDependencyInstall: true,
                },
          )
          .pipe(
            Effect.mapError((cause) =>
              isStaleWorktreeRegistration(cause)
                ? new FatalError({
                    method: "gitWorkflowService.createWorktree",
                    reason:
                      "The worktree path is still registered to a deleted checkout and needs `git worktree prune`",
                    cause,
                  })
                : new RetryableError({
                    method: "gitWorkflowService.createWorktree",
                    reason: "Could not create the worktree at " + input.worktreePath,
                    cause,
                  }),
            ),
          );
      });

    const crypto = yield* Crypto.Crypto;
    const randomUUID = crypto.randomUUIDv4.pipe(
      orFail("retryable")("crypto.randomUUIDv4", "Failed creating a UUID v4"),
    );

    const getNow = DateTime.now.pipe(Effect.map(DateTime.formatIso));

    const projectScriptRunner = yield* ProjectSetupScriptRunner;

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

    // TODO: We doing a lot of work behind the scenes just to know whether
    // the thread exists or is missing, this screams sql query or something
    // not a snapshot query
    const getThreadStatus = (
      state: NTBS.RequestClaimed,
    ): Effect.Effect<NTBS.RequestClaimedContext, RetryableError> =>
      projectionSnapshotQuery.getThreadShellById(state.t3.threadId).pipe(
        Effect.map((maybeThread) => ({
          thread: Option.isNone(maybeThread) ? ("missing" as const) : ("present" as const),
        })),
        orFail("retryable")(
          "projectionSnapshotQuery.getThreadShellById",
          "Could not check whether thread " + state.t3.threadId + " exists",
        ),
      );

    const getTurnStatus = (
      _state: NTBS.ThreadCreated,
    ): Effect.Effect<NTBS.ThreadCreatedContext, RetryableError> =>
      Effect.succeed({
        turn: "missing",
      });

    const startTurn = (_state: NTBS.ThreadCreated) => Effect.void;

    const threadActivity = Stream.never;

    /**
     * Creates the actual thread in T3 with the recorded claimed request.
     *
     */
    const provisionThread = (
      state: NTBS.RequestClaimed,
    ): Effect.Effect<void, RetryableError | FatalError> =>
      Effect.gen(function* () {
        /*
         * In order we need to:
         * 1. get the actual project details, where is the workspace root path located at?
         * 2. get the worktrees path location. T3 does not create worktrees inside the project workspace, because a checkout nested inside the user's project repository directory would pollute it (untracked noise in `git status`, IDE/watcher/grep pickup, accidental commits) and worktrees are T3-owned disposable state, so they live inside T3's home where they can be wiped without touching the user's code (which may even be a bare repo with no working tree to nest into at all).
         * 3. Derive the worktree path: where are we going to put the files we're going to work with?
         * 4. Create the actual worktree
         * 5. Dispatch T3 thread creation
         * 6. Run the scripts for that project
         */
        // We refetch because the project details we had from `planCoordinates` might have changed, the project might've been deleted, etc

        /*
        `provisionThread` is a resumable checklist, not a transaction.

        Every attempt re-derives its *facts* from live state, the project's `workspaceRoot`, and the worktree path computed from the pinned branch name, then walks three steps, each one "check, then do", so a retry after any interruption skips whatever already happened.

        **Worktree**. If the directory exists, reuse it. If only the branch survives from a crashed attempt, recreate the checkout from that branch instead of re-branching from the start commit. Otherwise create it fresh from the pinned commit.

        **Thread**. Create it. If the dispatch fails but the thread turns out to exist, a stale observation raced us and the step is already done.

        **Setup scripts**. Failures are fatal, like any other provisioning error: we don't pretend the workspace works when it doesn't.

        On a retryable failure, cleanup nothing. The half-finished work is owned by the exchange record and is exactly what the next reconcile pass resumes from.

        On a fatal failure, the one moment ownership truly ends, remove the worktree best-effort, and let only the cheap branch ref leak.
        */
        const project = yield* getProject(state.t3.projectId);
        const { workspaceRoot } = project;
        const { worktreesDir } = serverConfig;

        const worktreePath = deriveWorktreePath({
          workspaceRoot,
          worktreesDir,
          worktreeBranchName: state.t3.worktreeBranchName,
        });

        yield* Effect.gen(function* () {
          yield* ensureWorktree({
            workspaceRoot,
            worktreePath,
            worktreeBranchName: state.t3.worktreeBranchName,
            startCommitSha: state.t3.startCommitSha,
            startBranchName: state.t3.startBranchName,
          });

          const commandId = CommandId.make(yield* randomUUID);
          const createdAt = yield* getNow;

          const modelSelection =
            project.defaultModelSelection ?? getAutoBootstrapDefaultModelSelection();

          yield* orchestrationEngine
            .dispatch(
              OrchestrationCommand.make({
                type: "thread.create",
                branch: state.t3.worktreeBranchName,
                worktreePath: worktreePath,
                threadId: state.t3.threadId,
                // T3 generates the real title after the first turn starts.
                title: DEFAULT_THREAD_TITLE,
                modelSelection: modelSelection,
                commandId,
                createdAt,
                projectId: project.id,
                runtimeMode: "full-access",
                interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
              }),
            )
            .pipe(
              Effect.asVoid,
              /*
                Our "thread is missing" observation can be stale (crash after a
                committed create, projection lag). If the thread turns out to
                exist, this step is already done: swallow the failure and carry on.
              */
              Effect.catch((cause) =>
                projectionSnapshotQuery.getThreadShellById(state.t3.threadId).pipe(
                  Effect.map(Option.isSome),
                  Effect.orElseSucceed(() => false),
                  Effect.flatMap((threadExists) =>
                    threadExists
                      ? Effect.void
                      : Effect.fail(
                          new RetryableError({
                            method: "orchestrationEngine.dispatch",
                            reason:
                              "Could not dispatch thread.create for thread " + state.t3.threadId,
                            cause,
                          }),
                        ),
                  ),
                ),
              ),
            );

          /*
            Script failures are thread-provisioning errors: fatal.
            We don't pretend stuff is working if it's not.
          */
          yield* projectScriptRunner
            .runForThread({
              threadId: state.t3.threadId,
              projectId: project.id,
              projectCwd: project.workspaceRoot,
              worktreePath,
            })
            .pipe(
              orFail("fatal")(
                "projectScriptRunner.runForThread",
                "Failed to run scripts while provisioning thread",
              ),
            );
        }).pipe(
          Effect.tapError((error) =>
            error._tag === "FatalError"
              ? gitWorkflowService
                  .removeWorktree({ cwd: workspaceRoot, path: worktreePath, force: true })
                  .pipe(Effect.ignore)
              : Effect.void,
          ),
        );
      });

    return {
      planCoordinates,
      getThreadStatus,
      provisionThread,
      startTurn,
      getTurnStatus,
      threadActivity,
    };
  },
);

export const t3GatewayLive = Layer.effect(T3Gateway, T3GatewayLive);
