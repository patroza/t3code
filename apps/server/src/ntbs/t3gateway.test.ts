import { describe, it, expect } from "@effect/vitest";
import { t3GatewayLive, T3Gateway } from "./t3gateway.ts";
import { Effect, Layer, Option } from "effect";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionTurnRepository } from "../persistence/Services/ProjectionTurns.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { ProjectSetupScriptRunner } from "../project/ProjectSetupScriptRunner.ts";
import { Crypto } from "effect/Crypto";
import { OrchestrationProjectShell, ProjectId } from "@t3tools/contracts";

/*
T3 Gateway Live is a layer, a constructor of a dependency.

But it needs its own dependencies and we need to provide/mock them.

Let's try using Layer.mock to provide those.
*/

const CryptoMock = Layer.mock(Crypto, {
  "~effect/platform/Crypto": "~effect/platform/Crypto",
  randomUUIDv4: Effect.succeed("randomUUIDv4"),
  nextDoubleUnsafe: () => 0,
  nextIntUnsafe: () => 0,
});

const OrchestrationEngineServiceMock = Layer.mock(OrchestrationEngineService, {});

type PSQMInput = {
  getProjectShellById:
    | {
        success: Partial<OrchestrationProjectShell>;
      }
    | { failure: unknown };
};

const createPSQM = (input?: PSQMInput) => {
  return Layer.mock(ProjectionSnapshotQuery, {
    getProjectShellById: (projectId) =>
      Effect.option(
        input && "failure" in input.getProjectShellById
          ? Effect.fail(String(input.getProjectShellById.failure))
          : Effect.succeed({
              id: projectId,
              workspaceRoot: "root",
              title: "project-title",
              createdAt: new Date().toUTCString(),
              updatedAt: new Date().toUTCString(),
              defaultModelSelection: null,
              scripts: [],
              ...(input &&
                "success" in input.getProjectShellById && { ...input.getProjectShellById.success }),
            }),
      ),
  });
};

const ProjectionTurnRepositoryMock = Layer.mock(ProjectionTurnRepository, {});

// TODO: Can't we simplify it by leveraging default values in params?
// we can pass default arguments in JS
const createGitWorkflowServiceMock = (input?: {
  remoteExists?: boolean;
  resolvedRemoteSha?: string;
}) =>
  Layer.mock(GitWorkflowService, {
    remoteExists: () => Effect.succeed(!input ? true : !!input.remoteExists),
    fetchRemote: () => Effect.void,
    resolveRemoteTrackingCommit: (_input) =>
      Effect.succeed({
        commitSha: input?.resolvedRemoteSha ?? "sha123",
        remoteRefName: "remoteRefName",
      }),
  });

const ProjectSetupScriptRunnerMock = Layer.mock(ProjectSetupScriptRunner, {});

const t3Dependencies = (input?: {
  pqsm?: {
    getProjectShellById?: {};
  };
  gwfs?: {
    remoteExists?: boolean;
  };
}) =>
  Layer.mergeAll(
    OrchestrationEngineServiceMock,
    createPSQM({
      getProjectShellById: { success: {} },
    }),
    ProjectSetupScriptRunnerMock,
    createGitWorkflowServiceMock(input?.gwfs),
    ProjectionTurnRepositoryMock,
    CryptoMock,
  );

describe("T3Gateway", () => {
  describe("planCoordinates", () => {
    describe("successful planning", () => {
      const t3GatewayTest = t3GatewayLive.pipe(
        Layer.provide(
          t3Dependencies({
            gwfs: { remoteExists: true },
          }),
        ),
      );

      it.layer(t3GatewayTest)((it) =>
        it.effect("pins the selected branch to the commit fetched from origin", () =>
          Effect.gen(function* () {
            // TODO: Continue from here
            const t3Gateway = yield* T3Gateway;

            const projectId = ProjectId.make("test-1");

            /*
            Recap. This will, in order:
            - fetch the project details for projectId
              - if it cannot load the project due to errors, it will fail with a retryable T3GatewayError
              - it if can:
                - if the project exists: it will return it
                - if it does not: it will fail with a T3Rejected error, one that cannot be retried
            */
            const coordinates = yield* t3Gateway.planCoordinates(projectId, "main");

            expect(coordinates).toEqual({
              projectId,
              startBranchName: "main",
              startCommitSha: "sha123",
              threadId: "randomUUIDv4", // why?
              userMessageId: "randomUUIDv4", // why?
              worktreeBranchName: "t3code/add4", // why is it this specific value?
            });
          }),
        ),
      );

      it.todo(
        "returns the project, branch and commit with distinct thread and message IDs and a worktree branch derived from the thread ID",
      );
    });

    describe("rejected planning", () => {
      it.todo("rejects a project that does not exist without performing provisioning work");

      it.todo("rejects a project whose repository has no origin remote");

      it.todo(
        "rejects a selected branch that is absent after a successful fetch without performing provisioning work",
      );
    });

    describe("operational failures", () => {
      it.todo("fails retryably when the project lookup fails");

      it.todo("fails retryably when checking for the origin remote fails");

      it.todo("fails retryably when fetching origin fails");

      it.todo("fails retryably when the exchange IDs cannot be minted");
    });
  });
});
