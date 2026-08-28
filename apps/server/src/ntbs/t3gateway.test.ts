import { describe, it, expect } from "@effect/vitest";
import { t3GatewayLive, T3Gateway, RetryableError } from "./t3gateway.ts";
import { Effect, Layer, Option, Ref } from "effect";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionTurnRepository } from "../persistence/Services/ProjectionTurns.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { ProjectSetupScriptRunner } from "../project/ProjectSetupScriptRunner.ts";
import { Crypto } from "effect/Crypto";
import {
  GitCommandError,
  OrchestrationProjectShell,
  OrchestrationThread,
  ProjectId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";
import { toPersistenceSqlError } from "../persistence/Errors.ts";
import { PlatformError, SystemError } from "effect/PlatformError";
import { makeRequestClaimed } from "./exchange.ts";

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

  const record =
    (service: string) =>
    <A>(method: string, input: unknown, value: A) =>
      Effect.sync(() => {
        calls.push({ service, method, input });
        return value;
      });

  return { calls, record };
};

type CallRecord = ReturnType<typeof createCallLog>["record"];

type CryptoInput = {
  failRandomUUIDv4?: boolean;
};

const createCryptoMock = (record: CallRecord, input?: CryptoInput) => {
  const recordCrypto = record("Crypto");

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

const OrchestrationEngineServiceMock = Layer.mock(OrchestrationEngineService, {});

type PSQMInput = {
  getProjectShellById?:
    | {
        success: Partial<OrchestrationProjectShell>;
      }
    | { failure: unknown }
    | { missing: true };
  isThreadMissing?: boolean;
  isGetThreadDetailByIdError?: boolean;
};

const createPSQM = (record: CallRecord, input?: PSQMInput) => {
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
    getThreadDetailById: (threadId) =>
      recordPSQM(
        "getThreadDetailById",
        threadId,
        input?.isThreadMissing
          ? Option.none<OrchestrationThread>()
          : Option.some<OrchestrationThread>({
              activities: [],
              archivedAt: null,
              branch: "some-branch",
              checkpoints: [],
              createdAt: new Date().toISOString(),
              deletedAt: null,
              id: threadId,
              interactionMode: "default",
              latestTurn: null,
              messages: [],
              modelSelection: {
                instanceId: ProviderInstanceId.make("instanceId"),
                model: "custom",
                options: [],
              },
              projectId: ProjectId.make("projectId"),
              pendingTurnStart: null,
              proposedPlans: [],
              queuedMessages: [],
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
          () => !input || input.isGetThreadDetailByIdError !== true,
          () => toPersistenceSqlError("some sql error")("somecause"),
        ),
      ),
  });
};

const ProjectionTurnRepositoryMock = Layer.mock(ProjectionTurnRepository, {});

type GitLayerInput = {
  remoteExists?: boolean;
  resolvedRemoteSha?: string;
  failsBranchResolutionWith?: "retryable" | "fatal";
  remoteExistsFails?: boolean;
  fetchRemoteFails?: boolean;
};

const createGitCommandError = (exitCode?: number) =>
  GitCommandError.make({
    command: "resolve",
    cwd: "",
    detail: "",
    failureKind: "unknown",
    operation: "",
    exitCode,
  });

// TODO: Can't we simplify it by leveraging default values in params?
// we can pass default arguments in JS
const createGitWorkflowServiceMock = (record: CallRecord, input?: GitLayerInput) => {
  const recordGit = record("GitWorkflowService");

  return Layer.mock(GitWorkflowService, {
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

const ProjectSetupScriptRunnerMock = Layer.mock(ProjectSetupScriptRunner, {});

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
}) => {
  const { calls, record } = createCallLog();

  return {
    calls,
    layer: t3GatewayLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          OrchestrationEngineServiceMock,
          createPSQM(record, input?.pqsm),
          ProjectSetupScriptRunnerMock,
          createGitWorkflowServiceMock(record, input?.gwfs),
          ProjectionTurnRepositoryMock,
          createCryptoMock(record, input?.crypto),
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
          Declared once and threaded through the project mock, so the assertions below prove the
          cwd git receives is the workspace the project lookup returned, rather than two literals
          that happen to agree.
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

            // The tag is what the processor branches on to decide between retrying and replying.
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

      // A git failure carrying no exit code means git never ran to completion (timeout, spawn
      // failure) rather than that the branch is missing. Rejecting it would post a wrong reply
      // and kill the request permanently.
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
     * Looks like it returns _a_ turn from a list of turns that belong to the same thread.
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
            isGetThreadDetailByIdError: true,
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
});
