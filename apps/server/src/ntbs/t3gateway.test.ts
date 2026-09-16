import { describe, it, expect } from "@effect/vitest";
import { t3GatewayLive, T3Gateway } from "./t3gateway.ts";
import { DateTime, Deferred, Effect, Fiber, Layer, Option, Ref, FileSystem, Stream } from "effect";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  ProjectionTurnRepository,
  type ProjectionTurn,
} from "../persistence/Services/ProjectionTurns.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import {
  ProjectSetupScriptOperationError,
  ProjectSetupScriptRunner,
} from "../project/ProjectSetupScriptRunner.ts";
import { Crypto } from "effect/Crypto";
import {
  CheckpointRef,
  EventId,
  GitCommandError,
  MessageId,
  type OrchestrationEvent,
  OrchestrationProjectShell,
  type OrchestrationSessionStatus,
  OrchestrationThread,
  OrchestrationThreadShell,
  ProjectId,
  ProviderInstanceId,
  ServerSettingsError,
  ThreadId,
  TurnId,
  VcsCreateWorktreeResult,
  VcsListRefsResult,
  VcsStatusLocalResult,
} from "@t3tools/contracts";
import { isTemporaryWorktreeBranch } from "@t3tools/shared/git";
import { toPersistenceSqlError } from "../persistence/Errors.ts";
import { OrchestrationCommandInvariantError } from "../orchestration/Errors.ts";
import { PlatformError, SystemError } from "effect/PlatformError";
import {
  makeRequestAccepted,
  toThreadCreated,
  toWorkPlanned,
  type Request,
  type T3Target,
  type WorkCoordinates,
} from "./exchange.ts";
import * as ServerSettings from "../serverSettings.ts";

/**
 * Every mocked dependency records into one shared, ordered log.
 *
 * One array rather than one per service: only a single sequence can answer questions that span
 * services — that the project is loaded before git runs, or that a rejection stopped the gateway
 * before it minted anything. Per-service views are derivable from this; the ordering is not
 * recoverable from them.
 */
type Call = { service: string; method: string; input: unknown };

const createCallLog = () => {
  const calls: Array<Call> = [];

  const recordResult =
    (service: string) =>
    <A>(method: string, input: unknown, value: A) =>
      Effect.sync(() => {
        calls.push({ service, method, input });
        return value;
      });

  const record = (service: string) => (method: string, input: unknown) =>
    Effect.sync(() => calls.push({ service, method, input }));

  // Widened so the mock wrappers stay the only writers: tests can read the log, not push into it.
  return { calls: calls as ReadonlyArray<Call>, recordResult, record };
};

type CallRecordResult = ReturnType<typeof createCallLog>["recordResult"];

type CallRecord = ReturnType<typeof createCallLog>["record"];

type CryptoInput = {
  failRandomUUIDv4?: boolean;
};

const createCryptoMock = (recordResult: CallRecordResult, input?: CryptoInput) => {
  const recordCrypto = recordResult("Crypto");

  return Layer.unwrap(
    Effect.gen(function* () {
      const counter: Ref.Ref<number> = yield* Ref.make(0);

      return Layer.mock(Crypto, {
        "~effect/platform/Crypto": "~effect/platform/Crypto",
        randomUUIDv4:
          // recordCrypto("randomUUIDv4", undefined, )

          input?.failRandomUUIDv4
            ? recordCrypto("randomUUIDv4", undefined, "noreach").pipe(
                Effect.andThen(
                  new PlatformError(
                    new SystemError({
                      _tag: "Unknown",
                      method: "randomUUIDv4",
                      module: "crypto something",
                    }),
                  ),
                ),
              )
            : Ref.getAndUpdate(counter, (num) => num + 1).pipe(
                Effect.flatMap((num) =>
                  recordCrypto("randomUUIDv4", undefined, "randomUUID" + num),
                ),
              ),
        nextDoubleUnsafe: () => 0,
        nextIntUnsafe: () => 0,
      });
    }),
  );
};

const createGitCommandError = (exitCode?: number, detail = "") =>
  GitCommandError.make({
    command: "resolve",
    cwd: "",
    detail,
    failureKind: "unknown",
    operation: "",
    exitCode,
  });

type OrchestrationEngineInput = {
  /** `"invariant"` fails with the decider's rejection; `true` with an operational persistence error. */
  dispatchFails?: boolean | "invariant";
  deleteFails?: boolean;
  /** Signals, then hangs `dispatch` so a caller can interrupt a provision mid-flight. */
  dispatchStalls?: Deferred.Deferred<void>;
  /** Emitted through `streamDomainEvents` as a finite stream, unlike the live infinite PubSub one. */
  domainEvents?: ReadonlyArray<OrchestrationEvent>;
};

// TODO: We need to make sure and analyze what happens when it is dispatched
// Old processor treated it as a synchronous event, but that might be a lie
const createOrchestrationEngineServiceMock = (
  recordResult: CallRecordResult,
  callRecord: CallRecord,
  input?: OrchestrationEngineInput,
) => {
  const _record = recordResult("OrchestrationEngineService");

  const call = callRecord("OrchestrationEngineService");

  return Layer.mock(OrchestrationEngineService, {
    dispatch: (_command) =>
      call("dispatch", _command).pipe(
        Effect.andThen(() =>
          input?.dispatchStalls
            ? Deferred.succeed(input.dispatchStalls, undefined).pipe(Effect.andThen(Effect.never))
            : input?.dispatchFails || (_command.type === "thread.delete" && input?.deleteFails)
              ? Effect.fail(
                  input?.dispatchFails === "invariant"
                    ? new OrchestrationCommandInvariantError({
                        commandType: _command.type,
                        detail: "rejected by the decider",
                      })
                    : toPersistenceSqlError("some operation")("some cause"),
                )
              : Effect.succeed({ sequence: 0 }),
        ),
      ),
    streamDomainEvents: Stream.fromIterable(input?.domainEvents ?? []),
  });
};

type PSQMInput = {
  getProjectShellById?:
    | {
        success: Partial<OrchestrationProjectShell>;
      }
    | { failure: unknown }
    | { missing: true };
  isThreadMissing?: boolean;
  isGetThreadShellByIdError?: boolean;
  isThreadDetailMissing?: boolean;
  isGetThreadDetailByIdError?: boolean;
  /** Rendered as messages on the thread detail; assistant unless a role is given. */
  threadMessages?: ReadonlyArray<{ id: MessageId; text: string; role?: "user" | "assistant" }>;
  sessionStatus?: OrchestrationSessionStatus;
  sessionLastError?: string;
};

const createPSQM = (record: CallRecordResult, input?: PSQMInput) => {
  const recordPSQM = record("ProjectionSnapshotQuery");

  const isProjectMissing = input?.getProjectShellById && "missing" in input.getProjectShellById;

  const isGetProjectError = input?.getProjectShellById && "failure" in input.getProjectShellById;

  return Layer.mock(ProjectionSnapshotQuery, {
    getProjectShellById: (projectId) =>
      recordPSQM("getProjectShellById", projectId, null).pipe(
        Effect.andThen(
          isGetProjectError
            ? toPersistenceSqlError("some sql error")("somecause")
            : Effect.option(
                isProjectMissing
                  ? Effect.fail("missing")
                  : Effect.succeed({
                      id: projectId,
                      workspaceRoot: "root",
                      title: "project-title",
                      createdAt: DateTime.formatIso(DateTime.nowUnsafe()),
                      updatedAt: DateTime.formatIso(DateTime.nowUnsafe()),
                      defaultModelSelection: null,
                      scripts: [],
                      ...(input?.getProjectShellById &&
                        "success" in input.getProjectShellById && {
                          ...input.getProjectShellById.success,
                        }),
                    }),
              ),
        ),
      ),
    getThreadShellById: (threadId) =>
      recordPSQM(
        "getThreadShellById",
        threadId,
        input?.isThreadMissing
          ? Option.none<OrchestrationThreadShell>()
          : Option.some<OrchestrationThreadShell>({
              archivedAt: null,
              branch: "some-branch",
              createdAt: DateTime.formatIso(DateTime.nowUnsafe()),
              hasActionableProposedPlan: false,
              hasPendingApprovals: false,
              hasPendingUserInput: false,
              id: threadId,
              interactionMode: "default",
              latestTurn: null,
              latestUserMessageAt: null,
              modelSelection: {
                instanceId: ProviderInstanceId.make("instanceId"),
                model: "custom",
                options: [],
              },
              pullRequests: [],
              projectId: ProjectId.make("projectId"),
              runtimeMode: "auto",
              session: {
                threadId,
                activeTurnId: null,
                lastError: null,
                providerName: null,
                runtimeMode: "auto",
                status: "ready",
                updatedAt: DateTime.formatIso(DateTime.nowUnsafe()),
                providerInstanceId: ProviderInstanceId.make("providerInstanceId"),
              },
              settledAt: null,
              settledOverride: "active",
              title: "some title",
              updatedAt: DateTime.formatIso(DateTime.nowUnsafe()),
              worktreePath: null,
            }),
      ).pipe(
        Effect.filterOrFail(
          () => !input || input.isGetThreadShellByIdError !== true,
          () => toPersistenceSqlError("some sql error")("somecause"),
        ),
      ),
    getThreadDetailById: (threadId) =>
      recordPSQM(
        "getThreadDetailById",
        threadId,
        input?.isThreadDetailMissing
          ? Option.none<OrchestrationThread>()
          : Option.some<OrchestrationThread>({
              id: threadId,
              projectId: ProjectId.make("projectId"),
              title: "some title",
              modelSelection: {
                instanceId: ProviderInstanceId.make("instanceId"),
                model: "custom",
                options: [],
              },
              pullRequests: [],
              runtimeMode: "auto",
              interactionMode: "default",
              branch: "some-branch",
              worktreePath: null,
              latestTurn: null,
              createdAt: DateTime.formatIso(DateTime.nowUnsafe()),
              updatedAt: DateTime.formatIso(DateTime.nowUnsafe()),
              archivedAt: null,
              settledOverride: null,
              settledAt: null,
              deletedAt: null,
              messages: (input?.threadMessages ?? []).map((message) => ({
                id: message.id,
                role: message.role ?? ("assistant" as const),
                text: message.text,
                turnId: null,
                streaming: false,
                createdAt: DateTime.formatIso(DateTime.nowUnsafe()),
                updatedAt: DateTime.formatIso(DateTime.nowUnsafe()),
              })),
              queuedMessages: [],
              pendingTurnStart: null,
              proposedPlans: [],
              activities: [],
              checkpoints: [],
              session: {
                threadId,
                status: input?.sessionStatus ?? "ready",
                providerName: null,
                activeTurnId: null,
                lastError: input?.sessionLastError ?? null,
                runtimeMode: "auto",
                updatedAt: DateTime.formatIso(DateTime.nowUnsafe()),
                providerInstanceId: ProviderInstanceId.make("providerInstanceId"),
              },
            }),
      ).pipe(
        Effect.filterOrFail(
          () => !input || input.isGetThreadDetailByIdError !== true,
          () => toPersistenceSqlError("some sql error")("somecause"),
        ),
      ),
  });
};

type ProjectionTurnRepositoryInput = {
  turns?: ReadonlyArray<ProjectionTurn>;
  listByThreadIdFails?: boolean;
};

const createProjectionTurnRepositoryMock = (
  recordResult: CallRecordResult,
  input?: ProjectionTurnRepositoryInput,
) => {
  const record = recordResult("ProjectionTurnRepository");

  return Layer.mock(ProjectionTurnRepository, {
    listByThreadId: (callInput) =>
      record("listByThreadId", callInput, input?.turns ?? []).pipe(
        Effect.filterOrFail(
          () => !input || input.listByThreadIdFails !== true,
          () => toPersistenceSqlError("some sql error")("somecause"),
        ),
      ),
  });
};

