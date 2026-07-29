import { type KimiSettings, type ProviderOptionSelection } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

const KIMI_ACP_FORCE_KILL_AFTER = "1 second";

export interface KimiAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly environment?: NodeJS.ProcessEnv;
}

export function buildKimiAcpSpawnInput(
  settings: Pick<KimiSettings, "binaryPath">,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: settings.binaryPath || "kimi",
    args: ["acp"],
    cwd,
    forceKillAfter: KIMI_ACP_FORCE_KILL_AFTER,
    ...(environment ? { env: environment } : {}),
  };
}

export const makeKimiAcpRuntime = (
  settings: Pick<KimiSettings, "binaryPath">,
  input: KimiAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildKimiAcpSpawnInput(settings, input.cwd, input.environment),
        authMethodId: "login",
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });

export function applyKimiAcpModelSelection<E>(input: {
  readonly runtime: AcpSessionRuntime.AcpSessionRuntime["Service"];
  readonly model: string | null | undefined;
  readonly selections: ReadonlyArray<ProviderOptionSelection> | null | undefined;
  readonly mapError: (context: {
    readonly cause: EffectAcpErrors.AcpError;
    readonly step: "set-config-option" | "set-model";
    readonly configId?: string;
  }) => E;
}): Effect.Effect<void, E> {
  return Effect.gen(function* () {
    const model = input.model?.trim();
    if (model) {
      yield* input.runtime
        .setModel(model)
        .pipe(Effect.mapError((cause) => input.mapError({ cause, step: "set-model" })));
    }
    for (const selection of input.selections ?? []) {
      yield* input.runtime
        .setConfigOption(selection.id, selection.value)
        .pipe(
          Effect.mapError((cause) =>
            input.mapError({ cause, step: "set-config-option", configId: selection.id }),
          ),
        );
    }
  });
}
