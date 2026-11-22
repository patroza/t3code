import { AuthOrchestrationOperateScope, RuntimeMode } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { CliError, Flag } from "effect/cli";

import { MCP_CLIENT_SUBJECT } from "../auth/EnvironmentAuth.ts";

/** `t3 auth session issue --runtime-mode-ceiling`: lets a headless MCP gateway launch above approval-required. */
export const runtimeModeCeilingFlag = Flag.Literals(
  "runtime-mode-ceiling",
  RuntimeMode.literals,
).pipe(
  Flag.withDescription(
    `Highest runtime mode an MCP client token may launch or steer threads in. Requires --subject ${MCP_CLIENT_SUBJECT} and --scope ${AuthOrchestrationOperateScope}; defaults to approval-required.`,
  ),
  Flag.optional,
);

interface CeilingFlags {
  readonly runtimeModeCeiling: Option.Option<RuntimeMode>;
  readonly subject: Option.Option<string>;
  readonly scopes: ReadonlyArray<string>;
}

/** Only operate-scoped mcp-client sessions read the ceiling, so refuse it anywhere else. */
export const issueSessionCeiling = Effect.fn("auth.issueSessionCeiling")(function* (
  flags: CeilingFlags,
) {
  if (Option.isNone(flags.runtimeModeCeiling)) return {};
  if (
    Option.getOrUndefined(flags.subject) !== MCP_CLIENT_SUBJECT ||
    !flags.scopes.includes(AuthOrchestrationOperateScope)
  ) {
    return yield* new CliError.UserError({
      cause: `--runtime-mode-ceiling only applies to MCP client tokens: pass --subject ${MCP_CLIENT_SUBJECT} and --scope ${AuthOrchestrationOperateScope}.`,
    });
  }
  return { runtimeModeCeiling: flags.runtimeModeCeiling.value };
});
