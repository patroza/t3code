import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";

import { AuthPreviewOperateScope, EnvironmentAuthorizationError } from "./auth.ts";
import { ThreadId } from "./baseSchemas.ts";
import {
  PreviewAutomationError,
  PreviewAutomationHost,
  PreviewAutomationHostFocus,
  PreviewAutomationResponse,
  PreviewAutomationStreamEvent,
} from "./previewAutomation.ts";

/** Out-of-process browser hosts (the Discord/Teams bot). Merged into `WsRpcGroup`. */
export const PREVIEW_AUTOMATION_HOST_WS_METHODS = {
  previewAutomationConnect: "previewAutomation.connect",
  previewAutomationRespond: "previewAutomation.respond",
  previewAutomationFocusHost: "previewAutomation.focusHost",
} as const;

/** A focus report; with `threadId` it claims (or, unfocused, releases) that thread's operations. */
export const PreviewAutomationHostClaim = Schema.Struct({
  ...PreviewAutomationHostFocus.fields,
  threadId: Schema.optional(ThreadId),
});
export type PreviewAutomationHostClaim = typeof PreviewAutomationHostClaim.Type;

export const PreviewAutomationHostRpcGroup = RpcGroup.make(
  Rpc.make(PREVIEW_AUTOMATION_HOST_WS_METHODS.previewAutomationConnect, {
    payload: PreviewAutomationHost,
    success: PreviewAutomationStreamEvent,
    error: Schema.Union([PreviewAutomationError, EnvironmentAuthorizationError]),
    stream: true,
  }),
  Rpc.make(PREVIEW_AUTOMATION_HOST_WS_METHODS.previewAutomationRespond, {
    payload: PreviewAutomationResponse,
    error: Schema.Union([PreviewAutomationError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(PREVIEW_AUTOMATION_HOST_WS_METHODS.previewAutomationFocusHost, {
    payload: PreviewAutomationHostClaim,
    error: EnvironmentAuthorizationError,
  }),
);

/** Spread into the server's `RPC_REQUIRED_SCOPES`. */
export const PREVIEW_AUTOMATION_HOST_RPC_SCOPES = {
  [PREVIEW_AUTOMATION_HOST_WS_METHODS.previewAutomationConnect]: AuthPreviewOperateScope,
  [PREVIEW_AUTOMATION_HOST_WS_METHODS.previewAutomationRespond]: AuthPreviewOperateScope,
  [PREVIEW_AUTOMATION_HOST_WS_METHODS.previewAutomationFocusHost]: AuthPreviewOperateScope,
} as const;
