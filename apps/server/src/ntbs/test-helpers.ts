import { Effect, Layer } from "effect";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { ProjectId, VcsCreateWorktreeResult } from "@t3tools/contracts";
import type { NTBSInput, PlatformData } from "./lifecycle.ts";
import type { T3Context } from "./processor.ts";

export const createGitLayerMock = () => {
  const gitCalls = {
    createWorktree: [] as unknown[],
    fetchRemote: [] as unknown[],
    resolveRemoteTrackingCommit: [] as unknown[],
    removeWorktree: [] as unknown[],
  };

  const layer = Layer.mock(GitWorkflowService, {
    fetchRemote: (input) =>
      Effect.sync(function () {
        gitCalls.fetchRemote.push(input);
      }),
    resolveRemoteTrackingCommit: (input) =>
      Effect.sync(() => {
        gitCalls.resolveRemoteTrackingCommit.push(input);

        return { commitSha: "input-sha", remoteRefName: input.refName };
      }),
    createWorktree: (input) =>
      Effect.sync(() => {
        gitCalls.createWorktree.push(input);
        return VcsCreateWorktreeResult.make({
          worktree: {
            path: "createworktreepath",
            refName: input.refName,
          },
        });
      }),
    removeWorktree: (input) =>
      Effect.sync(() => {
        gitCalls.removeWorktree.push(input);

        return;
      }),
  });

  return {
    gitCalls,
    layer,
  };
};

export const createAdapterRequest = <Source, Destination>(input: {
  responseDestination: Destination;
  source: Source;
}): {
  request: NTBSInput<PlatformData<Source, Destination>>;
  t3Context: T3Context;
} => ({
  request: {
    snapshot: "This is an ongoing discussion",
    attachments: [],
    platformData: {
      responseDestination: input.responseDestination,
      source: input.source,
    },
  },
  t3Context: {
    baseRef: "fork/dev",
    projectId: ProjectId.make("project"),
  },
});
