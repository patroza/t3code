import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpServer } from "effect/ai";

import { ProjectStoreV2 } from "../orchestration-v2/ProjectStore.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { RepositoryIdentityResolver } from "../project/RepositoryIdentityResolver.ts";
import { forkMcpTools } from "./forkMcpTools.ts";
import * as McpHttpServer from "./McpHttpServer.ts";

// Registration only stores tool definitions, so the handlers' services are never called.
const layerForkTools = forkMcpTools(McpHttpServer.toolkitRegistration).pipe(
  Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
  Layer.provide(
    Layer.mergeAll(
      Layer.mock(ThreadManagementService)({}),
      Layer.mock(ProjectStoreV2)({}),
      Layer.mock(RepositoryIdentityResolver)({}),
      NodeServices.layer,
      NodeCrypto.layer,
    ),
  ),
);

it.effect("registers the Discord MCP tools", () =>
  Effect.gen(function* () {
    const mcp = yield* McpServer.McpServer;
    expect(mcp.tools.map(({ tool }) => tool.name).toSorted()).toEqual([
      "discord_post_to_linked_channel",
      "discord_rename_thread",
    ]);
  }).pipe(Effect.provide(layerForkTools)),
);
