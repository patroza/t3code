import * as Layer from "effect/Layer";

import * as DiscordLinkedChannelTool from "./DiscordLinkedChannelTool.ts";
import * as DiscordRenameThreadTool from "./DiscordRenameThreadTool.ts";
import type { toolkitRegistration } from "./McpHttpServer.ts";

/**
 * Fork-registered MCP toolkits, merged beside `layerTools` in the served MCP layer, so
 * upstream tests that build `layerTools` (its context budget, its service mocks) never
 * see them. Add entries as `register(SomeToolkit, SomeHandlers.layer)`; `register` is
 * passed in so this module never imports McpHttpServer at runtime.
 */
export const forkMcpTools = (register: typeof toolkitRegistration) =>
  Layer.mergeAll(
    register(DiscordRenameThreadTool.DiscordRenameThreadToolkit, DiscordRenameThreadTool.layer),
    register(DiscordLinkedChannelTool.DiscordLinkedChannelToolkit, DiscordLinkedChannelTool.layer),
  );
