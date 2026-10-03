/*
The T3 gateway module exposes the interface that the NTBS processor uses to communicate
with T3, similar to how adapter models the interaction with the external platform.
 */

import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  OrchestrationV2Command,
  SourceRef,
  TurnId,
  type ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import type * as NTBS from "./exchange.ts";
import {
  Context,
  Crypto,
  Data,
  DateTime,
  Effect,
  FileSystem,
  Layer,
  Option,
  Result,
  Stream,
} from "effect";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { ProjectStoreV2 } from "../orchestration-v2/ProjectStore.ts";

import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { ProjectSetupScriptRunner } from "../project/ProjectSetupScriptRunner.ts";
import { DEFAULT_THREAD_TITLE } from "@t3tools/shared/threadTitle";
import { ServerSettingsService } from "../serverSettings.ts";

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
*/

/**
 * A classification, not a scheduling request: it states the step is safe to retry, not that anything will retry it.
 * A failed retryable step leaves the exchange state untouched, so the exchange simply remains non-terminal, and whatever re-drives non-terminal exchanges re-runs the cycle from persisted state.
 */
export class RetryableError extends Data.TaggedError("RetryableError")<{
  reason: string;
  cause: unknown;
  method: string;
}> {}

/**
 * T3 will never accept this work.
 *
 * The mirror classification: retrying is pointless, so the exchange must progress to a terminal state instead of staying open.
 *
 * Actions (`planCoordinates`, `provisionThread`, `startTurn`) fail with `FatalError` when T3 rejects the work, and the processor converts that into a reply-pending failure.
 * Reads (`getThreadStatus`, `getTurnStatus`) never carry `FatalError`: an unrecoverable fact they observe goes into the context, and the decider drives the same terminal transition.
 * Both roads end at the same place: a failure reply to the user.
 */
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
  | ThreadManagementService
  /*
    Loads the selected T3 project and reads thread outcomes.
  */
  | ProjectStoreV2
  /*
    Finds the exact projected turn associated with the original T3 user message.
  */

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
  /*
    Supplies the environment's current default model when the project inherits it.
  */
  | ServerSettingsService
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
  A failed create can still expose an unexpected stale registration. Registrations
  discovered through `listRefs` are pruned before creation; anything left here is
  terminal because the gateway does not know which unrelated path would be safe to prune.
*/
const isStaleWorktreeRegistration = (cause: { readonly detail: string }): boolean =>
  /missing but (?:already registered|locked)/i.test(cause.detail);

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

  /**
   * A missing thread is a normal answer here, it is what triggers provisioning; only at ThreadCreated does the same observation become an anomaly.
   */
  readonly getThreadStatus: (
    state: NTBS.WorkPlanned,
  ) => Effect.Effect<NTBS.WorkPlannedContext, RetryableError>;

  /** Reentrant: worktree, thread creation and setup scripts, each skipped if already done. */
  readonly provisionThread: (
    state: NTBS.WorkPlanned,
  ) => Effect.Effect<void, RetryableError | FatalError>;

  /** Reports turn progress, interpreting a finished turn into a `Reply`: the agent's verbatim response when it produced one, a synthesized failure or cancellation note otherwise.
   *
   * The question it answers isn't really "does this thread have a turn?" but "did **our** message start a turn?". This is an important distinction because user messages to the same thread in T3 can come from different sources and interfaces. We want to know about the turn that should start stemming from a user in the external platform with a specific userMessageId.
   *
   * This is the invariant that makes recovery safe.
   *
   * It's a pure read, errors are Retryable only. Every lookup failure means "ask again later", nothing it learns can reject the exchange.
   *
   * Unrecoverable edge cases like "turn completed but thread not found" map to "completed" turns whose reply is a failure.
   *
   */
  readonly getTurnStatus: (
    state: NTBS.ThreadCreated,
  ) => Effect.Effect<NTBS.ThreadCreatedContext, RetryableError>;

  /**
   * Safety here is borrowed from the orchestration engine, not proven locally: dispatch returns only after the events and the projected turn rows commit in one SQL transaction, so a successful dispatch is immediately visible to `getTurnStatus` and a crash leaves both or neither.
   * That property is what makes observe-before-act sufficient against double starts, because a duplicate `thread.turn.start` would not fail — the decider queues it or starts a second turn.
   * If the engine ever projected asynchronously, this module would silently start duplicate turns and no test in this package would notice; the engine's own atomicity tests (OrchestrationEngine.test.ts, "rolls back all events for a multi-event command when projection fails mid-dispatch") are what pin it.
   */
  readonly startTurn: (
    state: NTBS.ThreadCreated,
  ) => Effect.Effect<void, RetryableError | FatalError>;

  /** Threads whose T3 state just changed; the processor reconciles each. */
  readonly threadActivity: Stream.Stream<ThreadId>;
}

