import * as Layer from "effect/Layer";

import type { toolkitRegistration } from "./McpHttpServer.ts";

/**
 * Fork-registered MCP toolkits, merged into `layerTools`. Add entries as
 * `register(SomeToolkit, SomeHandlers.layer)`, the same pattern upstream toolkits use.
 * `register` is passed in so this module never imports McpHttpServer at runtime.
 */
export const forkMcpTools = (_register: typeof toolkitRegistration) => Layer.empty;
