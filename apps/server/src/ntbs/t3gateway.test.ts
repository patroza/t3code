import { describe, it, expect } from "@effect/vitest";
import { t3GatewayLive, T3Gateway } from "./t3gateway.ts";
import { Effect, Layer, Option, Ref, FileSystem } from "effect";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionTurnRepository } from "../persistence/Services/ProjectionTurns.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import {
  ProjectSetupScriptOperationError,
  ProjectSetupScriptRunner,
} from "../project/ProjectSetupScriptRunner.ts";
import { Crypto } from "effect/Crypto";
import {
  GitCommandError,
  MessageId,
  OrchestrationProjectShell,
  OrchestrationThreadShell,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  VcsCreateWorktreeResult,
  VcsListRefsResult,
  VcsStatusLocalResult,
} from "@t3tools/contracts";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";
import { toPersistenceSqlError } from "../persistence/Errors.ts";
import { PlatformError, SystemError } from "effect/PlatformError";
import { makeRequestClaimed, type Request, type WorkCoordinates } from "./exchange.ts";
import { ServerConfig } from "../config.ts";
import { LogLevel } from "effect/Config";

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

  return { calls, recordResult, record };
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
  dispatchFails?: boolean;
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
          input?.dispatchFails
            ? Effect.fail(toPersistenceSqlError("some operation")("some cause"))
            : Effect.succeed({ sequence: 0 }),
        ),
      ),
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
                      createdAt: new Date().toUTCString(),
                      updatedAt: new Date().toUTCString(),
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
              createdAt: new Date().toISOString(),
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
              projectId: ProjectId.make("projectId"),
              runtimeMode: "auto",
              session: {
                threadId,
                activeTurnId: null,
                lastError: null,
                providerName: null,
                runtimeMode: "auto",
                status: "ready",
                updatedAt: new Date().toISOString(),
                providerInstanceId: ProviderInstanceId.make("providerInstanceId"),
              },
              settledAt: null,
              settledOverride: "active",
              title: "some title",
              updatedAt: new Date().toISOString(),
              worktreePath: null,
            }),
      ).pipe(
        Effect.filterOrFail(
          () => !input || input.isGetThreadShellByIdError !== true,
          () => toPersistenceSqlError("some sql error")("somecause"),
        ),
      ),
  });
};

const ProjectionTurnRepositoryMock = Layer.mock(ProjectionTurnRepository, {});