export const T3Gateway = Context.Service<T3Gateway>("t3code/ntbs/t3Gateway");

const sourceForUri = (uri: string) => {
  const channel = uri.split(":")[0];
  return SourceRef.make({
    channel:
      channel === "discord" ||
      channel === "github" ||
      channel === "jira" ||
      channel === "slack" ||
      channel === "teams"
        ? channel
        : "unknown",
  });
};

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

    const projects = yield* ProjectStoreV2;
    const projectionSnapshotQuery = {
      getProjectShellById: (id: ProjectId) =>
        projects
          .listShells()
          .pipe(
            Effect.map((all) => Option.fromNullishOr(all.find((project) => project.id === id))),
          ),
      getThreadShellById: (id: ThreadId) =>
        orchestrationEngine.getThreadShell(id).pipe(Effect.map(Option.fromNullishOr)),
    };

    const serverSettings = yield* ServerSettingsService;

    const orchestrationEngine = yield* ThreadManagementService;

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
     * Rejects when the project has no `origin`. A `branchName` that does not resolve is retried until the exchange's deadline instead, because a missing branch cannot be told apart from a repository that merely failed to read.
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

          A missing branch and a repository read failure both surface here as a failed
          command, and nothing in the error tells them apart. Everything is retried instead:
          the state's deadline ends the attempts, while a wrong rejection is permanent.
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
            Effect.mapError(
              (cause) =>
                new RetryableError({
                  method: "gitWorkflowService.resolveRemoteTrackingCommit",
                  reason: "Could not resolve branch '" + startBranchName + "' on origin",
                  cause,
                }),
            ),
          );
      });

    const fileSystem = yield* FileSystem.FileSystem;

    /**
     * Finds or creates the checkout for `worktreeBranchName` and returns the path
     * Git actually uses. Repository-level Git operations run from `workspaceRoot`;
     * thread-scoped work uses the returned checkout path. Git owns path selection,
     * while the exchange persists only the branch needed to resume provisioning.
     */
    const ensureWorktree = (input: {
      readonly workspaceRoot: string;
      readonly worktreeBranchName: string;
      readonly startCommitSha: string;
      readonly startBranchName: string;
    }): Effect.Effect<string, RetryableError | FatalError> =>
      Effect.gen(function* () {
        const branch = yield* gitWorkflowService
          .listRefs({
            cwd: input.workspaceRoot,
            query: input.worktreeBranchName,
            refKind: "local",
            refresh: true,
          })
          .pipe(
            Effect.map((result) =>
              result.refs.find((ref) => ref.name === input.worktreeBranchName),
            ),
            orFail("retryable")(
              "gitWorkflowService.listRefs",
              "Could not check whether the worktree branch already exists",
            ),
          );

        if (branch?.worktreePath) {
          const existingWorktreePath = branch.worktreePath;
          const pathExists = yield* fileSystem
            .exists(existingWorktreePath)
            .pipe(orFail("retryable")("fileSystem.exists", "Could not inspect the worktree path"));

          if (pathExists) {
            const status = yield* gitWorkflowService
              .localStatus({ cwd: existingWorktreePath })
              .pipe(
                orFail("retryable")(
                  "gitWorkflowService.localStatus",
                  "Could not inspect the existing worktree",
                ),
              );

            if (status.isRepo && status.refName === input.worktreeBranchName) {
              return existingWorktreePath;
            }

            yield* gitWorkflowService
              .removeWorktree({ cwd: input.workspaceRoot, path: existingWorktreePath, force: true })
              .pipe(
                Effect.catch(() => fileSystem.remove(existingWorktreePath, { recursive: true })),
                orFail("retryable")(
                  "gitWorkflowService.removeWorktree",
                  "Could not clear the leftover worktree path",
                ),
              );
          } else {
            yield* gitWorkflowService
              .pruneWorktrees({ cwd: input.workspaceRoot })
              .pipe(
                orFail("retryable")(
                  "gitWorkflowService.pruneWorktrees",
                  "Could not clear the stale worktree registration",
                ),
              );
          }
        }

        return yield* gitWorkflowService
          .createWorktree(
            branch
              ? {
                  // A previous attempt created the branch; check it out instead of re-branching.
                  cwd: input.workspaceRoot,
                  path: null,
                  refName: input.worktreeBranchName,
                }
              : {
                  // First real attempt: branch off the commit pinned at claim.
                  cwd: input.workspaceRoot,
                  path: null,
                  refName: input.startCommitSha,
                  newRefName: input.worktreeBranchName,
                  baseRefName: input.startBranchName,
                },
          )
          .pipe(
            Effect.map((result) => result.worktree.path),
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
                    reason: "Could not create the worktree for " + input.worktreeBranchName,
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

        /*
          The branch carries the full thread UUID so a stray branch identifies its thread
          without truncating its identifier. The `ntbs/` prefix keeps T3 from treating it as
          one of its temporary placeholders (`t3code/<token>`), which it renames on the first turn.
        */
        const worktreeBranchName = `ntbs/${threadUUID}`;

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

    /* TODO: We doing a lot of work behind the scenes just to know whether the thread exists or is missing, this screams sql query or something not a snapshot query
     */
    const getThreadStatus = (
      state: NTBS.WorkPlanned,
    ): Effect.Effect<NTBS.WorkPlannedContext, RetryableError> =>
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
      state: NTBS.ThreadCreated,
    ): Effect.Effect<NTBS.ThreadCreatedContext, RetryableError> =>
      Effect.gen(function* () {
        const shell = yield* orchestrationEngine
          .getThreadShell(state.t3.threadId)
          .pipe(
            orFail("retryable")("thread.getShell", "Could not load thread " + state.t3.threadId),
          );
        if (shell === null)
          return {
            turn: "completed",
            reply: {
              type: "failure",
              text: "T3's thread could no longer be found.",
              cause: {
                type: "settled",
                threadId: state.t3.threadId,
                userMessageId: state.t3.userMessageId,
                turnId: null,
              },
            },
          } as const;
        const projection = yield* orchestrationEngine
          .getThreadProjection(state.t3.threadId)
          .pipe(
            orFail("retryable")(
              "thread.getProjection",
              "Could not load thread " + state.t3.threadId,
            ),
          );
        const run = projection.runs.find((entry) => entry.userMessageId === state.t3.userMessageId);
        if (run === undefined) return { turn: "missing" } as const;
        if (["queued", "preparing", "starting", "running", "waiting"].includes(run.status))
          return { turn: "active" } as const;
        const coordinates = {
          threadId: state.t3.threadId,
          userMessageId: state.t3.userMessageId,
          turnId: TurnId.make(run.id),
        };
        if (run.status === "completed") {
          const text = projection.messages
            .filter((message) => message.runId === run.id && message.role === "assistant")
            .map((message) => message.text)
            .join("\n")
            .trim();
          return {
            turn: "completed",
            reply:
              text.length > 0
                ? { type: "answer", text, ...coordinates }
                : {
                    type: "failure",
                    text: "T3 completed without producing a response.",
                    cause: { type: "settled", ...coordinates },
                  },
          } as const;
        }
        if (run.status === "interrupted" || run.status === "cancelled")
          return {
            turn: "completed",
            reply: {
              type: "cancellation",
              text: "T3 stopped processing this request.",
              ...coordinates,
            },
          } as const;
        return {
          turn: "completed",
          reply: {
            type: "failure",
            text: "T3 failed while processing this request.",
            cause: { type: "settled", ...coordinates },
          },
        } as const;
      });

    const startTurn = (
      state: NTBS.ThreadCreated,
    ): Effect.Effect<void, RetryableError | FatalError> =>
      Effect.gen(function* () {
        const commandId = CommandId.make(`ntbs:message:${state.t3.userMessageId}`);
        const createdAt = yield* getNow;

        yield* orchestrationEngine
          .dispatch(
            OrchestrationV2Command.make({
              type: "message.dispatch",
              commandId,
              threadId: state.t3.threadId,
              messageId: state.t3.userMessageId,
              text: state.snapshot,
              attachments: state.attachments,
              createdBy: "user",
              creationSource: "server",
              source: sourceForUri(state.sourceUri),
              dispatchMode: { type: "queue_after_active" },
            }),
          )
          .pipe(
            /*
              Verdict vs accident. An invariant error is the decider rejecting the command against current state (thread deleted, queue full): deterministic, retrying re-asks a question already answered, so it is fatal and becomes a failure reply.
              Everything else is infrastructure failing before any verdict; the transaction rolled back, nothing committed, and asking again later is meaningful.
              Judgment call: "queue full" is an invariant that time can heal (the queue drains when the active turn completes), but a full queue on an NTBS-owned thread means something else is hammering it, and a visible failure beats silently retrying into it.
            */
            Effect.mapError((cause) =>
              cause._tag === "OrchestratorCommandRejectedError" ||
              cause._tag === "OrchestratorCommandPreviouslyRejectedError"
                ? new FatalError({
                    method: "orchestrationEngine.dispatch",
                    reason: "T3 rejected the turn start for thread " + state.t3.threadId,
                    cause,
                  })
                : new RetryableError({
                    method: "orchestrationEngine.dispatch",
                    reason: "Could not dispatch thread.turn.start for thread " + state.t3.threadId,
                    cause,
                  }),
            ),
          );
      });

    /*
      This forwards the events that can change what the gateway's status queries answer about a thread, so its consumers are only signalled about changes that may require further action.

      The filter has to move with those queries: when one of them starts reading a different field, the events that write it belong here, or a consumer sees the change only on its next sweep.

      Ordinary activity appends change nothing the queries answer, but `context-compaction` and `provider.turn.start.failed` do, because both delete the pending turn start. Streaming deltas are `thread.message-sent` with `streaming: true`: the bulk of a live turn, and none of them change what the queries answer before the turn settles.
    */
    const threadActivity = orchestrationEngine.streamDomainEvents.pipe(
      Stream.filter(
        (event) =>
          event.type === "run.created" ||
          event.type === "run.updated" ||
          (event.type === "message.updated" && !event.payload.streaming) ||
          event.type === "thread.deleted",
      ),
      Stream.map((event) => event.threadId),
      Stream.catch(() => Stream.empty),
    );

    /**
     * Creates the actual thread in T3 with the recorded claimed request.
     *
     */
    const provisionThread = (
      state: NTBS.WorkPlanned,
    ): Effect.Effect<void, RetryableError | FatalError> =>
      Effect.gen(function* () {
        /*
         * In order we need to:
         * 1. get the actual project details, where is the workspace root path located at?
         * 2. Find an existing checkout for the planned branch, or ask Git to create one.
         * 3. Dispatch T3 thread creation with the path Git returned.
         * 4. Run the scripts for that project.
         */

        /*
        `provisionThread` is a resumable checklist, not a transaction.

        Every attempt re-derives its *facts* from live project and Git state, then walks three steps, each one "check, then do", so a retry after any interruption skips whatever already happened.

        **Worktree**. If the directory exists, reuse it. If only the branch survives from a crashed attempt, recreate the checkout from that branch instead of re-branching from the start commit. Otherwise create it fresh from the pinned commit.

        **Thread**. Create it. If the dispatch fails but the thread turns out to exist, a stale observation raced us and the step is already done.

        **Setup scripts**. Failure to launch setup is fatal; script completion is not tracked by T3.

        On a retryable failure, cleanup nothing. The half-finished work is owned by the exchange record and is exactly what the next reconcile pass resumes from.

        On a fatal failure, delete a thread created by this attempt before removing its worktree. If deletion fails, keep the worktree so the surviving thread still has a directory. A thread found during recovery and its worktree belong to an earlier attempt and are left intact. The branch ref is left behind.
        */
        // We refetch because the project details we had from `planCoordinates` might have changed, the project might've been deleted, etc
        const project = yield* getProject(state.t3.projectId);
        const modelSelection =
          project.defaultModelSelection ??
          (yield* serverSettings.getSettings.pipe(
            orFail("retryable")(
              "serverSettings.getSettings",
              "Could not load the default model for thread " + state.t3.threadId,
            ),
          )).defaultModelSelection;

        if (modelSelection === null) {
          return yield* new FatalError({
            method: "provisionThread",
            reason:
              "No default model is configured for this project or server. Set a model in project or machine settings and submit the request again.",
            cause: null,
          });
        }

        const { workspaceRoot } = project;

        const worktreePath = yield* ensureWorktree({
          workspaceRoot,
          worktreeBranchName: state.t3.worktreeBranchName,
          startCommitSha: state.t3.startCommitSha,
          startBranchName: state.t3.startBranchName,
        });

        let threadCreationState: "not-created" | "created" | "recovered" = "not-created";

        yield* Effect.gen(function* () {
          const commandId = CommandId.make(yield* randomUUID);
          const createdAt = yield* getNow;

          yield* orchestrationEngine
            .dispatch(
              OrchestrationV2Command.make({
                type: "thread.create",
                branch: state.t3.worktreeBranchName,
                worktreePath: worktreePath,
                threadId: state.t3.threadId,
                // T3 generates the real title after the first turn starts.
                title: DEFAULT_THREAD_TITLE,
                modelSelection: modelSelection,
                commandId,
                createdBy: "user",
                creationSource: "server",
                projectId: project.id,
                runtimeMode: "full-access",
                interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
              }),
            )
            .pipe(
              Effect.tap(() => {
                threadCreationState = "created";
                return Effect.void;
              }),
              /*
                A previous attempt may have created the thread before crashing.
                If the thread exists after a failed dispatch, this step is already
                done. A failed lookup is not evidence that it is absent.
              */
              Effect.catch((cause) =>
                projectionSnapshotQuery.getThreadShellById(state.t3.threadId).pipe(
                  Effect.catch((lookupCause) =>
                    Effect.fail(
                      new RetryableError({
                        method: "projectionSnapshotQuery.getThreadShellById",
                        reason:
                          "Could not determine whether thread " +
                          state.t3.threadId +
                          " was created",
                        cause: lookupCause,
                      }),
                    ),
                  ),
                  Effect.map(Option.isSome),
                  Effect.flatMap((threadExists) =>
                    threadExists
                      ? Effect.sync(() => {
                          threadCreationState = "recovered";
                        })
                      : Effect.fail(
                          // Native command rejections are terminal; dispatch failures
                          // remain retryable so durable provisioning can resume.
                          cause._tag === "OrchestratorCommandRejectedError" ||
                            cause._tag === "OrchestratorCommandPreviouslyRejectedError"
                            ? new FatalError({
                                method: "orchestrationEngine.dispatch",
                                reason:
                                  "T3 rejected thread creation for thread " + state.t3.threadId,
                                cause,
                              })
                            : new RetryableError({
                                method: "orchestrationEngine.dispatch",
                                reason:
                                  "Could not dispatch thread.create for thread " +
                                  state.t3.threadId,
                                cause,
                              }),
                        ),
                  ),
                ),
              ),
            );

          /*
            Failure to launch setup is fatal to provisioning. Once launched, setup
            may still be running or fail later; T3 does not report its completion.
            NTBS follows that behavior.
            TODO: Revisit if T3 exposes setup completion.
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
                "Failed to launch setup while provisioning thread",
              ),
            );
        }).pipe(
          Effect.tapError((error) => {
            if (error._tag !== "FatalError" || threadCreationState === "recovered") {
              return Effect.void;
            }

            return Effect.gen(function* () {
              if (threadCreationState === "created") {
                yield* orchestrationEngine.dispatch(
                  OrchestrationV2Command.make({
                    type: "thread.delete",
                    commandId: CommandId.make(yield* randomUUID),
                    threadId: state.t3.threadId,
                  }),
                );
              }

              yield* gitWorkflowService.removeWorktree({
                cwd: workspaceRoot,
                path: worktreePath,
                force: true,
              });
            }).pipe(
              Effect.catch((cause) =>
                Effect.logWarning("Failed to clean up NTBS thread provisioning", {
                  threadId: state.t3.threadId,
                  worktreePath,
                  cause,
                }),
              ),
            );
          }),
        );
      });

    return {
      planCoordinates,
      getThreadStatus,
      provisionThread,
      getTurnStatus,
      startTurn,
      threadActivity,
    };
  },
);

export const t3GatewayLive = Layer.effect(T3Gateway, T3GatewayLive);
