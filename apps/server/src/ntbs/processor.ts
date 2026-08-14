import {
  type ChatAttachment,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  type EventId,
  MessageId,
  OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationLatestTurn,
  type OrchestrationLatestTurnState,
  type OrchestrationThread,
  type ProjectId,
  ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import type * as NTBS from "./lifecycle.ts";
import { Context, Crypto, Data, DateTime, Effect, Schedule, Stream, Semaphore } from "effect";
import type { NTBSAdapter, NTBSResponse } from "./adapter.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionTurnRepository } from "../persistence/Services/ProjectionTurns.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { ProjectSetupScriptRunner } from "../project/ProjectSetupScriptRunner.ts";
import { getAutoBootstrapDefaultModelSelection } from "../serverRuntimeStartup.ts";
import { DEFAULT_THREAD_TITLE } from "@t3tools/shared/threadTitle";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";

/*
  NTBS architecture:

  1. Generic NTBS processor:
    - Runs the shared workflow for every platform.
    - Creates a fresh worktree and T3 thread.
    - Saves `ThreadCreated`.
    - Starts the first turn with the snapshot and attachments.
    - Monitors the turn for completion and timeouts.
    - Attempts to post the acknowledgement independently.
    - Watches T3 events for completed work.
    - Posts the final result through the adapter and saves `ResponsePosted`.

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

export interface NTBSProcessor {
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
    request: NTBS.NTBSInput,
    t3Context: T3Context,
  ) => Effect.Effect<void, NTBSProcessorError>;

  /**
   * Consumes T3 events and passes them to `processT3Event`.
   *
   * After the live subscription begins, loads stored `ThreadCreated` records.
   * It starts a missing first turn, resumes monitoring an active turn, or posts
   * the outcome of a turn that already finished.
   *
   * Runs until interrupted by its caller.
   * Logs individual processing failures and continues with later events.
   */
  readonly subscribeToT3Events: Effect.Effect<void>;
}

export const makeNTBSProcessorTag = (key: string) => Context.Service<NTBSProcessor>(key);

type NTBSProcessorRequirements =
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

type TurnStats = {
  readonly turnId: TurnId;
  readonly state: OrchestrationLatestTurnState;
  readonly activityCount: number;
  readonly latestActivityId: EventId | null;
  readonly assistantTextLength: number;
  readonly assistantUpdatedAt: string | null;
};

/**
 * Gets the statistics visible in T3's projected activities and assistant
 * messages for one turn. It includes recorded tool activity and assistant text
 * that has reached the projection, but not necessarily buffered output,
 * hidden reasoning, or provider work that produces no projected event.
 * Comparing two results can indicate observable progress, but an unchanged
 * result does not prove that the turn is stalled.
 */
const getTurnStats = (
  thread: OrchestrationThread,
  turn: Pick<OrchestrationLatestTurn, "turnId" | "state">,
): TurnStats => {
  const activities = thread.activities.filter((activity) => activity.turnId === turn.turnId);
  const assistantMessages = thread.messages.filter(
    (message) => message.turnId === turn.turnId && message.role === "assistant",
  );

  const assistantUpdatedAt = assistantMessages.reduce<string | null>(
    (latest, message) =>
      latest === null || message.updatedAt > latest ? message.updatedAt : latest,
    null,
  );

  return {
    turnId: turn.turnId,
    state: turn.state,
    activityCount: activities.length,
    latestActivityId: activities.at(-1)?.id ?? null,
    assistantTextLength: assistantMessages.reduce(
      (length, message) => length + message.text.length,
      0,
    ),
    assistantUpdatedAt,
  };
};

const hasProgress = (previous: TurnStats, current: TurnStats): boolean =>
  previous.activityCount !== current.activityCount ||
  previous.latestActivityId !== current.latestActivityId ||
  previous.assistantTextLength !== current.assistantTextLength ||
  previous.assistantUpdatedAt !== current.assistantUpdatedAt;

/**
 * Records what the processor observed when it last checked a T3 turn.
 *
 * `stats` is null while T3 has accepted the turn request but the provider has
 * not started the turn. Once the turn exists, `stats.state` is the single
 * source of truth for whether it is running or terminal.
 */
type TurnStatus = {
  /** The T3 thread containing the monitored user message. */
  readonly threadId: ThreadId;
  /** When the processor read this status from the T3 projection. */
  readonly recordedAt: string;
  /** The observed turn statistics, or null while the turn is still pending. */
  readonly stats: TurnStats | null;
};