type GitLayerInput = {
  createWorkreeFails?: boolean | { detail: string };
  failsBranchResolutionWith?: "retryable" | "fatal";
  fetchRemoteFails?: boolean;
  remoteExists?: boolean;
  remoteExistsFails?: boolean;
  resolvedRemoteSha?: string;
  removeWorkTreeFails?: boolean;
  worktreeBranchExists?: boolean;
  localStatus?: { isRepo?: boolean; refName?: string };
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
                  worktree: { path: callInput.path || "path", refName: callInput.refName },
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
                  worktreePath: null,
                },
              ]
            : [],
          isRepo: true,
          hasPrimaryRemote: true,
          nextCursor: null,
          totalCount: input?.worktreeBranchExists ? 1 : 0,
        }),
      ),
    removeWorktree: (callInput) =>
      record("removeWorktree", callInput).pipe(
        Effect.andThen(() =>
          input?.removeWorkTreeFails ? Effect.fail(createGitCommandError()) : Effect.void,
        ),
      ),

    resolveRemoteTrackingCommit: (callInput) =>
      recordGit("resolveRemoteTrackingCommit", callInput, {
        commitSha: input?.resolvedRemoteSha ?? "sha123",
        remoteRefName: "remoteRefName",
      }).pipe(
        Effect.flatMap((val) =>
          input && input.failsBranchResolutionWith
            ? createGitCommandError(input.failsBranchResolutionWith === "fatal" ? 1 : undefined)
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
      call("runForThread", input).pipe(
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

const serverConfigMock = Layer.mock(ServerConfig, {
  anonymousIdPath: "anonymousIdPath",
  attachmentsDir: "attachmentsDir",
  autoBootstrapProjectFromCwd: false,
  baseDir: "baseDir",
  cwd: "cwd",
  dbPath: "dbPath",
  desktopBootstrapToken: "desktopBootstrapToken",
  devAllowedOrigins: [],
  devUrl: undefined,
  environmentIdPath: "environmentIdPath",
  host: "host",
  keybindingsConfigPath: "keybindingsConfigPath",
  logLevel: LogLevel.make("All"),
  logWebSocketEvents: false,
  logsDir: "logsDir",
  mode: "desktop",
  noBrowser: false,
  otlpExportIntervalMs: 0,
  otlpMetricsUrl: undefined,
  otlpServiceName: "otlpServiceName",
  otlpTracesUrl: "otlpTracesUrl",
  port: 8000,
  providerEventLogPath: "providerEventLogPath",
  providerLogsDir: "providerLogsDir",
  providerStatusCacheDir: "providerStatusCacheDir",
  secretsDir: "secretsDir",
  serverLogPath: "serverLogPath",
  serverRuntimeStatePath: "serverRuntimeStatePath",
  serverTracePath: "serverTracePath",
  settingsPath: "settingsPath",
  startupPresentation: "headless",
  stateDir: "stateDir",
  staticDir: "staticDir",
  tailscaleServeEnabled: false,
  tailscaleServePort: 8001,
  terminalLogsDir: "terminalLogsDir",
  traceBatchWindowMs: 0,
  traceMaxBytes: 1024,
  traceMaxFiles: 80,
  traceMinLevel: LogLevel.make("All"),
  traceTimingEnabled: false,
  worktreesDir: "/worktreesDir",
  desktopTelemetryControlFd: 8002,
  desktopTelemetryFd: 8003,
  resourceMonitorPath: "resourceMonitorPath",
});

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
          ProjectionTurnRepositoryMock,
          createCryptoMock(recordResult, input?.crypto),
          serverConfigMock,
          createFileSystemMock(recordResult, input?.fileSystem),
        ),
      ),
    ),
  };
};

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
            would only restate the mock. What matters is the two relationships the gateway owns:
            the thread and its first message are distinct, and the worktree branch is cut from
            the thread so a stray branch traces back to it.
          */
          expect(coordinates.threadId).not.toEqual(coordinates.userMessageId);
          expect(coordinates.worktreeBranchName).toEqual(
            buildTemporaryWorktreeBranchName(() => coordinates.threadId),
          );

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

      it.effect(
        "rejects a selected branch that is absent after a successful fetch without performing provisioning work",
        () => {
          const { layer, calls } = createT3Gateway({
            gwfs: { failsBranchResolutionWith: "fatal", remoteExists: true },
          });

          const projectId = ProjectId.make("projectId");

          return Effect.gen(function* () {
            const t3Gateway = yield* T3Gateway;

            const result = yield* t3Gateway.planCoordinates(projectId, "main").pipe(Effect.flip);

            expect(result._tag).toBe("FatalError");

            expect(result.method).toBe("gitWorkflowService.resolveRemoteTrackingCommit");

            const methods = calls.map((call) => call.method);

            expect(methods).toEqual([
              "getProjectShellById",
              "remoteExists",
              "fetchRemote",
              "resolveRemoteTrackingCommit",
            ]);
          }).pipe(Effect.provide(layer));
        },
      );
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
        A git failure carrying no exit code means git never ran to completion (timeout, spawn failure) rather than that the branch is missing.
      */
      it.effect("fails retryably when reading the branch tip fails without a git exit code", () => {
        const { layer, calls } = createT3Gateway({
          gwfs: {
            failsBranchResolutionWith: "retryable",
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

          const state = makeRequestClaimed(
            {
              attachments: [],
              snapshot: "happy cases - missing thread - snapshot",
              sourceUri: "test://happy-cases-missing-thread-1",
            },
            coordinates,
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

          const state = makeRequestClaimed(
            {
              attachments: [],
              snapshot: "happy cases - missing thread - snapshot",
              sourceUri: "test://happy-cases-missing-thread-1",
            },
            coordinates,
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

          const state = makeRequestClaimed(
            {
              attachments: [],
              snapshot: "happy cases - missing thread - snapshot",
              sourceUri: "test://happy-cases-missing-thread-1",
            },
            coordinates,
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
      1. ServerConfig to know the worktrees location
      2. GitWorkflowService for worktree creation (and deletion)
      3. OrchestrationEngineService for dispatching the command to create the thread
      4. ProjectScriptRunner for executing the scripts in the thread/cwd
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

    const requestClaimed = makeRequestClaimed(request, coordinates);

    describe("happy case", () => {
      /*
        Pristine first attempt: `createWorktree` takes the fresh-create arm, dispatch succeeds so the stale-observation recovery never fires, scripts run last.
      */
      it.effect("provisions worktree, thread, and scripts in order from a clean slate", () => {
        const { calls, layer } = createT3Gateway();

        return Effect.gen(function* () {
          const t3Gateway = yield* T3Gateway;

          yield* t3Gateway.provisionThread(requestClaimed);

          expect(calls.map((call) => call.method)).toEqual([
            "getProjectShellById",
            "exists",
            "listRefs",
            "createWorktree",
            "randomUUIDv4",
            "dispatch",
            "runForThread",
          ]);

          // Fresh-create arm, off the commit pinned at claim.
          expect(calls.find((call) => call.method === "createWorktree")?.input).toMatchObject({
            refName: coordinates.startCommitSha,
            newRefName: coordinates.worktreeBranchName,
            baseRefName: coordinates.startBranchName,
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

          yield* t3Gateway.provisionThread(requestClaimed);

          expect(calls.map((call) => call.method)).toEqual([
            "getProjectShellById",
            "exists",
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
          gwfs: { localStatus: { isRepo: true, refName: coordinates.worktreeBranchName } },
        });

        return Effect.gen(function* () {
          const t3Gateway = yield* T3Gateway;

          yield* t3Gateway.provisionThread(requestClaimed);

          expect(calls.map((call) => call.method)).toEqual([
            "getProjectShellById",
            "exists",
            "localStatus",
            "randomUUIDv4",
            "dispatch",
            "runForThread",
          ]);
        }).pipe(Effect.provide(layer));
      });

      /*
        Resume: something occupies the path but git does not recognize it as a checkout of the minted branch, so it is destroyed and provisioning restarts from the pinned commit.
      */
      it.effect("destroys debris at the worktree path and creates fresh", () => {
        const { calls, layer } = createT3Gateway({
          fileSystem: { worktreePathExists: true },
          gwfs: { localStatus: { isRepo: false } },
        });

        return Effect.gen(function* () {
          const t3Gateway = yield* T3Gateway;

          yield* t3Gateway.provisionThread(requestClaimed);

          expect(calls.map((call) => call.method)).toEqual([
            "getProjectShellById",
            "exists",
            "localStatus",
            "removeWorktree",
            "listRefs",
            "createWorktree",
            "randomUUIDv4",
            "dispatch",
            "runForThread",
          ]);

          // Fresh-create arm: branch off the pinned commit, not a checkout of a survivor.
          expect(calls.find((call) => call.method === "createWorktree")?.input).toMatchObject({
            refName: coordinates.startCommitSha,
            newRefName: coordinates.worktreeBranchName,
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

            yield* t3Gateway.provisionThread(requestClaimed);

            expect(calls.map((call) => call.method)).toEqual([
              "getProjectShellById",
              "exists",
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
      it.effect("fails retryably when dispatch fails and the thread is genuinely missing", () => {
        const { calls, layer } = createT3Gateway({
          orchestrationEngine: { dispatchFails: true },
          pqsm: { isThreadMissing: true },
        });

        return Effect.gen(function* () {
          const t3Gateway = yield* T3Gateway;

          const result = yield* t3Gateway.provisionThread(requestClaimed).pipe(Effect.flip);

          expect(result._tag).toBe("RetryableError");
          expect(result.method).toBe("orchestrationEngine.dispatch");

          /*
            A retryable failure cleans up nothing: no removeWorktree, no scripts.
          */
          expect(calls.map((call) => call.method)).toEqual([
            "getProjectShellById",
            "exists",
            "listRefs",
            "createWorktree",
            "randomUUIDv4",
            "dispatch",
            "getThreadShellById",
          ]);
        }).pipe(Effect.provide(layer));
      });

      /*
        The one moment ownership truly ends: a fatal error removes the worktree.
      */
      it.effect("fails fatally when setup scripts fail, removing the worktree", () => {
        const { calls, layer } = createT3Gateway({
          projectSetupScriptRunner: { runForThreadFails: true },
        });

        return Effect.gen(function* () {
          const t3Gateway = yield* T3Gateway;

          const result = yield* t3Gateway.provisionThread(requestClaimed).pipe(Effect.flip);

          expect(result._tag).toBe("FatalError");
          expect(result.method).toBe("projectScriptRunner.runForThread");

          expect(calls.map((call) => call.method)).toEqual([
            "getProjectShellById",
            "exists",
            "listRefs",
            "createWorktree",
            "randomUUIDv4",
            "dispatch",
            "runForThread",
            "removeWorktree",
          ]);
        }).pipe(Effect.provide(layer));
      });

      /*
        A worktree path that is still registered to a deleted checkout needs manual `git worktree prune`, so retrying would fail forever.
      */
      it.effect(
        "fails fatally when the worktree path is a stale registration, removing the worktree",
        () => {
          const { calls, layer } = createT3Gateway({
            gwfs: {
              createWorkreeFails: { detail: "'/worktreesDir/x' is missing but already registered" },
            },
          });

          return Effect.gen(function* () {
            const t3Gateway = yield* T3Gateway;

            const result = yield* t3Gateway.provisionThread(requestClaimed).pipe(Effect.flip);

            expect(result._tag).toBe("FatalError");
            expect(result.method).toBe("gitWorkflowService.createWorktree");

            expect(calls.map((call) => call.method)).toEqual([
              "getProjectShellById",
              "exists",
              "listRefs",
              "createWorktree",
              "removeWorktree",
            ]);
          }).pipe(Effect.provide(layer));
        },
      );

      it.effect("fails retryably when worktree creation fails for any other reason", () => {
        const { calls, layer } = createT3Gateway({
          gwfs: { createWorkreeFails: true },
        });

        return Effect.gen(function* () {
          const t3Gateway = yield* T3Gateway;

          const result = yield* t3Gateway.provisionThread(requestClaimed).pipe(Effect.flip);

          expect(result._tag).toBe("RetryableError");
          expect(result.method).toBe("gitWorkflowService.createWorktree");

          // Retryable, so the failed creation attempt is not cleaned up.
          expect(calls.map((call) => call.method)).toEqual([
            "getProjectShellById",
            "exists",
            "listRefs",
            "createWorktree",
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

          const result = yield* t3Gateway.provisionThread(requestClaimed).pipe(Effect.flip);

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

      TODO: `getTurnStatus` is currently a stub that always answers { turn: "missing" }, so this suite stays empty until the real lookup lands — a test written now would only pin the placeholder.
    */

    it.todo("answers { turn: 'missing' } when the thread has no turns at all");
    it.todo(
      "answers { turn: 'missing' } when the thread has turns but none whose pendingMessageId matches the exchange's userMessageId",
    );
    it.todo("answers { turn: 'active' } when the matching turn is pending");
    it.todo("answers { turn: 'active' } when the matching turn is running");
    it.todo(
      "answers a completed turn with an answer reply carrying the assistant message text verbatim",
    );
    it.todo(
      "picks our turn's reply when the thread holds several turns from other messages alongside ours",
    );
    it.todo(
      "answers a completed turn with a failure reply when the turn has no assistantMessageId",
    );
    it.todo(
      "answers a completed turn with a failure reply when the assistant message is missing or has empty text",
    );
    it.todo(
      "answers a completed turn with a failure reply carrying session.lastError when the turn errored",
    );
    it.todo(
      "answers a completed turn with a generic failure reply when the turn errored without a recorded lastError",
    );
    it.todo("answers a completed turn with a cancellation reply when the turn was interrupted");
    it.todo(
      "answers a completed turn with a failure reply when the turn settled but the thread is gone",
    );
    it.todo("fails with RetryableError when listing the thread's turns fails");
    it.todo("fails with RetryableError when the thread detail fetch fails transiently");
    it.todo("performs no thread detail lookup when the turn is missing or active");
  });
});
