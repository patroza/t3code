import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  IDENTITY_WS_METHODS,
  clientRpcRequiredScopes,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { requiredScopeForRpcMethod } from "../auth/RpcAuthorization.ts";

describe("identity RPC scopes", () => {
  it.each([
    [IDENTITY_WS_METHODS.identityGetSnapshot, AuthOrchestrationReadScope],
    [IDENTITY_WS_METHODS.identityGetSessionClaim, AuthOrchestrationReadScope],
    [IDENTITY_WS_METHODS.identityClaim, AuthOrchestrationOperateScope],
    [IDENTITY_WS_METHODS.identityClearClaim, AuthOrchestrationOperateScope],
    [IDENTITY_WS_METHODS.identityListClientClaims, AuthAccessReadScope],
    [IDENTITY_WS_METHODS.identitySetClientClaim, AuthAccessWriteScope],
  ])("%s requires %s", (method, scope) => {
    expect(requiredScopeForRpcMethod(method)).toBe(scope);
  });

  it("guards assigning another session's identity in clients too", () => {
    expect(clientRpcRequiredScopes(IDENTITY_WS_METHODS.identitySetClientClaim, undefined)).toEqual([
      AuthAccessWriteScope,
    ]);
  });
});
