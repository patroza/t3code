import {
  type ChatAttachment,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  OrchestrationCommand,
  type OrchestrationEvent,
  type ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import type * as NTBS from "./exchange.ts";
import { Context, Crypto, Data, DateTime, Effect, Stream, Semaphore } from "effect";
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
    - Attempts to post the acknowledgement independently.
    - Watches T3 events for completed work.
    - Posts the final result through the adapter and saves `ResponsePosted`.

  2. Platform-specific inbound code:
    - Receives raw platform data from Jira, Discord, GitHub, or Teams.
    - Applies platform trigger and actor checks.
    - Builds `Request` and `t3` context.
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
    request: NTBS.Request,
    t3Context: T3Context,
  ) => Effect.Effect<void, NTBSProcessorError>;

  /**
   * The main loop of the processor, consumes T3 events and passes them to `processT3Event`.
   *
   * After the live subscription begins, loads stored `ThreadCreated` records.
   * It starts a missing first turn, or posts the outcome of a turn that already finished.
   *
   * Runs until interrupted by its caller.
   * Logs individual processing failures and continues with later events.
   */
  readonly run: Effect.Effect<void>;
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

    const getTurn = (threadId: ThreadId, userMessageId: MessageId) =>
      Effect.gen(function* () {
        const turns = yield* projectionTurnRepository
          .listByThreadId({ threadId })
          .pipe(orFail(`Failed loading turns for T3 thread ${threadId}`));
        /*
          Using `.find` is safe: a userMessageId can never label more than one turn.
          The UUID is minted once per request, and a turn start is only repeated
          (by recovery) when no turn exists for it.
          If the turn started, `.find` finds it. Finding none means the turn never
          started (e.g. crash) or T3 discarded it before a provider picked it up.
        */
        const turn = turns.find((turn) => turn.pendingMessageId === userMessageId);
        return turn ?? null;
      });

    /**
     * Reads the final outcome of the turn started by one NTBS user message.
     * Returns `null` while that exact turn is still pending or running.
     */
    const resolveT3Outcome = (
      threadId: ThreadId,
      userMessageId: MessageId,
    ): Effect.Effect<NTBSResponse | null, NTBSProcessorError> =>
      Effect.gen(function* () {
        const turn = yield* getTurn(threadId, userMessageId);

        if (!turn) {
          return yield* new NTBSProcessorError({
            reason: `Turn for user message ${userMessageId} not found.`,
            cause: { threadId, userMessageId },
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

          return text.length > 0
            ? { type: "answer", text }
            : {
                type: "failure",
                text: "T3 completed without producing a response.",
              };
        }

        if (turn.state === "error") {
          return {
            type: "failure",
            text: thread.session?.lastError ?? "T3 failed while processing this request.",
          };
        }

        return {
          type: "cancellation",
          text: "T3 stopped processing this request.",
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

        markResponsePosted(threadCreated.t3.userMessageId);
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
        const userMessageId = recordedThread.t3.userMessageId;

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

            const response = yield* resolveT3Outcome(threadId, userMessageId);
            if (response === null) {
              return;
            }

            yield* postResponse(currentRecord, response);
          }),
        );
      });

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
     * Starts the original turn when it is missing, leaves active turns to the
     * live event listener, or posts the outcome when a turn already finished.
     */
    const recoverThread = (
      threadCreated: NTBS.ThreadCreated,
    ): Effect.Effect<void, NTBSProcessorError> =>
      Effect.gen(function* () {
        const { threadId, userMessageId } = threadCreated.t3;

        const turn = yield* getTurn(threadId, userMessageId);

        if (!turn) {
          yield* startT3Turn(
            threadId,
            userMessageId,
            threadCreated.snapshot,
            threadCreated.attachments,
          );
          return;
        }

        if (turn.state === "pending" || turn.state === "running") {
          return;
        }

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

            const response = yield* resolveT3Outcome(threadId, userMessageId);
            if (response !== null) {
              yield* postResponse(currentRecord, response);
            }
          }),
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
      5. Attempt to post the acknowledgement independently.
    */
    const process = (request: NTBS.Request, t3Context: T3Context) =>
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
            .pipe(orFail("Error getting the existing request in process"));

          if (existingRequest) {
            return;
          }
          // create the worktree and T3 thread
          const threadId = yield* createT3Thread(t3Context);

          // generate the first user message ID and record it with ThreadCreated
          const userMessageId = MessageId.make(yield* randomUUID);

          const threadCreated: NTBS.ThreadCreated = {
            ...request,
            state: "thread.created",
            t3: {
              threadId,
              userMessageId,
            },
          };

          yield* adapter
            .save(threadCreated)
            .pipe(orFail("Failed to record the created NTBS thread"));

          // Start the first T3 turn with that message Id, the snapshot and attachments
          yield* startT3Turn(threadId, userMessageId, request.snapshot, request.attachments);

          yield* adapter.acknowledge(threadCreated).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Failed posting the NTBS acknowledgement", {
                userMessageId,
                threadId,
                cause,
              }),
            ),
          );
        }).pipe(Effect.ensuring(Effect.sync(() => inFlightRequests.delete(key))));
      });

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
                  threadId: threadCreated.t3.threadId,
                  userMessageId: threadCreated.t3.userMessageId,
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

    const run = Effect.scoped(
      Effect.gen(function* () {
        yield* consumeT3Events.pipe(Effect.forkScoped({ startImmediately: true }));
        yield* recoverStoredThreads;
        return yield* Effect.never;
      }),
    );

    return {
      process,
      run,
    };
  });
