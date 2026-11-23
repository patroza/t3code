import { expect, it } from "@effect/vitest";
import {
  AuthSessionId,
  EnvironmentId,
  IdentityUsername,
  ProjectId,
  ProviderInstanceId,
  type OrchestrationV2ThreadShell,
  type Project as ProjectRecord,
} from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as IdentityService from "../../../identity/IdentityService.ts";
import * as ThreadLaunch from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ServerConfig from "../../../config.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as PeerForwarding from "../../../peer/PeerForwarding.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as DocumentText from "../../../provider/DocumentText.ts";
import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../../../vcs/VcsProcess.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as ProjectHandlers from "./handlers.ts";
import { ProjectToolkit } from "./tools.ts";

const projectId = ProjectId.make("project:identity");
const sessionId = AuthSessionId.make("mcp-session");

const harness = (launched: Array<ThreadLaunch.ThreadLaunchInput>) =>
  Layer.mergeAll(
    IdentityService.layerWithPeople([
      { personId: "andreasimonecosta", username: "andreasimonecosta", name: "Andrea" },
    ]),
    Layer.mock(ProviderRegistry.ProviderRegistry)({
      getProviders: Effect.succeed([]),
      refreshWorkspaceSnapshot: () => Effect.succeed([]),
    }),
    ServerSettings.layerTest({}),
    Layer.succeed(McpInvocationContext.McpInvocationContext, {
      environmentId: EnvironmentId.make("environment"),
      requestNamespace: `client:${sessionId}`,
      thread: undefined,
      client: { sessionId, label: "mcpx-server", access: "full-access", hostedAppUrl: undefined },
      issuedAt: 0,
      capabilities: new Set(["orchestration" as const]),
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: () => Effect.succeed(null as OrchestrationV2ThreadShell | null),
    }),
    Layer.mock(ThreadLaunch.ThreadLaunchService)({
      checkWorktreeBase: () => Effect.void,
      launch: (launch) => {
        launched.push(launch);
        return Effect.succeed({
          threadId: launch.threadId,
          projection: {
            thread: {
              id: launch.threadId,
              projectId,
              title: launch.title,
              modelSelection: launch.modelSelection,
            },
            runs: [],
          },
          resumed: false,
        } as unknown as ThreadLaunch.ThreadLaunchResult);
      },
    }),
    Layer.mock(Project.ProjectService)({
      getById: (id) =>
        Effect.succeedSome({
          id,
          workspaceRoot: "/projects/identity",
          defaultModelSelection: {
            instanceId: ProviderInstanceId.make("claudeAgent"),
            model: "claude-opus",
          },
        } as unknown as ProjectRecord),
      workspaceScanDirectory: Effect.succeed,
    }),
    Layer.mock(PeerForwarding.PeerForwarding)({}),
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
      namedProjectsRoot: "/projects",
      isScratchProject: () => Effect.succeed(false),
    }),
    DocumentText.layer.pipe(Layer.provideMerge(NodeServices.layer)),
  ).pipe(
    Layer.provideMerge(GitVcsDriver.layer),
    Layer.provideMerge(VcsProcess.layer),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-launch-identity-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    ),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );

it.effect("an outside MCP client's launch carries the person claimed on its session", () => {
  const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
  return Effect.gen(function* () {
    const identity = yield* IdentityService.IdentityService;
    yield* identity.claim(sessionId, {
      username: IdentityUsername.make("andreasimonecosta"),
      method: "settings",
    });
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer)),
    );
    yield* toolkit
      .handle("t3_thread_launch", {
        projectId,
        title: "Mako MultiPick",
        message: "Fix the packing address",
        workspaceStrategy: { type: "root" },
      })
      .pipe(Stream.unwrap, Stream.runCollect);

    expect(launched).toHaveLength(1);
    expect(launched[0]?.initialMessage?.source).toMatchObject({
      personId: "andreasimonecosta",
      username: "andreasimonecosta",
    });
  }).pipe(Effect.provide(harness(launched)));
});
