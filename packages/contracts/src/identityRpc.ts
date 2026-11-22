import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";

import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
} from "./auth.ts";
import {
  IdentityClaimInput,
  IdentityClaimResult,
  IdentityError,
  IdentityListClientClaimsResult,
  IdentitySessionClaimResult,
  IdentitySetClientClaimInput,
  IdentitySnapshot,
} from "./identity.ts";

/** Session identity (closed-set map claim). Merged into `WsRpcGroup`. */
export const IDENTITY_WS_METHODS = {
  identityGetSnapshot: "identity.getSnapshot",
  identityGetSessionClaim: "identity.getSessionClaim",
  identityClaim: "identity.claim",
  identityClearClaim: "identity.clearClaim",
  identityListClientClaims: "identity.listClientClaims",
  identitySetClientClaim: "identity.setClientClaim",
} as const;

const IdentityRpcError = Schema.Union([IdentityError, EnvironmentAuthorizationError]);

export const IdentityRpcGroup = RpcGroup.make(
  Rpc.make(IDENTITY_WS_METHODS.identityGetSnapshot, {
    payload: Schema.Struct({}),
    success: IdentitySnapshot,
    error: IdentityRpcError,
  }),
  Rpc.make(IDENTITY_WS_METHODS.identityGetSessionClaim, {
    payload: Schema.Struct({}),
    success: IdentitySessionClaimResult,
    error: IdentityRpcError,
  }),
  Rpc.make(IDENTITY_WS_METHODS.identityClaim, {
    payload: IdentityClaimInput,
    success: IdentityClaimResult,
    error: IdentityRpcError,
  }),
  Rpc.make(IDENTITY_WS_METHODS.identityClearClaim, {
    payload: Schema.Struct({}),
    success: Schema.Struct({ cleared: Schema.Boolean }),
    error: IdentityRpcError,
  }),
  Rpc.make(IDENTITY_WS_METHODS.identityListClientClaims, {
    payload: Schema.Struct({}),
    success: IdentityListClientClaimsResult,
    error: IdentityRpcError,
  }),
  Rpc.make(IDENTITY_WS_METHODS.identitySetClientClaim, {
    payload: IdentitySetClientClaimInput,
    success: IdentitySessionClaimResult,
    error: IdentityRpcError,
  }),
);

/** Spread into `CLIENT_GUARDED_RPC_SCOPES`; the server authorizes from the same map. */
export const IDENTITY_RPC_SCOPES = {
  [IDENTITY_WS_METHODS.identityGetSnapshot]: AuthOrchestrationReadScope,
  [IDENTITY_WS_METHODS.identityGetSessionClaim]: AuthOrchestrationReadScope,
  [IDENTITY_WS_METHODS.identityClaim]: AuthOrchestrationOperateScope,
  [IDENTITY_WS_METHODS.identityClearClaim]: AuthOrchestrationOperateScope,
  [IDENTITY_WS_METHODS.identityListClientClaims]: AuthAccessReadScope,
  [IDENTITY_WS_METHODS.identitySetClientClaim]: AuthAccessWriteScope,
} as const;