/**
 * Creates an NTBS processor for one adapter.
 *
 * Resolves the required T3 services and returns processor operations with no remaining requirements.
 */
export const makeNTBSProcessor = <AdapterId>(
  adapterTag: Context.Service<AdapterId, NTBSAdapter>,
): Effect.Effect<NTBSProcessor, never, AdapterId | NTBSProcessorRequirements> =>
  Effect.gen(function* () {
    const adapter = yield* adapterTag;

    const orFail = (reason: string) =>
      Effect.mapError((cause: unknown) => new NTBSProcessorError({ reason, cause }));

    const crypto = yield* Crypto.Crypto;
    const randomUUID = crypto.randomUUIDv4.pipe(orFail("Failed creating a UUID v4"));

    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const projectionTurnRepository = yield* ProjectionTurnRepository;

    const gitWorkflowService = yield* GitWorkflowService;

    const getNow = DateTime.now.pipe(Effect.map(DateTime.formatIso));

    /** Keeps each user message's lock until its final response is recorded and no caller uses it. */
    const responseLocks = new Map<
      MessageId,
      {
        readonly semaphore: Semaphore.Semaphore;
        callers: number;
        responsePosted: boolean;
      }
    >();

    const getResponseLock = (userMessageId: MessageId) => {
      let lock = responseLocks.get(userMessageId);
      if (lock === undefined) {
        lock = {
          semaphore: Semaphore.makeUnsafe(1),
          callers: 0,
          responsePosted: false,
        };
        responseLocks.set(userMessageId, lock);
      }
      return lock;
    };

    const markResponsePosted = (userMessageId: MessageId): void => {
      const lock = responseLocks.get(userMessageId);
      if (lock !== undefined) {
        lock.responsePosted = true;
      }
    };

    /**
     * Prevents the turn started by one user message from producing competing
     * final outcomes, such as both a normal response and a timeout.
     */
    const ensureUniqueOutcome = <A, E, R>(
      userMessageId: MessageId,
      effect: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E, R> =>
      Effect.suspend(() => {
        const lock = getResponseLock(userMessageId);
        lock.callers += 1;

        return lock.semaphore.withPermit(effect).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              lock.callers -= 1;
              if (
                lock.callers === 0 &&
                lock.responsePosted &&
                responseLocks.get(userMessageId) === lock
              ) {
                responseLocks.delete(userMessageId);
              }
            }),
          ),
        );
      });

    /**
     * Starts the first turn in an existing T3 thread.
     *
     * Uses the user message ID recorded in `ThreadCreated` so the resulting turn
     * and response can be matched to the external request.
     */
    const startT3Turn = (
      threadId: ThreadId,
      userMessageId: MessageId,
      snapshot: string,
      attachments: ReadonlyArray<ChatAttachment>,
    ): Effect.Effect<void, NTBSProcessorError> =>
      Effect.gen(function* () {
        const commandId = CommandId.make(yield* randomUUID);
        const createdAt = yield* getNow;

        yield* orchestrationEngineService
          .dispatch(
            OrchestrationCommand.make({
              type: "thread.turn.start",
              commandId,
              threadId,
              message: {
                messageId: userMessageId,
                role: "user",
                text: snapshot,
                attachments,
              },
              runtimeMode: "full-access",
              interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
              createdAt,
            }),
          )
          .pipe(orFail("Failed to start the first T3 turn"));
      });

    /**
     * Requests interruption of one exact T3 turn.
     */
    const interruptT3Turn = (
      threadId: ThreadId,
      turnId: TurnId,
    ): Effect.Effect<void, NTBSProcessorError> =>
      Effect.gen(function* () {
        const commandId = CommandId.make(yield* randomUUID);
        const createdAt = yield* getNow;

        yield* orchestrationEngineService
          .dispatch(
            OrchestrationCommand.make({
              type: "thread.turn.interrupt",
              commandId,
              threadId,
              turnId,
              createdAt,
            }),
          )
          .pipe(orFail(`Failed to interrupt T3 turn ${turnId}`));
      });

    /**
     * Reads the final outcome of the turn started by one NTBS user message.
     * Returns `null` while that exact turn is still pending or running.
     */
    const resolveT3Outcome = (
      threadId: ThreadId,
      userMessageId: MessageId,
    ): Effect.Effect<
      { readonly threadId: ThreadId; readonly response: NTBSResponse } | null,
      NTBSProcessorError
    > =>
      Effect.gen(function* () {
        const turns = yield* projectionTurnRepository
          .listByThreadId({ threadId })
          .pipe(orFail(`Failed loading turns for T3 thread ${threadId}`));

        const matchingTurns = turns.filter((turn) => turn.pendingMessageId === userMessageId);
        const turn = matchingTurns[0];

        if (matchingTurns.length !== 1 || turn === undefined) {
          return yield* new NTBSProcessorError({
            reason: `Expected exactly one T3 turn for user message ${userMessageId}, found ${matchingTurns.length}.`,
            cause: { threadId, userMessageId, matchingTurns },
          });
        }

        if (turn.state === "pending" || turn.state === "running") {
          return null;
        }

        const maybeThread = yield* projectionSnapshotQuery
          .getThreadDetailById(threadId)
          .pipe(orFail(`Failed loading T3 thread ${threadId}`));

        const thread = yield* Effect.fromOption(maybeThread).pipe(
          orFail(`Could not find T3 thread ${threadId}`),
        );

        if (turn.state === "completed") {
          const assistantMessage =
            turn.assistantMessageId === null
              ? undefined
              : thread.messages.find((message) => message.id === turn.assistantMessageId);

          const text = assistantMessage?.text.trim() ?? "";

          return {
            threadId,
            response:
              text.length > 0
                ? { type: "answer", text }
                : {
                    type: "failure",
                    text: "T3 completed without producing a response.",
                  },
          };
        }

        if (turn.state === "error") {
          return {
            threadId,
            response: {
              type: "failure",
              text: thread.session?.lastError ?? "T3 failed while processing this request.",
            },
          };
        }

        return {
          threadId,
          response: {
            type: "cancellation",
            text: "T3 stopped processing this request.",
          },
        };
      });

    /**
     * Posts one final response and records it in the adapter lifecycle.
     *
     * The caller must have already confirmed that no response is recorded and
     * must hold the outcome lock for this user message. If the platform already
     * contains the response, it is recorded instead of reposted.
     */
    const postResponse = (
      threadCreated: NTBS.ThreadCreated,
      response: NTBSResponse,
    ): Effect.Effect<void, NTBSProcessorError> =>
      Effect.gen(function* () {
        const existingResponseMessageId = yield* adapter
          .findMatchingResponseMessage(threadCreated)
          .pipe(orFail("Failed checking whether the NTBS response was already posted"));

        const responseMessageId =
          existingResponseMessageId ??
          (yield* adapter
            .postResponse(threadCreated, response)
            .pipe(orFail("Failed posting the NTBS response")));

        yield* adapter
          .save({
            ...threadCreated,
            state: "thread.response.posted",
            responseMessageId,
          })
          .pipe(orFail("Failed recording the posted NTBS response"));

        markResponsePosted(threadCreated.t3Data.userMessageId);
      });

    /**
     * Posts the final response when a T3 session event ends an NTBS turn.
     * Other T3 events and threads unknown to this adapter are ignored.
     */
    const processT3Event = (event: OrchestrationEvent): Effect.Effect<void, NTBSProcessorError> =>
      Effect.gen(function* () {
        if (event.type !== "thread.session-set") {
          return;
        }

        const threadId = event.payload.threadId;

        /*
          We may receive events for threads that are not related to the current 
          platform, and thus, adapter.
          So we check if the thread in question exists in the adapter records.
        */
        const recordedThread = yield* adapter.findByThreadId(threadId).pipe(
          Effect.catchTag("ThreadNotFound", () => Effect.succeed(null)),
          orFail("Failed loading the NTBS lifecycle for a T3 event"),
        );

        if (recordedThread === null) {
          return;
        }

        /*
          At the same time a thread may have different messages. We're only interested
          in the last user message that appears in the adapter records. 
         */
        const userMessageId = recordedThread.t3Data.userMessageId;

        yield* ensureUniqueOutcome(
          userMessageId,
          Effect.gen(function* () {
            // Timeout handling may have posted a response while this event was
            // waiting for the same user message's outcome lock.
            const currentRecord = yield* adapter.findByThreadId(threadId).pipe(
              Effect.catchTag("ThreadNotFound", () => Effect.succeed(null)),
              orFail("Failed reloading the NTBS lifecycle before posting its outcome"),
            );

            if (currentRecord === null) {
              return;
            }

            if (currentRecord.state === "thread.response.posted") {
              markResponsePosted(userMessageId);
              return;
            }

            const outcome = yield* resolveT3Outcome(threadId, userMessageId);
            if (outcome === null) {
              return;
            }

            yield* postResponse(currentRecord, outcome.response);
          }),
        );
      });

    /**
     * Stops a stalled T3 turn and reports the timeout to the external platform.
     *
     * Response handling is locked by user message so a normal completion and
     * timeout cannot both post an outcome.
     */
    const handleStalledTurn = (
      userMessageId: MessageId,
      status: TurnStatus,
    ): Effect.Effect<void, NTBSProcessorError> =>
      ensureUniqueOutcome(
        userMessageId,
        Effect.gen(function* () {
          const lifecycle = yield* adapter
            .findByThreadId(status.threadId)
            .pipe(orFail("Failed loading the NTBS lifecycle for a stalled turn"));

          if (lifecycle.state === "thread.response.posted") {
            markResponsePosted(userMessageId);
            return;
          }

          if (status.stats !== null) {
            const turnId = status.stats.turnId;
            yield* interruptT3Turn(status.threadId, turnId).pipe(
              Effect.catch((cause) =>
                Effect.logWarning("Failed interrupting stalled T3 turn", {
                  userMessageId,
                  threadId: status.threadId,
                  turnId,
                  cause,
                }),
              ),
            );
          }

          const response: NTBSResponse = {
            type: "timeout",
            text:
              status.stats === null
                ? "T3 could not start this request after repeated checks."
                : "T3 stopped this request after repeated checks found no observable progress.",
          };

          yield* postResponse(lifecycle, response);
        }),
      );

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

    /**
     * Semaphore-like behavior to avoid triggering multiple threads
     * and turns for the same requests.
     */
    const inFlightRequests = new Set<string>();

    /**
     * Keeps stats of active NTBS messages.
     *
     * Used to find out whether a turn has progressed since last check
     * or is it hanging.
     */
    const messageStatus = new Map<MessageId, TurnStatus>();

    /**
     * Fetches fresh information for the turn created by one T3 user message.
     */
    const loadMessageStatus = (
      userMessageId: MessageId,
      threadId: ThreadId,
    ): Effect.Effect<TurnStatus, NTBSProcessorError> =>
      Effect.gen(function* () {
        const turns = yield* projectionTurnRepository
          .listByThreadId({ threadId })
          .pipe(orFail(`Could not load projected turns for T3 thread ${threadId}`));

        const matchingTurns = turns.filter((turn) => turn.pendingMessageId === userMessageId);
        const monitoredTurn = matchingTurns[0];

        if (matchingTurns.length !== 1 || monitoredTurn === undefined) {
          return yield* new NTBSProcessorError({
            reason: `Expected exactly one T3 turn for user message ${userMessageId}, found ${matchingTurns.length}.`,
            cause: { userMessageId, threadId, matchingTurns },
          });
        }

        if (monitoredTurn.turnId === null && monitoredTurn.state === "pending") {
          return { threadId, stats: null, recordedAt: yield* getNow };
        }

        if (monitoredTurn.turnId === null || monitoredTurn.state === "pending") {
          return yield* new NTBSProcessorError({
            reason: `T3 turn state is inconsistent for user message ${userMessageId}.`,
            cause: monitoredTurn,
          });
        }

        const maybeThread = yield* projectionSnapshotQuery
          .getThreadDetailById(threadId)
          .pipe(orFail("Problems getting the thread from the projection"));

        const thread = yield* Effect.fromOption(maybeThread).pipe(
          orFail(`Could not load T3 thread ${threadId}`),
        );

        const stats = getTurnStats(thread, {
          turnId: monitoredTurn.turnId,
          state: monitoredTurn.state,
        });
        return { threadId, stats, recordedAt: yield* getNow };
      });

    /**
     * Loads the current turn status and compares it with the previous observation.
     * The status recorded when monitoring begins is the initial baseline.
     * Nonterminal observations replace the stored baseline; terminal observations remove it.
     */
    const checkProgress = (
      userMessageId: MessageId,
    ): Effect.Effect<
      { readonly status: TurnStatus; readonly progressed: boolean },
      NTBSProcessorError
    > =>
      Effect.gen(function* () {
        const recorded = messageStatus.get(userMessageId);
        if (recorded === undefined) {
          return yield* new NTBSProcessorError({
            reason: `No monitoring state exists for T3 user message ${userMessageId}.`,
            cause: userMessageId,
          });
        }

        const fresh = yield* loadMessageStatus(userMessageId, recorded.threadId);

        let progressed: boolean;

        if (recorded.stats === null && fresh.stats === null) {
          progressed = false;
        } else if (recorded.stats === null) {
          progressed = true;
        } else if (fresh.stats === null) {
          return yield* new NTBSProcessorError({
            reason: `T3 thread ${recorded.threadId} became pending after its turn had started.`,
            cause: { recorded, fresh },
          });
        } else {
          progressed = hasProgress(recorded.stats, fresh.stats);
        }

        const finished = fresh.stats !== null && fresh.stats.state !== "running";

        if (finished) {
          messageStatus.delete(userMessageId);
        } else {
          messageStatus.set(userMessageId, fresh);
        }

        return { status: fresh, progressed };
      });

    // TODO: These guys should come from some config
    const CHECK_INTERVAL = "15 seconds";
    const MAX_NO_PROGRESS_CHECKS = 12;

    const monitorT3Turn = (userMessageId: MessageId): Effect.Effect<void, NTBSProcessorError> =>
      Effect.gen(function* () {
        let consecutiveNoProgressChecks = 0;

        while (true) {
          const result = yield* checkProgress(userMessageId).pipe(
            Effect.retry({
              times: 3,
              schedule: Schedule.spaced(CHECK_INTERVAL),
            }),
            Effect.tapError((cause) =>
              Effect.logWarning("Failed checking T3 turn progress after retries", {
                userMessageId,
                cause,
              }),
            ),
          );

          const stats = result.status.stats;

          if (stats !== null && stats.state !== "running") {
            // it has completed already
            return;
          }

          if (result.progressed) {
            // reset the counter
            consecutiveNoProgressChecks = 0;
          } else {
            consecutiveNoProgressChecks += 1;
          }

          if (consecutiveNoProgressChecks >= MAX_NO_PROGRESS_CHECKS) {
            yield* handleStalledTurn(userMessageId, result.status);
            return;
          }

          yield* Effect.sleep(CHECK_INTERVAL);
        }
      }).pipe(Effect.ensuring(Effect.sync(() => messageStatus.delete(userMessageId))));

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

        const createdAt = yield* getNow;
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

    /**
     * Resumes one stored NTBS thread after the processor starts.
     *
     * Starts the original turn when it is missing, resumes monitoring while it
     * is active, or posts its outcome when it already finished.
     */
    const recoverThread = (
      threadCreated: NTBS.ThreadCreated,
    ): Effect.Effect<void, NTBSProcessorError> =>
      Effect.gen(function* () {
        const { threadId, userMessageId } = threadCreated.t3Data;
        const turns = yield* projectionTurnRepository
          .listByThreadId({ threadId })
          .pipe(orFail(`Failed loading turns while recovering T3 thread ${threadId}`));
        const matchingTurns = turns.filter((turn) => turn.pendingMessageId === userMessageId);

        if (matchingTurns.length > 1) {
          return yield* new NTBSProcessorError({
            reason: `Expected at most one T3 turn for user message ${userMessageId}, found ${matchingTurns.length}.`,
            cause: { threadId, userMessageId, matchingTurns },
          });
        }

        const turn = matchingTurns[0];

        if (turn === undefined) {
          yield* startT3Turn(
            threadId,
            userMessageId,
            threadCreated.snapshot,
            threadCreated.attachments,
          );
          messageStatus.set(userMessageId, {
            threadId,
            recordedAt: yield* getNow,
            stats: null,
          });
        } else {
          const status = yield* loadMessageStatus(userMessageId, threadId);

          if (status.stats !== null && status.stats.state !== "running") {
            yield* ensureUniqueOutcome(
              userMessageId,
              Effect.gen(function* () {
                const currentRecord = yield* adapter
                  .findByThreadId(threadId)
                  .pipe(orFail("Failed reloading the NTBS lifecycle during recovery"));

                if (currentRecord.state === "thread.response.posted") {
                  markResponsePosted(userMessageId);
                  return;
                }

                const outcome = yield* resolveT3Outcome(threadId, userMessageId);
                if (outcome !== null) {
                  yield* postResponse(currentRecord, outcome.response);
                }
              }),
            );
            return;
          }

          messageStatus.set(userMessageId, status);
        }

        yield* monitorT3Turn(userMessageId).pipe(
          Effect.catch((cause) =>
            Effect.logError("Recovered NTBS turn monitor failed", {
              userMessageId,
              threadId,
              cause,
            }),
          ),
          Effect.forkDetach,
        );
      });

    /*
      Handles an external request in this order:

      1. Ask the adapter whether this platform request already has a recorded
      `ThreadCreated` or `ResponsePosted`.
      If yes - stop. . If no - continue
      2. Create the worktree and T3 thread.
      3. Generate the first user message ID and record it with ThreadCreated.
      4. Start the first T3 turn with that message ID, the snapshot, and attachments.
      5. Start monitoring the turn in the background.
      6. Attempt to post the acknowledgement independently.
    */

    const processAdapterRequest = (request: NTBS.NTBSInput, t3Context: T3Context) =>
      Effect.gen(function* () {
        /*
          In-flight dedup first. We check if the processor is *currently*
          working on this very request: it's being worked right now.
          Later we check for the *durable* dedup: are we receiving a request 
          for work that has *already* completed.
        */
        const key = request.sourceUri;

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
            const threadId = yield* createT3Thread(t3Context);

            // generate the first user message ID and record it with ThreadCreated
            const userMessageId = MessageId.make(yield* randomUUID);

            const threadCreated: NTBS.ThreadCreated = {
              ...request,
              state: "thread.created",
              t3Data: {
                threadId,
                userMessageId,
              },
            };

            yield* adapter
              .save(threadCreated)
              .pipe(orFail("Failed to record the created NTBS thread"));

            // Start the first T3 turn with that message Id, the snapshot and attachments
            yield* startT3Turn(threadId, userMessageId, request.snapshot, request.attachments);
            messageStatus.set(userMessageId, {
              threadId,
              recordedAt: yield* getNow,
              stats: null,
            });
            yield* monitorT3Turn(userMessageId).pipe(
              Effect.catch((cause) =>
                Effect.logError("NTBS turn monitor failed", {
                  userMessageId,
                  threadId,
                  cause,
                }),
              ),
              Effect.forkDetach,
            );

            yield* adapter.postAcknowledgement(threadCreated).pipe(
              Effect.catch((cause) =>
                Effect.logWarning("Failed posting the NTBS acknowledgement", {
                  userMessageId,
                  threadId,
                  cause,
                }),
              ),
              Effect.asVoid,
            );
          }
          return;
        }).pipe(Effect.ensuring(Effect.sync(() => inFlightRequests.delete(key))));
      });

    const process = (request: NTBS.NTBSInput, t3Context: T3Context) =>
      processAdapterRequest(request, t3Context);

    const consumeT3Events = Stream.runForEach(
      orchestrationEngineService.streamDomainEvents,
      (event) =>
        processT3Event(event).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Failed processing T3 event for NTBS", {
              eventType: event.type,
              cause,
            }),
          ),
        ),
    );

    const recoverStoredThreads = adapter.loadThreadsAwaitingResponse.pipe(
      orFail("Failed loading NTBS threads awaiting a response"),
      Effect.flatMap((threads) =>
        Effect.forEach(
          threads,
          (threadCreated) =>
            recoverThread(threadCreated).pipe(
              Effect.catch((cause) =>
                Effect.logWarning("Failed recovering an NTBS thread", {
                  threadId: threadCreated.t3Data.threadId,
                  userMessageId: threadCreated.t3Data.userMessageId,
                  cause,
                }),
              ),
            ),
          { discard: true },
        ),
      ),
      Effect.catch((cause) =>
        Effect.logError("Failed starting NTBS thread recovery", {
          cause,
        }),
      ),
    );

    const subscribeToT3Events = Effect.scoped(
      Effect.gen(function* () {
        yield* consumeT3Events.pipe(Effect.forkScoped({ startImmediately: true }));
        yield* recoverStoredThreads;
        return yield* Effect.never;
      }),
    );

    return {
      process,
      subscribeToT3Events,
    };
  });