type GitLayerInput = {
  createdWorktreePath?: string;
  createWorkreeFails?: boolean | { detail: string };
  failBranchResolution?: "non-zero-exit" | "no-exit-code";
  fetchRemoteFails?: boolean;
  listRefsFails?: boolean;
  localStatus?: { isRepo?: boolean; refName?: string };
  localStatusFails?: boolean;
  remoteExists?: boolean;
  remoteExistsFails?: boolean;
  resolvedRemoteSha?: string;
  removeWorkTreeFails?: boolean;
  worktreeBranchExists?: boolean;
  worktreeBranchPath?: string;
};

// TODO: Can't we simplify it by leveraging default values in params?
// we can pass default arguments in JS
const createGitWorkflowServiceMock = (
  recordResult: CallRecordResult,
  callRecord: CallRecord,
  input?: GitLayerInput,
) => {
  const recordGit = recordResult("GitWorkflowService");

  const record = callRecord("GitWorkflowService");

  return Layer.mock(GitWorkflowService, {
    createWorktree: (callInput) =>
      record("createWorktree", callInput).pipe(
        Effect.andThen(() =>
          input?.createWorkreeFails
            ? Effect.fail(
                createGitCommandError(
                  undefined,
                  typeof input.createWorkreeFails === "object"
                    ? input.createWorkreeFails.detail
                    : "",
                ),
              )
            : Effect.succeed(
                VcsCreateWorktreeResult.make({
                  worktree: {
                    path: callInput.path ?? input?.createdWorktreePath ?? "path",
                    refName: callInput.newRefName ?? callInput.refName,
                  },
                }),
              ),
        ),
      ),
    remoteExists: (callInput) =>
      recordGit("remoteExists", callInput, !input || input.remoteExists !== false).pipe(
        Effect.filterOrFail(
          () => !input || !input.remoteExistsFails,
          () => createGitCommandError(),
        ),
      ),
    fetchRemote: (callInput) =>
      recordGit("fetchRemote", callInput, undefined).pipe(
        Effect.filterOrFail(
          () => !input || input.fetchRemoteFails !== true,
          () => createGitCommandError(),
        ),
      ),
    localStatus: (callInput) =>
      recordGit(
        "localStatus",
        callInput,
        VcsStatusLocalResult.make({
          isRepo: input?.localStatus?.isRepo ?? false,
          hasPrimaryRemote: true,
          isDefaultRef: false,
          refName: input?.localStatus?.refName ?? null,
          hasWorkingTreeChanges: false,
          workingTree: { files: [], insertions: 0, deletions: 0 },
        }),
      ).pipe(
        Effect.filterOrFail(
          () => !input?.localStatusFails,
          () => createGitCommandError(),
        ),
      ),
    listRefs: (callInput) =>
      recordGit(
        "listRefs",
        callInput,
        VcsListRefsResult.make({
          refs: input?.worktreeBranchExists
            ? [
                {
                  name: callInput.query ?? "worktreeBranchName",
                  current: false,
                  isDefault: false,
                  worktreePath: input.worktreeBranchPath ?? null,
                },
              ]
            : [],
          isRepo: true,
          hasPrimaryRemote: true,
          nextCursor: null,
          totalCount: input?.worktreeBranchExists ? 1 : 0,
        }),
      ).pipe(
        Effect.filterOrFail(
          () => !input?.listRefsFails,
          () => createGitCommandError(),
        ),
      ),
    removeWorktree: (callInput) =>
      record("removeWorktree", callInput).pipe(
        Effect.andThen(() =>
          input?.removeWorkTreeFails ? Effect.fail(createGitCommandError()) : Effect.void,
        ),
      ),
    pruneWorktrees: (callInput) => record("pruneWorktrees", callInput),

    resolveRemoteTrackingCommit: (callInput) =>
      recordGit("resolveRemoteTrackingCommit", callInput, {
        commitSha: input?.resolvedRemoteSha ?? "sha123",
        remoteRefName: "remoteRefName",
      }).pipe(
        Effect.flatMap((val) =>
          input?.failBranchResolution
            ? createGitCommandError(input.failBranchResolution === "non-zero-exit" ? 1 : undefined)
            : Effect.succeed(val),
        ),
      ),
  });
};

type ProjectSetupScriptRunnerInput = {
  runForThreadFails?: boolean;
};

const ProjectSetupScriptRunnerMock = (
  _recordResult: CallRecordResult,
  callRecord: CallRecord,
  input?: ProjectSetupScriptRunnerInput,
) => {
  // const record = recordResult("ProjestSetupScriptRunnerMock");
  const call = callRecord("ProjectSetupScriptRunnerMock");

  return Layer.mock(ProjectSetupScriptRunner, {
    runForThread: (callInput) =>
      call("runForThread", callInput).pipe(
        Effect.andThen(() =>
          input?.runForThreadFails
            ? Effect.fail(
                ProjectSetupScriptOperationError.make({
                  _tag: "ProjectSetupScriptOperationError",
                  cause: "somecause",
                  operation: "openTerminal",
                  threadId: callInput.threadId,
                  worktreePath: callInput.worktreePath,
                }),
              )
            : Effect.succeed({ status: "no-script" }),
        ),
      ),
  });
};

type FileSystemInput = {
  worktreePathExists?: boolean;
  existsFails?: boolean;
  removeFails?: boolean;
};

const createFileSystemMock = (recordResult: CallRecordResult, input?: FileSystemInput) => {
  const recordFs = recordResult("FileSystem");

  const fail = (method: string) =>
    new PlatformError(new SystemError({ _tag: "Unknown", method, module: "FileSystem" }));

  return FileSystem.layerNoop({
    exists: (path) =>
      recordFs("exists", path, input?.worktreePathExists === true).pipe(
        Effect.filterOrFail(
          () => !input || input.existsFails !== true,
          () => fail("exists"),
        ),
      ),
    remove: (path, options) =>
      recordFs("remove", { path, options }, undefined).pipe(
        Effect.filterOrFail(
          () => !input || input.removeFails !== true,
          () => fail("remove"),
        ),
      ),
  });
};

/**
 * Builds a gateway plus the log of everything its dependencies were asked to do.
 *
 * Called per test rather than per block: each failure mode needs its own mock configuration, so
 * there is nothing worth sharing, and a log created per test beats resetting a shared one.
 */
const createT3Gateway = (input?: {
  pqsm?: PSQMInput;
  gwfs?: GitLayerInput;
  crypto?: CryptoInput;
  orchestrationEngine?: OrchestrationEngineInput;
  projectSetupScriptRunner?: ProjectSetupScriptRunnerInput;
  fileSystem?: FileSystemInput;
  turnRepository?: ProjectionTurnRepositoryInput;
  serverSettings?: Layer.Layer<ServerSettings.ServerSettingsService, ServerSettingsError>;
}) => {
  const { calls, recordResult, record } = createCallLog();

  return {
    calls,
    layer: t3GatewayLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          createOrchestrationEngineServiceMock(recordResult, record, input?.orchestrationEngine),
          createPSQM(recordResult, input?.pqsm),
          ProjectSetupScriptRunnerMock(recordResult, record, input?.projectSetupScriptRunner),
          createGitWorkflowServiceMock(recordResult, record, input?.gwfs),
          createProjectionTurnRepositoryMock(recordResult, input?.turnRepository),
          createCryptoMock(recordResult, input?.crypto),
          input?.serverSettings ??
            ServerSettings.layerTest({
              defaultModelSelection: {
                instanceId: ProviderInstanceId.make("claude-code"),
                model: "claude-sonnet-4-6",
              },
            }),
          createFileSystemMock(recordResult, input?.fileSystem),
        ),
      ),
    ),
  };
};

const now = 1_700_000_000_000;

