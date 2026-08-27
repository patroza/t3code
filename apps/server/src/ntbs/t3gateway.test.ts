import { describe, it, assert } from "@effect/vitest";
import { t3GatewayLive, T3Gateway } from "./t3gateway.ts";
import { Effect, Layer } from "effect";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionTurnRepository } from "../persistence/Services/ProjectionTurns.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { ProjectSetupScriptRunner } from "../project/ProjectSetupScriptRunner.ts";
import { Crypto } from "effect/Crypto";
import { ProjectId } from "@t3tools/contracts";

/*
T3 Gateway Live is a layer, a constructor of a dependency.

But it needs its own dependencies and we need to provide/mock them.

Let's try using Layer.mock to provide those.
*/
t3GatewayLive;

const CryptoMock = Layer.mock(Crypto, {
  "~effect/platform/Crypto": "~effect/platform/Crypto",
  randomUUIDv4: Effect.succeed("randomUUIDv4"),
  nextDoubleUnsafe: () => 0,
  nextIntUnsafe: () => 0,
});

const OrchestrationEngineServiceMock = Layer.mock(OrchestrationEngineService, {});

const ProjectionSnapshotQueryMock = Layer.mock(ProjectionSnapshotQuery, {});

const ProjectionTurnRepositoryMock = Layer.mock(ProjectionTurnRepository, {});

const GitWorkflowServiceMock = Layer.mock(GitWorkflowService, {});

const ProjectSetupScriptRunnerMock = Layer.mock(ProjectSetupScriptRunner, {});

const t3Dependencies = Layer.mergeAll(
  OrchestrationEngineServiceMock,
  ProjectionSnapshotQueryMock,
  ProjectSetupScriptRunnerMock,
  GitWorkflowServiceMock,
  ProjectionTurnRepositoryMock,
  CryptoMock,
);

describe("T3Gateway", () => {
  describe("planCoordinates", () => {
    describe("successful planning", () => {
      const t3GatewayTest = t3GatewayLive.pipe(Layer.provide(t3Dependencies));

      it.layer(t3GatewayTest)((it) =>
        it.effect("pins the selected branch to the commit fetched from origin", () =>
          Effect.gen(function* () {
            // TODO: Continue from here
            const t3Gateway = yield* T3Gateway;

            const projectId = ProjectId.make("test-1");

            t3Gateway.planCoordinates(projectId, "");
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
