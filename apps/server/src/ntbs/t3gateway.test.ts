import { describe, it, expect } from "@effect/vitest";
import { t3GatewayLive, T3Gateway } from "./t3gateway.ts";
import { Effect, Layer, Ref } from "effect";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionTurnRepository } from "../persistence/Services/ProjectionTurns.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { ProjectSetupScriptRunner } from "../project/ProjectSetupScriptRunner.ts";
import { Crypto } from "effect/Crypto";
import { OrchestrationProjectShell, ProjectId } from "@t3tools/contracts";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";
import { toPersistenceSqlError } from "../persistence/Errors.ts";

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

const createCryptoMock = (record: CallRecord) => {
  const recordCrypto = record("Crypto");

  return Layer.unwrap(
    Effect.gen(function* () {
      const counter: Ref.Ref<number> = yield* Ref.make(0);

      return Layer.mock(Crypto, {
        "~effect/platform/Crypto": "~effect/platform/Crypto",
        randomUUIDv4: Ref.getAndUpdate(counter, (num) => num + 1).pipe(
          Effect.flatMap((num) => recordCrypto("randomUUIDv4", undefined, "randomUUID" + num)),
        ),
        nextDoubleUnsafe: () => 0,
        nextIntUnsafe: () => 0,
      });
    }),
  );
};

const OrchestrationEngineServiceMock = Layer.mock(OrchestrationEngineService, {});

type PSQMInput = {
  getProjectShellById:
    | {
        success: Partial<OrchestrationProjectShell>;
      }
    | { failure: unknown }
    | { missing: true };
};

const createPSQM = (record: CallRecord, input?: PSQMInput) => {
  const recordPSQM = record("ProjectionSnapshotQuery");

  const isProjectMissing = input && "missing" in input.getProjectShellById;

  const isGetProjectError = input && "failure" in input.getProjectShellById;

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
                      ...(input &&
                        "success" in input.getProjectShellById && {
                          ...input.getProjectShellById.success,
                        }),
                    }),
              ),
        ),
      ),
  });
};

const ProjectionTurnRepositoryMock = Layer.mock(ProjectionTurnRepository, {});

// TODO: Can't we simplify it by leveraging default values in params?
// we can pass default arguments in JS
const createGitWorkflowServiceMock = (
  record: CallRecord,
  input?: {
    remoteExists?: boolean;
    resolvedRemoteSha?: string;
  },
) => {
  const recordGit = record("GitWorkflowService");

  return Layer.mock(GitWorkflowService, {
    remoteExists: (callInput) =>
      recordGit("remoteExists", callInput, !input ? true : !!input.remoteExists),
    fetchRemote: (callInput) => recordGit("fetchRemote", callInput, undefined),
    resolveRemoteTrackingCommit: (callInput) =>
      recordGit("resolveRemoteTrackingCommit", callInput, {
        commitSha: input?.resolvedRemoteSha ?? "sha123",
        remoteRefName: "remoteRefName",
      }),
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
  gwfs?: {
    remoteExists?: boolean;
  };
}) => {
  const { calls, record } = createCallLog();

  return {
    calls,
    layer: t3GatewayLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          OrchestrationEngineServiceMock,
          createPSQM(record, input?.pqsm ?? { getProjectShellById: { success: {} } }),
          ProjectSetupScriptRunnerMock,
          createGitWorkflowServiceMock(record, input?.gwfs),
          ProjectionTurnRepositoryMock,
          createCryptoMock(record),
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
        - if it cannot load the project due to errors, it will fail with a retryable T3GatewayError
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

    describe("rejected planning", () => {
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
            expect(error._tag).toBe("T3Rejected");

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

      it.todo("rejects a project whose repository has no origin remote");

      it.todo(
        "rejects a selected branch that is absent after a successful fetch without performing provisioning work",
      );
    });

    describe("operational failures", () => {
      it.todo("fails retryably when the project lookup fails");

      it.todo("fails retryably when checking for the origin remote fails");

      it.todo("fails retryably when fetching origin fails");

      // A git failure carrying no exit code means git never ran to completion (timeout, spawn
      // failure) rather than that the branch is missing. Rejecting it would post a wrong reply
      // and kill the request permanently.
      it.todo("fails retryably when reading the branch tip fails without a git exit code");

      it.todo("fails retryably when the exchange IDs cannot be minted");
    });
  });
});
