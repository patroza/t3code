import { describe, it, expect } from "@effect/vitest";
import { t3GatewayLive, T3Gateway } from "./t3gateway.ts";
import { DateTime, Effect, Layer, Ref, FileSystem } from "effect";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { ProjectStoreV2, ProjectStoreV2Error } from "../orchestration-v2/ProjectStore.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import {
  ProjectSetupScriptRunner,
  ProjectSetupScriptOperationError,
} from "../project/ProjectSetupScriptRunner.ts";
import { Crypto } from "effect/Crypto";
import {
  GitCommandError,
  ProjectId,
  MessageId,
  ThreadId,
  ProviderInstanceId,
  VcsCreateWorktreeResult,
  VcsListRefsResult,
  VcsStatusLocalResult,
} from "@t3tools/contracts";
import { isTemporaryWorktreeBranch } from "@t3tools/shared/git";
import { PlatformError, SystemError } from "effect/PlatformError";
import {
  OrchestratorDispatchError,
  OrchestratorCommandRejectedError,
} from "../orchestration-v2/Orchestrator.ts";
import { v2PullRequestThread } from "../orchestration-v2/testkit/pullRequestFixtures.ts";
import { makeRequestAccepted, toWorkPlanned } from "./exchange.ts";
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
        "~effect/Crypto": "~effect/Crypto",
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

const createT3Gateway = (input?: {
  pqsm?: {
    getProjectShellById?:
      | { success: { workspaceRoot?: string } }
      | { failure: unknown }
      | { missing: true };
  };
  gwfs?: GitLayerInput;
  crypto?: CryptoInput;
  createFails?: boolean;
  createRejected?: boolean;
  recovered?: boolean;
  setupFails?: boolean;
  deleteFails?: boolean;
}) => {
  const { calls, recordResult, record } = createCallLog();
  const projectInput = input?.pqsm?.getProjectShellById;
  const projectRecord = recordResult("ProjectionSnapshotQuery");
  const projects = Layer.mock(ProjectStoreV2, {
    listShells: () =>
      projectRecord("listShells", undefined, null).pipe(
        Effect.andThen(() =>
          projectInput && "failure" in projectInput
            ? Effect.fail(new ProjectStoreV2Error({ operation: "listShells", cause: "somecause" }))
            : Effect.succeed(
                projectInput && "missing" in projectInput
                  ? []
                  : ["test-1", "projectId"].map((id) => ({
                      id: ProjectId.make(id),
                      workspaceRoot:
                        projectInput && "success" in projectInput
                          ? (projectInput.success.workspaceRoot ?? "root")
                          : "root",
                      title: "project-title",
                      createdAt: DateTime.formatIso(DateTime.nowUnsafe()),
                      updatedAt: DateTime.formatIso(DateTime.nowUnsafe()),
                      defaultModelSelection: null,
                      scripts: [],
                      archivedAt: null,
                    })),
              ),
        ),
      ),
  });
  return {
    calls,
    layer: t3GatewayLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          projects,
          Layer.mock(ThreadManagementService, {
            dispatch: (command) =>
              record("ThreadManagementService")("dispatch", command).pipe(
                Effect.andThen(() =>
                  (command.type === "thread.create" &&
                    (input?.createFails || input?.createRejected)) ||
                  (command.type === "thread.delete" && input?.deleteFails)
                    ? Effect.fail(
                        new (input?.createRejected
                          ? OrchestratorCommandRejectedError
                          : OrchestratorDispatchError)({
                          commandId: command.commandId,
                          commandType: command.type,
                        }),
                      )
                    : Effect.succeed({ sequence: 1, storedEvents: [] }),
                ),
              ),
            getThreadShell: (id) =>
              Effect.succeed(
                input?.recovered
                  ? v2PullRequestThread({
                      id,
                      projectId: ProjectId.make("projectId"),
                      title: "Recovered",
                      modelSelection: {
                        instanceId: ProviderInstanceId.make("codex"),
                        model: "gpt-5.4",
                      },
                      runtimeMode: "auto",
                      interactionMode: "default",
                      branch: null,
                      worktreePath: null,
                      pullRequests: [],
                      latestUserMessageAt: null,
                      createdAt: DateTime.formatIso(DateTime.nowUnsafe()),
                      updatedAt: DateTime.formatIso(DateTime.nowUnsafe()),
                      archivedAt: null,
                      settledAt: null,
                      settledOverride: null,
                    })
                  : null,
              ),
          }),
          createGitWorkflowServiceMock(recordResult, record, input?.gwfs),
          createCryptoMock(recordResult, input?.crypto),
          Layer.mock(ProjectSetupScriptRunner, {
            runForThread: (args) =>
              record("ProjectSetupScriptRunner")("runForThread", args).pipe(
                Effect.andThen(() =>
                  input?.setupFails
                    ? Effect.fail(
                        new ProjectSetupScriptOperationError({
                          ...args,
                          operation: "openTerminal",
                          cause: "launch failed",
                        }),
                      )
                    : Effect.succeed({ status: "no-script" as const }),
                ),
              ),
          }),
          FileSystem.layerNoop({}),
          ServerSettings.layerTest({
            defaultModelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5.4",
            },
          }),
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
            threadId: "randomUUID0",
            userMessageId: "randomUUID1",
            worktreeBranchName: "ntbs/randomUUID0",
          });

          /*
            The crypto mock hands out a deterministic sequence, so the ids are pinned exactly rather than matched loosely: the thread is minted before its first message, and the branch carries the thread's id, not the message's.
            `expect.any(String)` would let a swapped or reused identifier through.
          */
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
              method: "listShells",
              input: undefined,
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
                method: "listShells",
                input: undefined,
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

          expect(methods).toEqual(["listShells"]);
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

          expect(methods).toEqual(["listShells", "remoteExists"]);
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

          expect(methods).toEqual(["listShells", "remoteExists", "fetchRemote"]);
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
            "listShells",
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
            "listShells",
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
            "listShells",
            "remoteExists",
            "fetchRemote",
            "resolveRemoteTrackingCommit",
            "randomUUIDv4",
          ]);
        }).pipe(Effect.provide(layer));
      });
    });
  });
});

