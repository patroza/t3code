import { KimiSettings, ProviderDriverKind } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/process";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import {
  applyKimiAcpModelSelection,
  makeKimiAcpRuntime,
} from "../../provider/acp/KimiAcpSupport.ts";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
  type ProviderAdapterDriverCreateInput,
} from "@t3tools/provider-core/server/adapterDriver";
import { AcpProviderCapabilitiesV2, makeAcpAdapterV2 } from "@t3tools/provider-acp/server/adapter";

const decodeKimiSettings = Schema.decodeUnknownSync(KimiSettings);
const DRIVER = ProviderDriverKind.make("kimi");
export type KimiAdapterV2DriverEnv =
  | Crypto.Crypto
  | FileSystem.FileSystem
  | ChildProcessSpawner.ChildProcessSpawner
  | IdAllocator.IdAllocatorV2
  | ProviderHost.ProviderHost
  | McpProviderSessions.McpProviderSessions
  | Path.Path;
export const KimiAdapterV2Driver: ProviderAdapterDriver<KimiSettings, KimiAdapterV2DriverEnv> = {
  driverKind: DRIVER,
  configSchema: KimiSettings,
  defaultConfig: () => decodeKimiSettings({}),
  create: Effect.fn("KimiAdapterV2Driver.create")(
    function* (input: ProviderAdapterDriverCreateInput<KimiSettings>) {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const hostEnvironment = yield* HostProcess.Environment;
      const environment = yield* mergeProviderInstanceEnvironment(
        input.environment,
        hostEnvironment,
      );
      const selfInvocation = yield* resolveSelfInvocation();
      return yield* makeAcpAdapterV2({
        instanceId: input.instanceId,
        selfInvocation,
        flavor: {
          driver: DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          resolveModelId: (selection) => selection.model.trim(),
          applyModelSelection: ({ runtime, modelSelection }) =>
            applyKimiAcpModelSelection({
              runtime,
              model: modelSelection.model,
              selections: modelSelection.options,
              mapError: ({ cause }) => cause,
            }).pipe(Effect.as(modelSelection.model)),
          makeRuntime: ({ runtimePolicy: _policy, ...runtimeInput }) =>
            makeKimiAcpRuntime(input.config, {
              ...runtimeInput,
              childProcessSpawner,
              environment: { ...environment, ...runtimeInput.processEnvironment },
            }),
        },
      });
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterDriverCreateError({
              driver: DRIVER,
              instanceId: input.instanceId,
              detail: "Failed to create Kimi ACP adapter.",
              cause,
            }),
        ),
      ),
  ),
};
