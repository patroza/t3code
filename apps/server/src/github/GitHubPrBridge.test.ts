import * as NodeServices from "@effect/platform-node/NodeServices";
import { EventId, ProjectId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import { ProjectStoreV2, layer as projectStoreLayer } from "../orchestration-v2/ProjectStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { getGitHubProjectShells, matchesGitHubRepository } from "./GitHubPrBridge.ts";

const testLayer = Layer.mergeAll(
  projectStoreLayer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
  RepositoryIdentityResolver.layer.pipe(Layer.provide(ProcessRunner.layer)),
  ProcessRunner.layer,
).pipe(Layer.provideMerge(NodeServices.layer));

it.layer(testLayer)("GitHub PR project discovery", (it) => {
  it.effect("discovers fork and upstream remotes from raw project rows on the first request", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-github-project-" });
      const runner = yield* ProcessRunner.ProcessRunner;
      for (const args of [
        ["init"],
        ["remote", "add", "origin", "https://github.com/patroza/t3code.git"],
        ["remote", "add", "upstream", "https://github.com/pingdotgg/t3code.git"],
      ]) {
        const result = yield* runner.run({ command: "git", args: ["-C", workspaceRoot, ...args] });
        expect(result.code).toBe(0);
      }
      const projects = yield* ProjectStoreV2;
      const projectId = ProjectId.make("github-fork-project");
      const now = "2026-10-12T00:00:00.000Z";
      yield* projects.apply({
        sequence: 1,
        eventId: EventId.make("github-fork-project-created"),
        aggregateKind: "project",
        aggregateId: projectId,
        occurredAt: now,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "project.created",
        payload: {
          projectId,
          title: "T3 Code",
          workspaceRoot,
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });
      expect((yield* projects.listShells())[0]?.repositoryIdentity).toBeNull();

      const shells = yield* getGitHubProjectShells();
      for (const repository of ["patroza/t3code", "pingdotgg/t3code"]) {
        expect(
          shells
            .filter((project) => matchesGitHubRepository(project.repositoryIdentity, repository))
            .map((project) => project.id),
        ).toEqual([projectId]);
      }
      expect(
        shells.some((project) => matchesGitHubRepository(project.repositoryIdentity, "other/repo")),
      ).toBe(false);
    }),
  );
});