describe("T3Gateway", () => {
  describe("planCoordinates", () => {
    /*
      Recap. This will, in order:
      - fetch the project details for projectId
        - if it cannot load the project due to errors, it will fail with a recoverable error
        - it if can:
          - if the project exists: it will return it
          - if it does not: it will fail with a T3Rejected error, one that cannot be retried
      - it checks if the git remote exists
        - if it cannot load: retryable fail
        - if it can but it does not exist: T3Rejected, it cannot be retried
      - it tries to fetch it
        - this cannot be rejected, it can only return a retryable error.
          It would make no sense to error, as remote exists step before confirmed it exists.
      - last step: try to get the commit sha for the remote branch with that name

      Now that we have the git and project references:
      - generate a threadId
      - generate a userMessageId
      - generate a branch name for the temporary git worktree
      - return the coordinates

    */
    describe("successful planning", () => {
      it.effect("pins the selected branch to the commit fetched from origin", () => {
        /*
          Declared once and threaded through the project mock, so the assertions below prove the cwd git receives is the workspace the project lookup returned, rather than two literals that happen to agree.
        */
        const workspaceRoot = "/workspaces/project-under-test";
        const projectId = ProjectId.make("test-1");

        const { calls, layer } = createT3Gateway({
          pqsm: { getProjectShellById: { success: { workspaceRoot } } },
          gwfs: { remoteExists: true },
        });

        return Effect.gen(function* () {
          const t3Gateway = yield* T3Gateway;

          const coordinates = yield* t3Gateway.planCoordinates(projectId, "main");

          expect(coordinates).toEqual({
            projectId,
            startBranchName: "main",
            startCommitSha: "sha123",
            threadId: expect.any(String),
            userMessageId: expect.any(String),
            worktreeBranchName: expect.any(String),
          });

          /*
            The identifiers are whatever the crypto mock hands out, so asserting exact values
            would only restate the mock. What matters are the relationships the gateway owns:
            the thread and its first message are distinct, and the worktree branch carries the
            full thread id under a prefix T3 does not rename.
          */
          expect(coordinates.threadId).not.toEqual(coordinates.userMessageId);
          expect(coordinates.worktreeBranchName).toEqual(`ntbs/${coordinates.threadId}`);
          expect(isTemporaryWorktreeBranch(coordinates.worktreeBranchName)).toBe(false);

          /*
            Order matters as much as the arguments. The tip is only current because the fetch
            precedes it — reading first would resolve whatever origin pointed at the last time
            anything fetched in this workspace. And git must run in the workspace the project
            lookup returned: the wrong one still resolves a real sha, from the wrong repository.
          */
          expect(calls).toEqual([
            {
              service: "ProjectionSnapshotQuery",
              method: "getProjectShellById",
              input: projectId,
            },
            {
              service: "GitWorkflowService",
              method: "remoteExists",
              input: { cwd: workspaceRoot, remoteName: "origin" },
            },
            {
              service: "GitWorkflowService",
              method: "fetchRemote",
              input: { cwd: workspaceRoot, remoteName: "origin" },
            },
            {
              service: "GitWorkflowService",
              method: "resolveRemoteTrackingCommit",
              input: { cwd: workspaceRoot, refName: "main", fallbackRemoteName: "origin" },
            },
            { service: "Crypto", method: "randomUUIDv4", input: undefined },
            { service: "Crypto", method: "randomUUIDv4", input: undefined },
          ]);
        }).pipe(Effect.provide(layer));
      });
    });

    describe("fatal errors", () => {
      it.effect(
        "rejects a project that does not exist without performing provisioning work",
        () => {
          const projectId = ProjectId.make("non-existing-project");

          const { calls, layer } = createT3Gateway({
            pqsm: { getProjectShellById: { missing: true } },
          });

          return Effect.gen(function* () {
            const t3Gateway = yield* T3Gateway;

            const error = yield* t3Gateway.planCoordinates(projectId, "main").pipe(Effect.flip);

            expect(error._tag).toBe("FatalError");

            expect(error.method).toBe("projectionSnapshotQuery.getProjectShellById");

            // Nothing after the lookup: no git, and no identifiers minted for work that cannot run.
            expect(calls).toEqual([
              {
                service: "ProjectionSnapshotQuery",
                method: "getProjectShellById",
                input: projectId,
              },
            ]);
          }).pipe(Effect.provide(layer));
        },
      );

      it.effect("rejects a project whose repository has no origin remote", () => {
        const { layer } = createT3Gateway({
          gwfs: { remoteExists: false },
        });

        const projectId = ProjectId.make("projectId");

        return Effect.gen(function* () {
          const t3Gateway = yield* T3Gateway;

          const result = yield* t3Gateway.planCoordinates(projectId, "main").pipe(Effect.flip);

          expect(result._tag).toBe("FatalError");
          expect(result.method).toBe("gitWorkflowService.remoteExists");
        }).pipe(Effect.provide(layer));
      });
    });

    describe("operational failures", () => {
      it.effect("fails retryably when the project lookup fails", () => {
        const { layer, calls } = createT3Gateway({
          pqsm: {
            getProjectShellById: { failure: "no project resolving" },
          },
        });

        const projectId = ProjectId.make("projectId");

        return Effect.gen(function* () {
          const t3Gateway = yield* T3Gateway;

          const result = yield* t3Gateway.planCoordinates(projectId, "main").pipe(Effect.flip);

          expect(result._tag).toBe("RetryableError");

          expect(result.method).toBe("projectionSnapshotQuery.getProjectShellById");

          const methods = calls.map((call) => call.method);

          expect(methods).toEqual(["getProjectShellById"]);
        }).pipe(Effect.provide(layer));
      });

      it.effect("fails retryably when checking for the origin remote existance fails", () => {
        const { layer, calls } = createT3Gateway({
          gwfs: {
            remoteExistsFails: true,
          },
        });

        const projectId = ProjectId.make("projectId");

        return Effect.gen(function* () {
          const t3Gateway = yield* T3Gateway;

          const result = yield* t3Gateway.planCoordinates(projectId, "main").pipe(Effect.flip);

          expect(result._tag).toBe("RetryableError");

          expect(result.method).toBe("gitWorkflowService.remoteExists");

          const methods = calls.map((call) => call.method);

          expect(methods).toEqual(["getProjectShellById", "remoteExists"]);
        }).pipe(Effect.provide(layer));
      });

      it.effect("fails retryably when fetching origin fails", () => {
        const { layer, calls } = createT3Gateway({
          gwfs: {
            fetchRemoteFails: true,
          },
        });

        const projectId = ProjectId.make("projectId");

        return Effect.gen(function* () {
          const t3Gateway = yield* T3Gateway;

          const result = yield* t3Gateway.planCoordinates(projectId, "main").pipe(Effect.flip);

          expect(result._tag).toBe("RetryableError");

          expect(result.method).toBe("gitWorkflowService.fetchRemote");

          const methods = calls.map((call) => call.method);

          expect(methods).toEqual(["getProjectShellById", "remoteExists", "fetchRemote"]);
        }).pipe(Effect.provide(layer));
      });

      /*
        A non-zero exit could mean the branch is missing, but also a repository read failure; the error does not distinguish them, so the request is retried until its deadline instead of rejected on a guess. Nothing is minted for work that may still run.
      */
      it.effect("fails retryably when resolving the branch tip exits non-zero", () => {
        const { layer, calls } = createT3Gateway({
          gwfs: {
            failBranchResolution: "non-zero-exit",
          },
        });

        const projectId = ProjectId.make("projectId");

        return Effect.gen(function* () {
          const t3Gateway = yield* T3Gateway;

          const result = yield* t3Gateway.planCoordinates(projectId, "main").pipe(Effect.flip);

          expect(result._tag).toBe("RetryableError");
          expect(result.method).toBe("gitWorkflowService.resolveRemoteTrackingCommit");
          expect(result.reason).toContain("Could not resolve branch");

          const methods = calls.map((call) => call.method);

          expect(methods).toEqual([
            "getProjectShellById",
            "remoteExists",
            "fetchRemote",
            "resolveRemoteTrackingCommit",
          ]);
        }).pipe(Effect.provide(layer));
      });

      /*
        A git failure carrying no exit code means git never ran to completion (timeout, spawn failure).
      */
      it.effect("fails retryably when reading the branch tip fails without a git exit code", () => {
        const { layer, calls } = createT3Gateway({
          gwfs: {
            failBranchResolution: "no-exit-code",
          },
        });

        const projectId = ProjectId.make("projectId");

        return Effect.gen(function* () {
          const t3Gateway = yield* T3Gateway;

          const result = yield* t3Gateway.planCoordinates(projectId, "main").pipe(Effect.flip);

          expect(result._tag).toBe("RetryableError");

          expect(result.method).toBe("gitWorkflowService.resolveRemoteTrackingCommit");

          const methods = calls.map((call) => call.method);

          expect(methods).toEqual([
            "getProjectShellById",
            "remoteExists",
            "fetchRemote",
            "resolveRemoteTrackingCommit",
          ]);
        }).pipe(Effect.provide(layer));
      });

      it.effect("fails retryably when the exchange IDs cannot be minted", () => {
        const { layer, calls } = createT3Gateway({
          crypto: {
            failRandomUUIDv4: true,
          },
        });

        const projectId = ProjectId.make("projectId");

        return Effect.gen(function* () {
          const t3Gateway = yield* T3Gateway;

          const result = yield* t3Gateway.planCoordinates(projectId, "main").pipe(Effect.flip);

          expect(result._tag).toBe("RetryableError");

          expect(result.method).toBe("crypto.randomUUIDv4");

          const methods = calls.map((call) => call.method);

          expect(methods).toEqual([
            "getProjectShellById",
            "remoteExists",
            "fetchRemote",
            "resolveRemoteTrackingCommit",
            "randomUUIDv4",
          ]);
        }).pipe(Effect.provide(layer));
      });
    });
  });

  describe("getThreadStatus", () => {
    /**
     * What does getThreadStatus does?
     *
     * It reports whether the T3 thread for the exchange exists ("present") or not ("missing").
     *
     * It runs only once in the processor, for Exchanges that are in the
     * `RequestClaimed` status, in the `processRequesClaimed` effect.
     *
     * It returns the `RequestClaimedContext` needed by the decider function `fromRequestClaimed` to calculate the following policy `RequestClaimedDecision`.
     *
     * The thread can either be "missing" or "present".
     *
     * It can only fail with a RetryableError.
     */
    describe("happy cases", () => {
      it.effect("it returns that the  missing thread", () => {
        const { layer } = createT3Gateway({
          pqsm: {
            isThreadMissing: true,
          },
        });
        return Effect.gen(function* () {
          const t3Gateway = yield* T3Gateway;

          const projectId = ProjectId.make("happy cases - missing thread");

          const coordinates = yield* t3Gateway.planCoordinates(projectId, "main");

          const state = toWorkPlanned(
            makeRequestAccepted(
              {
                attachments: [],
                snapshot: "happy cases - missing thread - snapshot",
                sourceUri: "test://happy-cases-missing-thread-1",
              },
              { projectId, startBranchName: "main" },
              now,
            ),
            coordinates,
            now,
          );

          const result = yield* t3Gateway.getThreadStatus(state);

          expect(result.thread).toBe("missing");
        }).pipe(Effect.provide(layer));
      });

      it.effect("it returns that the thread is present", () => {
        const { layer } = createT3Gateway({
          pqsm: {
            isThreadMissing: false,
          },
        });
        return Effect.gen(function* () {
          const t3Gateway = yield* T3Gateway;

          const projectId = ProjectId.make("happy cases - missing thread");

          const coordinates = yield* t3Gateway.planCoordinates(projectId, "main");

          const state = toWorkPlanned(
            makeRequestAccepted(
              {
                attachments: [],
                snapshot: "happy cases - missing thread - snapshot",
                sourceUri: "test://happy-cases-missing-thread-1",
              },
              { projectId, startBranchName: "main" },
              now,
            ),
            coordinates,
            now,
          );

          const result = yield* t3Gateway.getThreadStatus(state);

          expect(result.thread).toBe("present");
        }).pipe(Effect.provide(layer));
      });
    });

    describe("operational failures", () => {
      // Note: we're really not caring _why_.
      // Albeit, as of writing there's only retryable errors?
      it.effect("cannot get the thread", () => {
        const { layer } = createT3Gateway({
          pqsm: {
            isGetThreadShellByIdError: true,
          },
        });
        return Effect.gen(function* () {
          const t3Gateway = yield* T3Gateway;

          const projectId = ProjectId.make("happy cases - missing thread");

          const coordinates = yield* t3Gateway.planCoordinates(projectId, "main");

          const state = toWorkPlanned(
            makeRequestAccepted(
              {
                attachments: [],
                snapshot: "happy cases - missing thread - snapshot",
                sourceUri: "test://happy-cases-missing-thread-1",
              },
              { projectId, startBranchName: "main" },
              now,
            ),
            coordinates,
            now,
          );

          const result = yield* t3Gateway.getThreadStatus(state).pipe(Effect.flip);

          expect(result._tag).toBe("RetryableError");
        }).pipe(Effect.provide(layer));
      });
    });
  });

  describe("provisionThread", () => {
    /*
      Info: used only once in `processor.ts` in `processRequestClaimed` so when the current status of an exchange is `RequesClaimed`.

      When the exchange is in that status, `getThreadStatus`, tested above, provides the actual context of thread.

      We know that the NTBS system has now received the external request, and saved it along the coordinates minted via `planCoordinates`.

      What we *don't* know is whether the actual T3 thread has been started or not.

      Why is that?

      After thread creation, threads are provisioned, what can happen is that T3 starts the thread but it is not recorded in the NTBS exchange (e.g. thread starts -> app crashes -> thread start doesn't get recorded).

      So we must double check starting from a RequestClaimed Exchange that the thread did not indeed start before.

      What does `provisionThread` even do anyway?

      It handles worktree and thread creation as well as executing setup scripts.

      (N.B. In theory we should skip setup scripts if it was already done as well).

      ## How did it work in the old processor?

      1. create worktree
      2. "thread.create" in orchestrationEngineService.dispatch command
        2.a if anything goes wrong during thread.create -> removes the worktree
      3. run the scripts via projectScriptRunner.runForThread

      Return value: provisionThread returns nothing. TODO: Is there anything important that gets retrieved there (some information)?

      Quite sure the current implementation can be updated and made better than the current void into null and rejection !== null in `processor.ts` as of 6d70ff461df16d1a052ce3656131613647940028.

      What does `provisionThread` depends on?
      1. GitWorkflowService for worktree discovery, creation, and deletion
      2. OrchestrationEngineService for dispatching the command to create the thread
      3. ProjectScriptRunner for executing the scripts in the thread/cwd
    */
    const request: Request = {
      attachments: [],
      snapshot: "come on, do something",
      sourceUri: "test://source-uri",
    };

    const coordinates: WorkCoordinates = {
      projectId: ProjectId.make("projectId"),
      startBranchName: "startBranchName",
      startCommitSha: "startCommitSha",
      threadId: ThreadId.make("threadId"),
      userMessageId: MessageId.make("userMessageId"),
      worktreeBranchName: "worktreeBranchName",
    };

    const target: T3Target = {
      projectId: coordinates.projectId,
      startBranchName: coordinates.startBranchName,
    };

    const workPlanned = toWorkPlanned(makeRequestAccepted(request, target, now), coordinates, now);

    describe("model selection", () => {
      const projectSelection = {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
        options: [{ id: "reasoningEffort", value: "high" }],
      };
      const serverSelection = {
        instanceId: ProviderInstanceId.make("claude-code"),
        model: "claude-sonnet-4-6",
      };

      it.effect.each([
        {
          name: "project overrides server",
          projectModel: projectSelection,
          serverModel: serverSelection,
          expected: projectSelection,
        },
        {
          name: "uses project default when server default is unset",
          projectModel: projectSelection,
          serverModel: null,
          expected: projectSelection,
        },
        {
          name: "inherits server default",
          projectModel: null,
          serverModel: serverSelection,
          expected: serverSelection,
        },
      ])("$name", ({ projectModel, serverModel, expected }) => {
        const { calls, layer } = createT3Gateway({
          pqsm: { getProjectShellById: { success: { defaultModelSelection: projectModel } } },
          serverSettings: ServerSettings.layerTest({ defaultModelSelection: serverModel }),
        });

        return Effect.gen(function* () {
          const gateway = yield* T3Gateway;
          yield* gateway.provisionThread(workPlanned);

          expect(calls.find((call) => call.method === "dispatch")?.input).toMatchObject({
            type: "thread.create",
            modelSelection: expected,
          });
        }).pipe(Effect.provide(layer));
      });

      it.effect("rejects missing defaults before creating a worktree or thread", () => {
        const { calls, layer } = createT3Gateway({
          serverSettings: ServerSettings.layerTest({ defaultModelSelection: null }),
        });

        return Effect.gen(function* () {
          const gateway = yield* T3Gateway;
          const error = yield* gateway.provisionThread(workPlanned).pipe(Effect.flip);

          expect(error).toMatchObject({
            _tag: "FatalError",
            method: "provisionThread",
            reason:
              "No default model is configured for this project or server. Set a model in project or machine settings and submit the request again.",
          });
          expect(calls.map((call) => call.method)).toEqual(["getProjectShellById"]);
        }).pipe(Effect.provide(layer));
      });

      it.effect("retries a settings read failure before creating a worktree or thread", () => {
        const cause = new ServerSettingsError({
          settingsPath: "settingsPath",
          operation: "read-file",
          cause: "Settings unavailable",
        });
        const { calls, layer } = createT3Gateway({
          serverSettings: Layer.mock(ServerSettings.ServerSettingsService, {
            getSettings: Effect.fail(cause),
          }),
        });

        return Effect.gen(function* () {
          const gateway = yield* T3Gateway;
          const error = yield* gateway.provisionThread(workPlanned).pipe(Effect.flip);

          expect(error).toMatchObject({
            _tag: "RetryableError",
            method: "serverSettings.getSettings",
            cause,
          });
          expect(calls.map((call) => call.method)).toEqual(["getProjectShellById"]);
        }).pipe(Effect.provide(layer));
      });
    });

    describe("happy case", () => {
      /*
        Pristine first attempt: `createWorktree` takes the fresh-create arm, dispatch succeeds so the stale-observation recovery never fires, scripts run last.
      */
      it.effect("provisions worktree, thread, and scripts in order from a clean slate", () => {
        const createdWorktreePath = "/git-selected/worktree";
        const { calls, layer } = createT3Gateway({
          gwfs: { createdWorktreePath },
        });

        return Effect.gen(function* () {
          const t3Gateway = yield* T3Gateway;

          yield* t3Gateway.provisionThread(workPlanned);

          expect(calls.map((call) => call.method)).toEqual([
            "getProjectShellById",
            "listRefs",
            "createWorktree",
            "randomUUIDv4",
            "dispatch",
            "runForThread",
          ]);

          // Fresh-create arm, off the commit pinned at claim.
          expect(calls.find((call) => call.method === "createWorktree")?.input).toMatchObject({
            path: null,
            refName: coordinates.startCommitSha,
            newRefName: coordinates.worktreeBranchName,
            baseRefName: coordinates.startBranchName,
          });
          expect(calls.find((call) => call.method === "dispatch")?.input).toMatchObject({
            type: "thread.create",
            worktreePath: createdWorktreePath,
          });
          expect(calls.find((call) => call.method === "runForThread")?.input).toMatchObject({
            worktreePath: createdWorktreePath,
          });
        }).pipe(Effect.provide(layer));
      });

      /*
        A failed dispatch is not trusted at face value: the "thread is missing" observation that led us here can be stale (crash after a committed create, projection lag), so the gateway re-checks and adopts the existing thread.
        Note the scripts still run — skipping them when provisioning already completed is an open TODO.
      */
      it.effect("succeeds when dispatch fails because the thread already exists", () => {
        const { calls, layer } = createT3Gateway({
          orchestrationEngine: { dispatchFails: true },
        });

        return Effect.gen(function* () {
          const t3Gateway = yield* T3Gateway;

          yield* t3Gateway.provisionThread(workPlanned);

          expect(calls.map((call) => call.method)).toEqual([
            "getProjectShellById",
            "listRefs",
            "createWorktree",
            "randomUUIDv4",
            "dispatch",
            "getThreadShellById",
            "runForThread",
          ]);
        }).pipe(Effect.provide(layer));
      });

      /*
        Resume: the path already holds a checkout of the minted branch, so git is asked, agrees, and no worktree work happens at all.
      */
      it.effect("reuses an intact worktree left by an interrupted attempt", () => {
        const { calls, layer } = createT3Gateway({
          fileSystem: { worktreePathExists: true },
          gwfs: {
            worktreeBranchExists: true,
            worktreeBranchPath: "/existing/worktree",
            localStatus: { isRepo: true, refName: coordinates.worktreeBranchName },
          },
        });

        return Effect.gen(function* () {
          const t3Gateway = yield* T3Gateway;

          yield* t3Gateway.provisionThread(workPlanned);

          expect(calls.map((call) => call.method)).toEqual([
            "getProjectShellById",
            "listRefs",
            "exists",
            "localStatus",
            "randomUUIDv4",
            "dispatch",
            "runForThread",
          ]);
        }).pipe(Effect.provide(layer));
      });

      /*
        Resume: Git reports the branch at a path that no longer contains its checkout, so the path is cleared and the surviving branch is checked out again.
      */
      it.effect("replaces debris at a registered worktree path", () => {
        const { calls, layer } = createT3Gateway({
          fileSystem: { worktreePathExists: true },
          gwfs: {
            worktreeBranchExists: true,
            worktreeBranchPath: "/existing/worktree",
            localStatus: { isRepo: false },
          },
        });

        return Effect.gen(function* () {
          const t3Gateway = yield* T3Gateway;

          yield* t3Gateway.provisionThread(workPlanned);

          expect(calls.map((call) => call.method)).toEqual([
            "getProjectShellById",
            "listRefs",
            "exists",
            "localStatus",
            "removeWorktree",
            "createWorktree",
            "randomUUIDv4",
            "dispatch",
            "runForThread",
          ]);

          const createInput = calls.find((call) => call.method === "createWorktree")?.input;
          expect(createInput).toMatchObject({
            path: null,
            refName: coordinates.worktreeBranchName,
          });
          expect(createInput).not.toHaveProperty("newRefName");
        }).pipe(Effect.provide(layer));
      });

      it.effect("replaces a registered worktree checked out on another branch", () => {
        const { calls, layer } = createT3Gateway({
          fileSystem: { worktreePathExists: true },
          gwfs: {
            worktreeBranchExists: true,
            worktreeBranchPath: "/existing/worktree",
            localStatus: { isRepo: true, refName: "some-other-branch" },
          },
        });

        return Effect.gen(function* () {
          const t3Gateway = yield* T3Gateway;

          yield* t3Gateway.provisionThread(workPlanned);

          // Being a repo is not enough: the ref has to be the minted branch, so this checkout is cleared and recreated like any other debris.
          expect(calls.map((call) => call.method)).toEqual([
            "getProjectShellById",
            "listRefs",
            "exists",
            "localStatus",
            "removeWorktree",
            "createWorktree",
            "randomUUIDv4",
            "dispatch",
            "runForThread",
          ]);

          const createInput = calls.find((call) => call.method === "createWorktree")?.input;
          expect(createInput).toMatchObject({
            path: null,
            refName: coordinates.worktreeBranchName,
          });
          expect(createInput).not.toHaveProperty("newRefName");
        }).pipe(Effect.provide(layer));
      });

      it.effect("prunes a missing registered checkout and recreates it from its branch", () => {
        const { calls, layer } = createT3Gateway({
          gwfs: {
            worktreeBranchExists: true,
            worktreeBranchPath: "/missing/worktree",
          },
        });

        return Effect.gen(function* () {
          const t3Gateway = yield* T3Gateway;

          yield* t3Gateway.provisionThread(workPlanned);

          expect(calls.map((call) => call.method)).toEqual([
            "getProjectShellById",
            "listRefs",
            "exists",
            "pruneWorktrees",
            "createWorktree",
            "randomUUIDv4",
            "dispatch",
            "runForThread",
          ]);
          expect(calls.find((call) => call.method === "createWorktree")?.input).toMatchObject({
            path: null,
            refName: coordinates.worktreeBranchName,
          });
        }).pipe(Effect.provide(layer));
      });

      /*
        Resume: a crashed attempt created the branch but not the checkout, so the branch is checked out instead of re-branching from the start commit.
      */
      it.effect(
        "checks out a branch surviving from a crashed attempt instead of re-creating it",
        () => {
          const { calls, layer } = createT3Gateway({
            gwfs: { worktreeBranchExists: true },
          });

          return Effect.gen(function* () {
            const t3Gateway = yield* T3Gateway;

            yield* t3Gateway.provisionThread(workPlanned);

            expect(calls.map((call) => call.method)).toEqual([
              "getProjectShellById",
              "listRefs",
              "createWorktree",
              "randomUUIDv4",
              "dispatch",
              "runForThread",
            ]);

            // Checkout arm: the surviving branch itself, no new branch minted.
            const createInput = calls.find((call) => call.method === "createWorktree")?.input;
            expect(createInput).toMatchObject({ refName: coordinates.worktreeBranchName });
            expect(createInput).not.toHaveProperty("newRefName");
          }).pipe(Effect.provide(layer));
        },
      );
    });

    describe("failures", () => {
      /*
        The project is refetched here because planning's snapshot may be stale or the project may have been deleted since. A failed lookup is operational, so the pass retries before touching Git or T3.
      */
      it.effect("fails retryably when re-fetching the project fails", () => {
        const { calls, layer } = createT3Gateway({
          pqsm: { getProjectShellById: { failure: "no project resolving" } },
        });

        return Effect.gen(function* () {
          const t3Gateway = yield* T3Gateway;

          const result = yield* t3Gateway.provisionThread(workPlanned).pipe(Effect.flip);

          expect(result._tag).toBe("RetryableError");
          expect(result.method).toBe("projectionSnapshotQuery.getProjectShellById");
          expect(calls.map((call) => call.method)).toEqual(["getProjectShellById"]);
        }).pipe(Effect.provide(layer));
      });

      it.effect(
        "fails retryably when dispatch fails operationally and the thread is genuinely missing",
        () => {
          const { calls, layer } = createT3Gateway({
            orchestrationEngine: { dispatchFails: true },
            pqsm: { isThreadMissing: true },
          });

          return Effect.gen(function* () {
            const t3Gateway = yield* T3Gateway;

            const result = yield* t3Gateway.provisionThread(workPlanned).pipe(Effect.flip);

            expect(result._tag).toBe("RetryableError");
            expect(result.method).toBe("orchestrationEngine.dispatch");

            /*
            A retryable failure cleans up nothing: no removeWorktree, no scripts.
          */
            expect(calls.map((call) => call.method)).toEqual([
              "getProjectShellById",
              "listRefs",
              "createWorktree",
              "randomUUIDv4",
              "dispatch",
              "getThreadShellById",
            ]);
          }).pipe(Effect.provide(layer));
        },
      );

      it.effect(
        "fails fatally when T3 rejects creation and the thread is genuinely missing",
        () => {
          const { calls, layer } = createT3Gateway({
            orchestrationEngine: { dispatchFails: "invariant" },
            pqsm: { isThreadMissing: true },
          });

          return Effect.gen(function* () {
            const t3Gateway = yield* T3Gateway;

            const result = yield* t3Gateway.provisionThread(workPlanned).pipe(Effect.flip);

            expect(result._tag).toBe("FatalError");
            expect(result.method).toBe("orchestrationEngine.dispatch");
            expect(calls.map((call) => call.method)).toContain("removeWorktree");
            expect(calls.filter((call) => call.method === "dispatch")).toHaveLength(1);
          }).pipe(Effect.provide(layer));
        },
      );

      it.effect("keeps a failed recovery lookup retryable", () => {
        const { layer } = createT3Gateway({
          orchestrationEngine: { dispatchFails: "invariant" },
          pqsm: { isGetThreadShellByIdError: true },
        });

        return Effect.gen(function* () {
          const t3Gateway = yield* T3Gateway;

          const result = yield* t3Gateway.provisionThread(workPlanned).pipe(Effect.flip);

          expect(result._tag).toBe("RetryableError");
          expect(result.method).toBe("projectionSnapshotQuery.getThreadShellById");
        }).pipe(Effect.provide(layer));
      });

      /*
        The one moment ownership truly ends: a fatal error removes the worktree.
      */
      it.effect(
        "fails fatally when setup cannot launch, deleting the thread before its worktree",
        () => {
          const { calls, layer } = createT3Gateway({
            projectSetupScriptRunner: { runForThreadFails: true },
          });

          return Effect.gen(function* () {
            const t3Gateway = yield* T3Gateway;

            const result = yield* t3Gateway.provisionThread(workPlanned).pipe(Effect.flip);

            expect(result._tag).toBe("FatalError");
            expect(result.method).toBe("projectScriptRunner.runForThread");

            expect(calls.map((call) => call.method)).toEqual([
              "getProjectShellById",
              "listRefs",
              "createWorktree",
              "randomUUIDv4",
              "dispatch",
              "runForThread",
              "randomUUIDv4",
              "dispatch",
              "removeWorktree",
            ]);
          }).pipe(Effect.provide(layer));
        },
      );

      /*
        Reproduces the orphan half of H3: removing the worktree while leaving the thread behind
        points T3 at a path that no longer exists. A fatal provisioning failure after the thread was
        created must delete that thread too.
      */
      it.effect("deletes the thread it created when provisioning fails fatally", () => {
        const { calls, layer } = createT3Gateway({
          projectSetupScriptRunner: { runForThreadFails: true },
        });

        return Effect.gen(function* () {
          const t3Gateway = yield* T3Gateway;

          yield* t3Gateway.provisionThread(workPlanned).pipe(Effect.flip);

          const dispatched = calls
            .filter((call) => call.method === "dispatch")
            .map((call) => call.input);

          expect(calls.map((call) => call.method)).toContain("removeWorktree");
          expect(dispatched).toContainEqual(
            expect.objectContaining({
              type: "thread.delete",
              threadId: workPlanned.t3.threadId,
            }),
          );
        }).pipe(Effect.provide(layer));
      });

      it.effect("keeps the worktree when thread deletion fails, preserving the setup error", () => {
        const { calls, layer } = createT3Gateway({
          orchestrationEngine: { deleteFails: true },
          projectSetupScriptRunner: { runForThreadFails: true },
        });

        return Effect.gen(function* () {
          const gateway = yield* T3Gateway;
          const error = yield* gateway.provisionThread(workPlanned).pipe(Effect.flip);

          expect(error._tag).toBe("FatalError");
          expect(error.method).toBe("projectScriptRunner.runForThread");
          expect(
            calls.filter((call) => call.method === "dispatch").map((call) => call.input),
          ).toContainEqual(
            expect.objectContaining({
              type: "thread.delete",
              threadId: workPlanned.t3.threadId,
            }),
          );
          expect(calls.map((call) => call.method)).not.toContain("removeWorktree");
        }).pipe(Effect.provide(layer));
      });

      it.effect("keeps a recovered thread and its worktree when setup cannot launch", () => {
        const { calls, layer } = createT3Gateway({
          orchestrationEngine: { dispatchFails: "invariant" },
          projectSetupScriptRunner: { runForThreadFails: true },
        });

        return Effect.gen(function* () {
          const gateway = yield* T3Gateway;
          const error = yield* gateway.provisionThread(workPlanned).pipe(Effect.flip);

          expect(error._tag).toBe("FatalError");
          expect(error.method).toBe("projectScriptRunner.runForThread");
          expect(calls.map((call) => call.method)).toContain("getThreadShellById");
          expect(calls.filter((call) => call.method === "dispatch")).toHaveLength(1);
          expect(calls.map((call) => call.method)).not.toContain("removeWorktree");
        }).pipe(Effect.provide(layer));
      });

      /*
        An unexpected stale registration that was not discoverable from our branch cannot be cleaned up safely.
      */
      it.effect(
        "fails fatally when worktree creation finds an unrelated stale registration",
        () => {
          const { calls, layer } = createT3Gateway({
            gwfs: {
              createWorkreeFails: { detail: "'/worktreesDir/x' is missing but already registered" },
            },
          });

          return Effect.gen(function* () {
            const t3Gateway = yield* T3Gateway;

            const result = yield* t3Gateway.provisionThread(workPlanned).pipe(Effect.flip);

            expect(result._tag).toBe("FatalError");
            expect(result.method).toBe("gitWorkflowService.createWorktree");

            expect(calls.map((call) => call.method)).toEqual([
              "getProjectShellById",
              "listRefs",
              "createWorktree",
            ]);
          }).pipe(Effect.provide(layer));
        },
      );

      /*
        The same stale registration, reported by Git as locked rather than already registered: still not ours to clean up safely.
      */
      it.effect("fails fatally when worktree creation finds a locked stale registration", () => {
        const { calls, layer } = createT3Gateway({
          gwfs: { createWorkreeFails: { detail: "'/worktreesDir/x' is missing but locked" } },
        });

        return Effect.gen(function* () {
          const t3Gateway = yield* T3Gateway;

          const result = yield* t3Gateway.provisionThread(workPlanned).pipe(Effect.flip);

          expect(result._tag).toBe("FatalError");
          expect(result.method).toBe("gitWorkflowService.createWorktree");
          expect(result.reason).toBe(
            "The worktree path is still registered to a deleted checkout and needs `git worktree prune`",
          );

          expect(calls.map((call) => call.method)).toEqual([
            "getProjectShellById",
            "listRefs",
            "createWorktree",
          ]);
        }).pipe(Effect.provide(layer));
      });

      it.effect("fails retryably when worktree creation fails for any other reason", () => {
        const { calls, layer } = createT3Gateway({
          gwfs: { createWorkreeFails: true },
        });

        return Effect.gen(function* () {
          const t3Gateway = yield* T3Gateway;

          const result = yield* t3Gateway.provisionThread(workPlanned).pipe(Effect.flip);

          expect(result._tag).toBe("RetryableError");
          expect(result.method).toBe("gitWorkflowService.createWorktree");

          // Retryable, so the failed creation attempt is not cleaned up.
          expect(calls.map((call) => call.method)).toEqual([
            "getProjectShellById",
            "listRefs",
            "createWorktree",
          ]);
        }).pipe(Effect.provide(layer));
      });

      /*
        The ensureWorktree walk: every read can fail operationally, and each failure is retryable — nothing was changed yet, so the next pass re-derives the same facts.
      */
      it.effect("fails retryably when checking for a surviving worktree branch fails", () => {
        const { calls, layer } = createT3Gateway({ gwfs: { listRefsFails: true } });

        return Effect.gen(function* () {
          const t3Gateway = yield* T3Gateway;

          const result = yield* t3Gateway.provisionThread(workPlanned).pipe(Effect.flip);

          expect(result._tag).toBe("RetryableError");
          expect(result.method).toBe("gitWorkflowService.listRefs");
          expect(calls.map((call) => call.method)).toEqual(["getProjectShellById", "listRefs"]);
        }).pipe(Effect.provide(layer));
      });

      it.effect("fails retryably when inspecting the worktree path fails", () => {
        const { calls, layer } = createT3Gateway({
          fileSystem: { existsFails: true },
          gwfs: { worktreeBranchExists: true, worktreeBranchPath: "/existing/worktree" },
        });

        return Effect.gen(function* () {
          const t3Gateway = yield* T3Gateway;

          const result = yield* t3Gateway.provisionThread(workPlanned).pipe(Effect.flip);

          expect(result._tag).toBe("RetryableError");
          expect(result.method).toBe("fileSystem.exists");
          expect(calls.map((call) => call.method)).toEqual([
            "getProjectShellById",
            "listRefs",
            "exists",
          ]);
        }).pipe(Effect.provide(layer));
      });

      it.effect("fails retryably when inspecting the existing worktree fails", () => {
        const { calls, layer } = createT3Gateway({
          fileSystem: { worktreePathExists: true },
          gwfs: {
            worktreeBranchExists: true,
            worktreeBranchPath: "/existing/worktree",
            localStatusFails: true,
          },
        });

        return Effect.gen(function* () {
          const t3Gateway = yield* T3Gateway;

          const result = yield* t3Gateway.provisionThread(workPlanned).pipe(Effect.flip);

          expect(result._tag).toBe("RetryableError");
          expect(result.method).toBe("gitWorkflowService.localStatus");
          expect(calls.map((call) => call.method)).toEqual([
            "getProjectShellById",
            "listRefs",
            "exists",
            "localStatus",
          ]);
        }).pipe(Effect.provide(layer));
      });

      it.effect("fails retryably when clearing the leftover path fails both ways", () => {
        const { calls, layer } = createT3Gateway({
          fileSystem: { worktreePathExists: true, removeFails: true },
          gwfs: {
            worktreeBranchExists: true,
            worktreeBranchPath: "/existing/worktree",
            removeWorkTreeFails: true,
          },
        });

        return Effect.gen(function* () {
          const t3Gateway = yield* T3Gateway;

          const result = yield* t3Gateway.provisionThread(workPlanned).pipe(Effect.flip);

          expect(result._tag).toBe("RetryableError");
          expect(result.method).toBe("gitWorkflowService.removeWorktree");
          expect(calls.map((call) => call.method)).toEqual([
            "getProjectShellById",
            "listRefs",
            "exists",
            "localStatus",
            // Git refused, and the filesystem fallback failed with it.
            "removeWorktree",
            "remove",
          ]);
        }).pipe(Effect.provide(layer));
      });

      /*
        Interruption is not a fatal error. The processor times a hung provision out and interrupts
        it, and cleanup must stay reserved for the fatal path: no removeWorktree, so the next
        reconcile pass can still observe whatever the dispatch managed to commit.
      */
      it.effect("keeps the worktree when a provision is interrupted", () => {
        const dispatchStalled = Deferred.makeUnsafe<void>();
        const { calls, layer } = createT3Gateway({
          orchestrationEngine: { dispatchStalls: dispatchStalled },
        });

        return Effect.gen(function* () {
          const t3Gateway = yield* T3Gateway;

          const provision = yield* t3Gateway
            .provisionThread(workPlanned)
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(dispatchStalled);
          yield* Fiber.interrupt(provision);

          expect(calls.map((call) => call.method)).toEqual([
            "getProjectShellById",
            "listRefs",
            "createWorktree",
            "randomUUIDv4",
            "dispatch",
          ]);
        }).pipe(Effect.provide(layer));
      });

      /*
        Cleanup is best-effort: a worktree that also refuses to be removed must not mask the script failure.
      */
      it.effect("still reports the script failure when the cleanup itself fails", () => {
        const { calls, layer } = createT3Gateway({
          projectSetupScriptRunner: { runForThreadFails: true },
          gwfs: { removeWorkTreeFails: true },
        });

        return Effect.gen(function* () {
          const t3Gateway = yield* T3Gateway;

          const result = yield* t3Gateway.provisionThread(workPlanned).pipe(Effect.flip);

          expect(result._tag).toBe("FatalError");
          expect(result.method).toBe("projectScriptRunner.runForThread");

          expect(calls.map((call) => call.method)).toContain("removeWorktree");
        }).pipe(Effect.provide(layer));
      });
    });
  });

  describe("getTurnStatus", () => {
    /*
      What is `getTurnStatus` used for?

      In `processor.ts` it has one single caller, the `processThreadCreated` function.

      By now, we have an Exchange stored as being in the `ThreadCreated` state:
      - we have successfully minted a thread id, a user message id and a new branch name
      - we have used those to create a new worktree whose path derives from the workspace basename and the branch name, and which is associated to that specific thread and external platform request
      - we have stored this information

      And now?

      Operationally only one thing is needed: starting the turn and having the agent do its thing and come up with some response to the original user.

      But what if a turn was started and then some failure/crash caused the turn start not to be recorded by the system? It would make no sense to re-start the turn, or the operation could fail. Thus, the first thing we want to do when processing a `ThreadCreated` exchange is to verify whether it already started a turn and verify its status.

      Note that the answer is not binary: `ThreadCreatedContext` reports the turn as "missing", "active" or "completed" (carrying the reply), and `fromThreadCreated` maps those to `start-turn`, `wait` and `record-reply-pending` respectively.

      And thus, here, we verify the behavior of `getTurnStatus` on T3Gateway service.
    */

    const threadCreated = toThreadCreated(
      toWorkPlanned(
        makeRequestAccepted(
          {
            attachments: [],
            snapshot: "getTurnStatus - snapshot",
            sourceUri: "test://get-turn-status",
          },
          { projectId: ProjectId.make("projectId"), startBranchName: "startBranchName" },
          now,
        ),
        {
          projectId: ProjectId.make("projectId"),
          startBranchName: "startBranchName",
          startCommitSha: "startCommitSha",
          threadId: ThreadId.make("threadId"),
          userMessageId: MessageId.make("userMessageId"),
          worktreeBranchName: "worktreeBranchName",
        },
        now,
      ),
      now,
    );

    /** The coordinates every reply out of our turn carries. */
    const turn = {
      threadId: threadCreated.t3.threadId,
      userMessageId: threadCreated.t3.userMessageId,
      turnId: TurnId.make("turnId"),
    };

    const settled = { type: "settled", ...turn } as const;

    // A failure observed before any turn adopted our message.
    const settledWithoutTurn = { type: "settled", ...turn, turnId: null } as const;

    /**
     * A projected turn on the exchange's thread. Defaults describe the turn our own message
     * started; tests override `pendingMessageId` to plant other messages' turns, and `state` /
     * `assistantMessageId` to shape the outcome.
     */
    const makeProjectionTurn = (input?: Partial<ProjectionTurn>): ProjectionTurn => ({
      threadId: threadCreated.t3.threadId,
      turnId: TurnId.make("turnId"),
      pendingMessageId: threadCreated.t3.userMessageId,
      sourceProposedPlanThreadId: null,
      sourceProposedPlanId: null,
      assistantMessageId: null,
      state: "pending",
      requestedAt: DateTime.formatIso(DateTime.nowUnsafe()),
      startedAt: null,
      completedAt: null,
      checkpointTurnCount: null,
      checkpointRef: null,
      checkpointStatus: null,
      checkpointFiles: [],
      ...input,
    });

    it.effect("answers { turn: 'missing' } when the thread has no turns at all", () => {
      const { calls, layer } = createT3Gateway({ turnRepository: { turns: [] } });

      return Effect.gen(function* () {
        const t3Gateway = yield* T3Gateway;

        const result = yield* t3Gateway.getTurnStatus(threadCreated);

        expect(result).toEqual({ turn: "missing" });

        // Both lookups are scoped to the exchange's own thread.
        expect(calls).toEqual([
          {
            service: "ProjectionTurnRepository",
            method: "listByThreadId",
            input: { threadId: threadCreated.t3.threadId },
          },
          {
            service: "ProjectionSnapshotQuery",
            method: "getThreadDetailById",
            input: threadCreated.t3.threadId,
          },
        ]);
      }).pipe(Effect.provide(layer));
    });
    /*
      Turns started by other messages (another platform, the web UI) are not ours: "does this
      thread have a turn?" is the wrong question, "did our message start one?" is the right one.
    */
    it.effect(
      "answers { turn: 'missing' } when the thread has turns but none whose pendingMessageId matches the exchange's userMessageId",
      () => {
        const { layer } = createT3Gateway({
          turnRepository: {
            turns: [
              makeProjectionTurn({ pendingMessageId: MessageId.make("someone-else") }),
              makeProjectionTurn({ pendingMessageId: null, state: "completed" }),
            ],
          },
        });

        return Effect.gen(function* () {
          const t3Gateway = yield* T3Gateway;

          const result = yield* t3Gateway.getTurnStatus(threadCreated);

          expect(result).toEqual({ turn: "missing" });
        }).pipe(Effect.provide(layer));
      },
    );
    it.effect("answers { turn: 'active' } when the matching turn is pending", () => {
      const { layer } = createT3Gateway({
        turnRepository: { turns: [makeProjectionTurn({ state: "pending" })] },
      });

      return Effect.gen(function* () {
        const t3Gateway = yield* T3Gateway;

        const result = yield* t3Gateway.getTurnStatus(threadCreated);

        expect(result).toEqual({ turn: "active" });
      }).pipe(Effect.provide(layer));
    });

    it.effect("answers { turn: 'active' } when the matching turn is running", () => {
      const { layer } = createT3Gateway({
        turnRepository: { turns: [makeProjectionTurn({ state: "running" })] },
      });

      return Effect.gen(function* () {
        const t3Gateway = yield* T3Gateway;

        const result = yield* t3Gateway.getTurnStatus(threadCreated);

        expect(result).toEqual({ turn: "active" });
      }).pipe(Effect.provide(layer));
    });
    it.effect(
      "answers a completed turn with an answer reply carrying the assistant message text verbatim",
      () => {
        const assistantMessageId = MessageId.make("assistantMessageId");

        const { layer } = createT3Gateway({
          turnRepository: {
            turns: [makeProjectionTurn({ state: "completed", assistantMessageId })],
          },
          pqsm: {
            threadMessages: [{ id: assistantMessageId, text: "the agent's answer" }],
          },
        });

        return Effect.gen(function* () {
          const t3Gateway = yield* T3Gateway;

          const result = yield* t3Gateway.getTurnStatus(threadCreated);

          expect(result).toEqual({
            turn: "completed",
            reply: { type: "answer", text: "the agent's answer", ...turn },
          });
        }).pipe(Effect.provide(layer));
      },
    );

    it.effect(
      "picks our turn's reply when the thread holds several turns from other messages alongside ours",
      () => {
        const assistantMessageId = MessageId.make("ourAssistantMessageId");
        const foreignAssistantMessageId = MessageId.make("foreignAssistantMessageId");

        const { layer } = createT3Gateway({
          turnRepository: {
            turns: [
              // A completed foreign turn before ours: picking "the first completed turn" would grab this one.
              makeProjectionTurn({
                pendingMessageId: MessageId.make("someone-else"),
                state: "completed",
                assistantMessageId: foreignAssistantMessageId,
              }),
              makeProjectionTurn({ state: "completed", assistantMessageId }),
              makeProjectionTurn({ pendingMessageId: null, state: "running" }),
            ],
          },
          pqsm: {
            threadMessages: [
              { id: foreignAssistantMessageId, text: "someone else's answer" },
              { id: assistantMessageId, text: "our answer" },
            ],
          },
        });

        return Effect.gen(function* () {
          const t3Gateway = yield* T3Gateway;

          const result = yield* t3Gateway.getTurnStatus(threadCreated);

          expect(result).toEqual({
            turn: "completed",
            reply: { type: "answer", text: "our answer", ...turn },
          });
        }).pipe(Effect.provide(layer));
      },
    );
    it.effect(
      "answers a completed turn with a failure reply when the turn has no assistantMessageId",
      () => {
        const { layer } = createT3Gateway({
          turnRepository: {
            turns: [makeProjectionTurn({ state: "completed", assistantMessageId: null })],
          },
        });

        return Effect.gen(function* () {
          const t3Gateway = yield* T3Gateway;

          const result = yield* t3Gateway.getTurnStatus(threadCreated);

          expect(result).toEqual({
            turn: "completed",
            reply: {
              type: "failure",
              text: "T3 completed without producing a response.",
              cause: settled,
            },
          });
        }).pipe(Effect.provide(layer));
      },
    );

    it.effect(
      "answers a completed turn with a failure reply when the assistant message is missing or has empty text",
      () => {
        const assistantMessageId = MessageId.make("assistantMessageId");

        const turns = [makeProjectionTurn({ state: "completed", assistantMessageId })];

        // The turn names an assistant message the thread does not contain.
        const missingMessage = createT3Gateway({
          turnRepository: { turns },
          pqsm: { threadMessages: [] },
        });

        // The message exists but holds nothing worth posting.
        const emptyText = createT3Gateway({
          turnRepository: { turns },
          pqsm: { threadMessages: [{ id: assistantMessageId, text: "  \n  " }] },
        });

        const expected = {
          turn: "completed",
          reply: {
            type: "failure",
            text: "T3 completed without producing a response.",
            cause: settled,
          },
        };

        const getTurnStatus = Effect.gen(function* () {
          const t3Gateway = yield* T3Gateway;
          return yield* t3Gateway.getTurnStatus(threadCreated);
        });

        return Effect.gen(function* () {
          expect(yield* getTurnStatus.pipe(Effect.provide(missingMessage.layer))).toEqual(expected);
          expect(yield* getTurnStatus.pipe(Effect.provide(emptyText.layer))).toEqual(expected);
        });
      },
    );
    it.effect(
      "answers a completed turn with a failure reply carrying session.lastError when the turn errored",
      () => {
        const { layer } = createT3Gateway({
          turnRepository: { turns: [makeProjectionTurn({ state: "error" })] },
          pqsm: { sessionLastError: "provider exploded" },
        });

        return Effect.gen(function* () {
          const t3Gateway = yield* T3Gateway;

          const result = yield* t3Gateway.getTurnStatus(threadCreated);

          expect(result).toEqual({
            turn: "completed",
            reply: { type: "failure", text: "provider exploded", cause: settled },
          });
        }).pipe(Effect.provide(layer));
      },
    );

    it.effect(
      "answers a completed turn with a generic failure reply when the turn errored without a recorded lastError",
      () => {
        const { layer } = createT3Gateway({
          turnRepository: { turns: [makeProjectionTurn({ state: "error" })] },
        });

        return Effect.gen(function* () {
          const t3Gateway = yield* T3Gateway;

          const result = yield* t3Gateway.getTurnStatus(threadCreated);

          expect(result).toEqual({
            turn: "completed",
            reply: {
              type: "failure",
              text: "T3 failed while processing this request.",
              cause: settled,
            },
          });
        }).pipe(Effect.provide(layer));
      },
    );
    it.effect(
      "answers a completed turn with a cancellation reply when the turn was interrupted",
      () => {
        const { layer } = createT3Gateway({
          turnRepository: { turns: [makeProjectionTurn({ state: "interrupted" })] },
        });

        return Effect.gen(function* () {
          const t3Gateway = yield* T3Gateway;

          const result = yield* t3Gateway.getTurnStatus(threadCreated);

          expect(result).toEqual({
            turn: "completed",
            reply: {
              type: "cancellation",
              text: "T3 stopped processing this request.",
              ...turn,
            },
          });
        }).pipe(Effect.provide(layer));
      },
    );

    /*
      An observed fact, not a lookup error: retrying cannot bring the thread back, so the exchange must progress to a failure reply instead of staying open forever.
    */
    it.effect(
      "answers a completed turn with a failure reply when the turn settled but the thread is gone",
      () => {
        const { layer } = createT3Gateway({
          turnRepository: { turns: [makeProjectionTurn({ state: "completed" })] },
          pqsm: { isThreadDetailMissing: true },
        });

        return Effect.gen(function* () {
          const t3Gateway = yield* T3Gateway;

          const result = yield* t3Gateway.getTurnStatus(threadCreated);

          expect(result).toEqual({
            turn: "completed",
            reply: {
              type: "failure",
              text: "T3 finished, but its thread could no longer be found.",
              cause: settled,
            },
          });
        }).pipe(Effect.provide(layer));
      },
    );
    /*
      When the provider fails to start a turn, T3 keeps two facts:
      1. our message on the thread is stored
      2. the session is marked as errored

      The current test verifies that if conditions 1 and 2 are met, but there is no turn retrieved from T3, then we're in an error state.
    */
    it.effect(
      "answers a completed turn with a failure reply when no turn adopted our message and the session errored",
      () => {
        const { layer } = createT3Gateway({
          turnRepository: { turns: [] },
          pqsm: {
            threadMessages: [
              { id: threadCreated.t3.userMessageId, text: "snapshot", role: "user" },
            ],
            sessionStatus: "error",
            sessionLastError: "codex: command not found",
          },
        });

        return Effect.gen(function* () {
          const t3Gateway = yield* T3Gateway;

          const result = yield* t3Gateway.getTurnStatus(threadCreated);

          expect(result).toEqual({
            turn: "completed",
            reply: {
              type: "failure",
              text: "codex: command not found",
              cause: settledWithoutTurn,
            },
          });
        }).pipe(Effect.provide(layer));
      },
    );

    /*
      The previous case checked whether we had both a session error and a message recorded. If we did, we concluded that there was an error provider-side.

      Here, we test the same situation, but without the user message recorded. As T3 saves the message _before_ starting the turn and the turn is not here, we never dispatched the turn start, so it is safe to do it now.
    */
    it.effect(
      "answers { turn: 'missing' } when the session errored but our message never reached the thread",
      () => {
        const { layer } = createT3Gateway({
          turnRepository: { turns: [] },
          pqsm: { sessionStatus: "error", sessionLastError: "codex: command not found" },
        });

        return Effect.gen(function* () {
          const t3Gateway = yield* T3Gateway;

          const result = yield* t3Gateway.getTurnStatus(threadCreated);

          expect(result).toEqual({ turn: "missing" });
        }).pipe(Effect.provide(layer));
      },
    );

    /*
      In ThreadCreated the thread existed. No turn and no thread means it was deleted since, and
      no retry can bring it back.
    */
    it.effect(
      "answers a failure reply when no turn adopted our message and the thread is gone",
      () => {
        const { layer } = createT3Gateway({
          turnRepository: { turns: [] },
          pqsm: { isThreadDetailMissing: true },
        });

        return Effect.gen(function* () {
          const t3Gateway = yield* T3Gateway;

          const result = yield* t3Gateway.getTurnStatus(threadCreated);

          expect(result).toEqual({
            turn: "completed",
            reply: {
              type: "failure",
              text: "T3's thread could no longer be found.",
              cause: settledWithoutTurn,
            },
          });
        }).pipe(Effect.provide(layer));
      },
    );

    it.effect("fails with RetryableError when listing the thread's turns fails", () => {
      const { layer } = createT3Gateway({ turnRepository: { listByThreadIdFails: true } });

      return Effect.gen(function* () {
        const t3Gateway = yield* T3Gateway;

        const result = yield* t3Gateway.getTurnStatus(threadCreated).pipe(Effect.flip);

        expect(result._tag).toBe("RetryableError");
        expect(result.method).toBe("projectionTurnRepository.listByThreadId");
      }).pipe(Effect.provide(layer));
    });

    it.effect("fails with RetryableError when the thread detail fetch fails transiently", () => {
      const { layer } = createT3Gateway({
        turnRepository: { turns: [makeProjectionTurn({ state: "completed" })] },
        pqsm: { isGetThreadDetailByIdError: true },
      });

      return Effect.gen(function* () {
        const t3Gateway = yield* T3Gateway;

        const result = yield* t3Gateway.getTurnStatus(threadCreated).pipe(Effect.flip);

        expect(result._tag).toBe("RetryableError");
        expect(result.method).toBe("projectionSnapshotQuery.getThreadDetailById");
      }).pipe(Effect.provide(layer));
    });

    /*
      The detail fetch exists only to read a settled reply; running it earlier would add a failure mode to arms that need nothing from it.
    */
    it.effect("performs no thread detail lookup when the turn is active", () => {
      const active = createT3Gateway({
        turnRepository: { turns: [makeProjectionTurn({ state: "running" })] },
      });

      return Effect.gen(function* () {
        const t3Gateway = yield* T3Gateway;
        yield* t3Gateway.getTurnStatus(threadCreated);

        expect(active.calls.map((call) => call.method)).toEqual(["listByThreadId"]);
      }).pipe(Effect.provide(active.layer));
    });
  });

  describe("startTurn", () => {
    /*
    What is `startTurn` used for?

    It has a single call site, `processThreadCreated`. From a business-logic perspective the following has happened:
    1. A user on an external platform has sent a message that has been processed and recorded.
    2. A threadId, userMessageId and branch names have been minted for this incoming message.
    3. A `RequestClaimed` is saved to the exchange repository. We now have a durable record of the incoming request and the t3 coordinates of the work associated to it.
    4. A git worktree is created, the branch is checked out, the scripts of the project have been run. a `ThreadCreated` is recorded to the `Exchange` repository.
    5. Now that we have a thread, we want to start the turn, but only if there is no turn already for this very thread and userMessageId. `getTurnStatus` does exactly that: given the `ThreadCreated` it retrieves the related information to determine whether a previous run may have already started a turn that has never been recorded, or never completed.
    6. We now know that we're safe to start the turn.

    So, what do we do in `startTurn`?

    Essentially one thing: dispatch `thread.turn.start` command to the orchestration engine, sending the captured request snapshot as the first user message, under the minted userMessageId, with the stored attachments. That `userMessageId` becomes the turn's `pendingMessageId`, which is exactly the identity `getTurnStatus` matches on.

    Note what `startTurn` does not:
    - It does **not** start a turn in the "physical" sense of waiting for a synchronous confirmation that the turn has effectively started in some harness. It merely returns once the command is dispatched and durably accepted; the provider adopting the turn and running it happens asynchronously after. Even a start failure after this point does not surface at `startTurn` level. It will be catched after, during a `getTurnStatus` run.
    - Needless to say, it doesn't wait for a turn completion either, as it doesn't even wait for it to start.

    Why is "dispatched and durably accepted" enough? Because the engine appends the events and writes the projected turn rows in one SQL transaction, and only then returns.
    `getTurnStatus` reads the very rows that transaction writes, so a crash anywhere leaves both the events and the turn row, or neither: there is no window where a turn started but cannot be seen by the next cycle.
    This matters because a duplicate dispatch would not fail: the decider queues it while our turn is pending or active, or starts a second turn if it already completed.
    So the protection against double starts is never sending one, not recovering from a rejection.

    A successful `startTurn` transitions nothing: the processor returns "unchanged" and the exchange stays `ThreadCreated` until `getTurnStatus` observes a settled turn.

    TODO: Consider listening to t3 events to confirm the turn has started maybe?

    As `startTurn` is an action both error classifications apply. We may get both Retryable as well as Fatal errors.
    */

    const threadCreated = toThreadCreated(
      toWorkPlanned(
        makeRequestAccepted(
          {
            attachments: [],
            snapshot: "please fix the flaky login test",
            sourceUri: "test://start-turn",
          },
          { projectId: ProjectId.make("projectId"), startBranchName: "startBranchName" },
          now,
        ),
        {
          projectId: ProjectId.make("projectId"),
          startBranchName: "startBranchName",
          startCommitSha: "startCommitSha",
          threadId: ThreadId.make("threadId"),
          userMessageId: MessageId.make("userMessageId"),
          worktreeBranchName: "worktreeBranchName",
        },
        now,
      ),
      now,
    );

    /*
      Only the identity relationships are asserted, not the full command payload: the userMessageId linkage is what makes the turn findable by `getTurnStatus`, and minting a fresh id here instead would deadlock every exchange without any error surfacing.
      The command `type` is part of the assertion too, so a `thread.create` carrying a message cannot pass as a turn start.
    */
    it.effect(
      "dispatches the turn start for our thread carrying the snapshot under the exchange's userMessageId",
      () => {
        const { calls, layer } = createT3Gateway();

        return Effect.gen(function* () {
          const t3Gateway = yield* T3Gateway;

          yield* t3Gateway.startTurn(threadCreated);

          const dispatch = calls.find((call) => call.method === "dispatch");
          expect(dispatch?.input).toMatchObject({
            type: "thread.turn.start",
            threadId: threadCreated.t3.threadId,
            message: {
              messageId: threadCreated.t3.userMessageId,
              text: threadCreated.snapshot,
              attachments: threadCreated.attachments,
            },
          });
        }).pipe(Effect.provide(layer));
      },
    );

    it.effect("fails with FatalError when the decider rejects the turn start", () => {
      const { layer } = createT3Gateway({ orchestrationEngine: { dispatchFails: "invariant" } });

      return Effect.gen(function* () {
        const t3Gateway = yield* T3Gateway;

        const result = yield* t3Gateway.startTurn(threadCreated).pipe(Effect.flip);

        expect(result._tag).toBe("FatalError");
        expect(result.method).toBe("orchestrationEngine.dispatch");
      }).pipe(Effect.provide(layer));
    });

    it.effect("fails with RetryableError when the dispatch fails operationally", () => {
      const { layer } = createT3Gateway({ orchestrationEngine: { dispatchFails: true } });

      return Effect.gen(function* () {
        const t3Gateway = yield* T3Gateway;

        const result = yield* t3Gateway.startTurn(threadCreated).pipe(Effect.flip);

        expect(result._tag).toBe("RetryableError");
        expect(result.method).toBe("orchestrationEngine.dispatch");
      }).pipe(Effect.provide(layer));
    });
  });

  describe("threadActivity", () => {
    /*
    `threadActivity` represents the last and final piece of the `t3Gateway`.

    It is the only `T3Gateway` service not returning an effect. Instead it exposes a `Stream` to which the processor has to subscribe.

    And the NTBS processor does exactly that. When the `run` Effect of the NTBS processor is yielded it subscribes to thread activity.

    `subscribeToThreadActivity` does `Stream.runForEach(t3.threadActivity, (threadId) => ...does something with the thread id).

    The important takeaway seems to be the fact that it merely seems to signal that something has happened/changed for some `threadId`. It is then up to the processor to lookup whether that threadId is of interest to the processor or not.

    What does `threadActivity` does in practice then and how does it work? Apparently, it should just subscribe to the main t3 event emitter, filter events for those that related to thread changes and merely stream the threadId of those events. There is no "who's listening" gap here: a `Stream` is a lazy description, and nobody subscribes until someone runs it. `OrchestrationEngineService` exposes `streamDomainEvents`, a `Stream.fromPubSub` that creates a fresh subscription each time it is run, so `threadActivity` is just that stream piped through a filter mapping events to their threadId. The subscription to the engine's PubSub is established exactly when the processor's Stream.runForEach starts, with no separate "start listening" step for `T3Gateway` to perform.

    The filter is an allow-list derived from the projection fields the processor reads, not a guess at which events look important.

    `getThreadStatus` only asks whether the thread row exists: `thread.created` and `thread.deleted`. `getTurnStatus` reads the thread's turns, its session, and its messages: `thread.turn-start-requested`, `thread.turn-interrupt-requested`, `thread.turn-diff-completed`, and `thread.session-set` can change turn state; non-streaming `thread.message-sent` adds the user message used to recognize a failed start or the assistant's final reply; `thread.messages-resynced` and `thread.reverted` rewrite the message rows it scans. Thread metadata (`thread.meta-updated`) is out because it changes none of this data. If a read grows a new dependency, this list grows with it — a field an event writes but the filter drops strands the exchange until the next sweep.

    Activity is the one payload-dependent exception. Ordinary `thread.activity-appended` events are noise, but two kinds mutate turn rows: `context-compaction` and `provider.turn.start.failed` both delete the pending turn start, which `listByThreadId` answers from.

    The excluded noise is the bulk of a live turn: streaming deltas are `thread.message-sent` too, with `streaming: true`, and ordinary activity fires as the agent works. Forwarded, they wake the processor for every token, and each wake costs a repository read and a T3 status read to learn nothing — an exchange being observed mid-turn has not moved until its turn settles.

    A ping never arrives "too early". When the engine dispatches a command, everything happens inside one SQL transaction: events appended, projection rows written, receipt stored. Only after that transaction commits does the engine publish the event to the PubSub feeding this stream. So by the time the processor receives a ping for a thread, the database already contains whatever that event changed: when the ping wakes the processor and it calls getTurnStatus, the turn row it queries is guaranteed to reflect the event that caused the ping. There is no window where we get pinged "turn completed", read the projection, and still see the turn as running. Without this ordering we would need retry-until-visible logic; with it, ping then read is safe as-is.

    But a ping can fail to arrive at all. The PubSub only delivers to subscribers that exist at publish time. If an event fires while nobody is subscribed — the classic case being server startup, before the processor has forked its Stream.runForEach — that ping is simply gone. Nothing replays it. The design accepts that because missed pings are covered elsewhere: startup recovery re-drives every non-terminal exchange when the processor boots, and the planned sweeper periodically re-drives non-terminal exchanges. The ping is an optimization for latency — react immediately instead of waiting for the next sweep — not the mechanism correctness depends on. Pings we do get are always safe to act on immediately; pings we don't get are someone else's job to compensate for.
    */

    const threadId = ThreadId.make("activity-thread");
    const projectId = ProjectId.make("activity-project");

    const baseEventFields = {
      sequence: 0,
      occurredAt: "2026-01-01T00:00:00.000Z",
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
    } as const;

    const threadEvent: OrchestrationEvent = {
      ...baseEventFields,
      type: "thread.session-set",
      eventId: EventId.make("thread-event"),
      aggregateKind: "thread",
      aggregateId: threadId,
      payload: {
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: null,
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    };

    const projectEvent: OrchestrationEvent = {
      ...baseEventFields,
      type: "project.deleted",
      eventId: EventId.make("project-event"),
      aggregateKind: "project",
      aggregateId: projectId,
      payload: { projectId, deletedAt: "2026-01-01T00:00:00.000Z" },
    };

    const messageSentEvent = (
      eventId: string,
      messageId: MessageId,
      streaming: boolean,
      role: "assistant" | "user" = "assistant",
    ): OrchestrationEvent => ({
      ...baseEventFields,
      type: "thread.message-sent",
      eventId: EventId.make(eventId),
      aggregateKind: "thread",
      aggregateId: threadId,
      payload: {
        threadId,
        messageId,
        role,
        text: role === "user" ? "the request" : streaming ? "partial ans" : "the answer",
        turnId: role === "user" ? null : TurnId.make("turn-1"),
        streaming,
        createdAt: baseEventFields.occurredAt,
        updatedAt: baseEventFields.occurredAt,
      },
    });

    const activityEvent: OrchestrationEvent = {
      ...baseEventFields,
      type: "thread.activity-appended",
      eventId: EventId.make("activity-event"),
      aggregateKind: "thread",
      aggregateId: threadId,
      payload: {
        threadId,
        activity: {
          id: EventId.make("activity-1"),
          tone: "tool",
          kind: "command",
          summary: "ran a command",
          payload: null,
          turnId: null,
          createdAt: baseEventFields.occurredAt,
        },
      },
    };

    /*
      One event per field group the processor's reads depend on: thread existence, turn state, session state, the user message and final reply, message resync and revert, and the two activity kinds that delete a pending turn start.
    */
    const keptEvents: ReadonlyArray<OrchestrationEvent> = [
      {
        ...baseEventFields,
        type: "thread.created",
        eventId: EventId.make("created-event"),
        aggregateKind: "thread",
        aggregateId: threadId,
        payload: {
          threadId,
          projectId,
          title: "activity thread",
          modelSelection: {
            instanceId: ProviderInstanceId.make("instanceId"),
            model: "custom",
            options: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: "/tmp/activity-thread",
          createdAt: baseEventFields.occurredAt,
          updatedAt: baseEventFields.occurredAt,
        },
      },
      {
        ...baseEventFields,
        type: "thread.turn-start-requested",
        eventId: EventId.make("turn-start-event"),
        aggregateKind: "thread",
        aggregateId: threadId,
        payload: {
          threadId,
          messageId: MessageId.make("turn-message"),
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: baseEventFields.occurredAt,
        },
      },
      {
        ...baseEventFields,
        type: "thread.turn-interrupt-requested",
        eventId: EventId.make("turn-interrupt-event"),
        aggregateKind: "thread",
        aggregateId: threadId,
        payload: {
          threadId,
          turnId: TurnId.make("turn-1"),
          createdAt: baseEventFields.occurredAt,
        },
      },
      {
        ...baseEventFields,
        type: "thread.turn-diff-completed",
        eventId: EventId.make("turn-diff-event"),
        aggregateKind: "thread",
        aggregateId: threadId,
        payload: {
          threadId,
          turnId: TurnId.make("turn-1"),
          checkpointTurnCount: 1,
          checkpointRef: CheckpointRef.make("refs/t3/checkpoints/activity-thread/turn/1"),
          status: "ready",
          files: [],
          assistantMessageId: MessageId.make("complete-message"),
          completedAt: baseEventFields.occurredAt,
        },
      },
      messageSentEvent("user-event", MessageId.make("turn-message"), false, "user"),
      messageSentEvent("complete-event", MessageId.make("complete-message"), false),
      {
        ...baseEventFields,
        type: "thread.messages-resynced",
        eventId: EventId.make("resynced-event"),
        aggregateKind: "thread",
        aggregateId: threadId,
        payload: {
          threadId,
          afterMessageId: null,
          messages: [
            {
              id: MessageId.make("resynced-message"),
              role: "assistant",
              text: "resynced answer",
              turnId: null,
              streaming: false,
              createdAt: baseEventFields.occurredAt,
              updatedAt: baseEventFields.occurredAt,
            },
          ],
          reason: "provider stream dropped updates",
        },
      },
      {
        ...baseEventFields,
        type: "thread.reverted",
        eventId: EventId.make("reverted-event"),
        aggregateKind: "thread",
        aggregateId: threadId,
        payload: { threadId, turnCount: 1 },
      },
      {
        ...baseEventFields,
        type: "thread.activity-appended",
        eventId: EventId.make("failed-turn-start-event"),
        aggregateKind: "thread",
        aggregateId: threadId,
        payload: {
          threadId,
          activity: {
            id: EventId.make("failed-turn-start-activity"),
            tone: "error",
            kind: "provider.turn.start.failed",
            summary: "Provider turn start failed",
            payload: null,
            turnId: null,
            createdAt: baseEventFields.occurredAt,
          },
        },
      },
      {
        ...baseEventFields,
        type: "thread.activity-appended",
        eventId: EventId.make("compaction-event"),
        aggregateKind: "thread",
        aggregateId: threadId,
        payload: {
          threadId,
          activity: {
            id: EventId.make("compaction-activity"),
            tone: "info",
            kind: "context-compaction",
            summary: "Context compacted",
            payload: { requestId: "turn-message", state: "completed" },
            turnId: null,
            createdAt: baseEventFields.occurredAt,
          },
        },
      },
      {
        ...baseEventFields,
        type: "thread.session-set",
        eventId: EventId.make("session-set-event"),
        aggregateKind: "thread",
        aggregateId: threadId,
        payload: {
          threadId,
          session: {
            threadId,
            status: "running",
            providerName: null,
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: baseEventFields.occurredAt,
          },
        },
      },
      {
        ...baseEventFields,
        type: "thread.deleted",
        eventId: EventId.make("deleted-event"),
        aggregateKind: "thread",
        aggregateId: threadId,
        payload: { threadId, deletedAt: baseEventFields.occurredAt },
      },
    ];

    it.effect("emits the threadId of thread events and drops project events", () => {
      const { layer } = createT3Gateway({
        orchestrationEngine: { domainEvents: [projectEvent, threadEvent] },
      });

      return Effect.gen(function* () {
        const t3Gateway = yield* T3Gateway;

        const emitted = yield* Stream.runCollect(t3Gateway.threadActivity);

        expect(emitted).toEqual([threadId]);
      }).pipe(Effect.provide(layer));
    });

    /*
      A streaming turn is the loudest thing in the engine: every token is a `thread.message-sent` and every tool call appends an activity. None of it can change an exchange: the processor reacts to turns settling, not to turns progressing. This activity's kind has no projection arm at all, unlike the two exceptional kinds the kept test pins.
    */
    it.effect("drops streaming deltas and ordinary activity appends", () => {
      const { layer } = createT3Gateway({
        orchestrationEngine: {
          domainEvents: [
            messageSentEvent("delta-event", MessageId.make("delta-message"), true),
            activityEvent,
          ],
        },
      });

      return Effect.gen(function* () {
        const t3Gateway = yield* T3Gateway;

        const emitted = yield* Stream.runCollect(t3Gateway.threadActivity);

        expect(emitted).toEqual([]);
      }).pipe(Effect.provide(layer));
    });

    /*
      The counterpart to the drop test: everything the processor's reads can answer differently on has to come through, or an exchange waits for the next one-minute sweep instead of reacting to T3.
    */
    it.effect("emits every event the status reads can change on", () => {
      const { layer } = createT3Gateway({
        orchestrationEngine: { domainEvents: keptEvents },
      });

      return Effect.gen(function* () {
        const t3Gateway = yield* T3Gateway;

        const emitted = yield* Stream.runCollect(t3Gateway.threadActivity);

        expect(emitted).toEqual(keptEvents.map(() => threadId));
      }).pipe(Effect.provide(layer));
    });
  });
});
