import { AuthSessionId, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as IdentityService from "./IdentityService.ts";

/**
 * Writing MCP tools: an outside OAuth client needs an identity claim on its own session while
 * the identity map is on. Providers inherit their thread's source; peer links represent remote work.
 */
export const requireMcpClientIdentityClaim = Effect.gen(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  if (scope.client === undefined || scope.client.linked) return;
  const identity = yield* Effect.serviceOption(IdentityService.IdentityService);
  if (Option.isNone(identity)) return;
  yield* identity.value.requireOperateClaim(AuthSessionId.make(scope.client.sessionId)).pipe(
    Effect.mapError(
      (error) =>
        new OrchestratorMcpFailure({
          code: "capability_denied",
          message: `${error.message} Set this MCP client's identity in Settings → Connections before starting or changing work.`,
        }),
    ),
  );
});