const workPlanned = toWorkPlanned(
  makeRequestAccepted(
    { attachments: [], snapshot: "Fix the issue", sourceUri: "discord://request" },
    { projectId: ProjectId.make("projectId"), startBranchName: "main" },
    now,
  ),
  {
    projectId: ProjectId.make("projectId"),
    startBranchName: "main",
    startCommitSha: "pinned-sha",
    threadId: ThreadId.make("threadId"),
    userMessageId: MessageId.make("messageId"),
    worktreeBranchName: "ntbs/threadId",
  },
  now,
);
it.effect(
  "provisions the pinned checkout before creating the native thread and launching setup",
  () => {
    const { calls, layer } = createT3Gateway({ gwfs: { createdWorktreePath: "/actual-checkout" } });
    return Effect.gen(function* () {
      const gateway = yield* T3Gateway;
      yield* gateway.provisionThread(workPlanned);
      expect(calls.map((c) => c.method)).toEqual([
        "listShells",
        "listRefs",
        "createWorktree",
        "randomUUIDv4",
        "dispatch",
        "runForThread",
      ]);
      expect(calls.find((c) => c.method === "createWorktree")?.input).toMatchObject({
        refName: "pinned-sha",
        newRefName: "ntbs/threadId",
      });
      expect(calls.find((c) => c.method === "dispatch")?.input).toMatchObject({
        type: "thread.create",
        worktreePath: "/actual-checkout",
        modelSelection: { model: "gpt-5.4" },
        creationSource: "server",
      });
    }).pipe(Effect.provide(layer));
  },
);
it.effect("removes the created thread before its checkout when setup launch fails", () => {
  const { calls, layer } = createT3Gateway({ setupFails: true });
  return Effect.gen(function* () {
    const gateway = yield* T3Gateway;
    const failure = yield* gateway.provisionThread(workPlanned).pipe(Effect.flip);
    expect(failure._tag).toBe("FatalError");
    expect(calls.slice(-2).map((c) => c.method)).toEqual(["dispatch", "removeWorktree"]);
    expect(calls.at(-2)?.input).toMatchObject({ type: "thread.delete" });
  }).pipe(Effect.provide(layer));
});
it.effect("keeps the checkout if deleting its thread fails", () => {
  const { calls, layer } = createT3Gateway({ setupFails: true, deleteFails: true });
  return Effect.gen(function* () {
    const gateway = yield* T3Gateway;
    yield* gateway.provisionThread(workPlanned).pipe(Effect.flip);
    expect(calls.some((c) => c.method === "removeWorktree")).toBe(false);
  }).pipe(Effect.provide(layer));
});
it.effect("keeps a recovered thread and checkout when setup launch fails", () => {
  const { calls, layer } = createT3Gateway({
    createFails: true,
    recovered: true,
    setupFails: true,
  });
  return Effect.gen(function* () {
    const gateway = yield* T3Gateway;
    yield* gateway.provisionThread(workPlanned).pipe(Effect.flip);
    expect(calls.filter((c) => c.method === "dispatch")).toHaveLength(1);
    expect(calls.some((c) => c.method === "removeWorktree")).toBe(false);
  }).pipe(Effect.provide(layer));
});

it.effect("retains partial provisioning on an operational dispatch failure", () => {
  const { calls, layer } = createT3Gateway({ createFails: true });
  return Effect.gen(function* () {
    const gateway = yield* T3Gateway;
    const failure = yield* gateway.provisionThread(workPlanned).pipe(Effect.flip);
    expect(failure._tag).toBe("RetryableError");
    expect(calls.some((c) => c.method === "removeWorktree")).toBe(false);
  }).pipe(Effect.provide(layer));
});
it.effect("cleans up a checkout after a native command rejection", () => {
  const { calls, layer } = createT3Gateway({ createRejected: true });
  return Effect.gen(function* () {
    const gateway = yield* T3Gateway;
    const failure = yield* gateway.provisionThread(workPlanned).pipe(Effect.flip);
    expect(failure._tag).toBe("FatalError");
    expect(calls.at(-1)?.method).toBe("removeWorktree");
  }).pipe(Effect.provide(layer));
});
