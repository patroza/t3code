import { KimiSettings, ProviderDriverKind } from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/process";
import * as ServerConfig from "../../config.ts";
import {
  applyKimiAcpModelSelection,
  makeKimiAcpRuntime,
} from "../../provider/acp/KimiAcpSupport.ts";
import { mergeProviderInstanceEnvironment } from "../../provider/ProviderInstanceEnvironment.ts";
import * as IdAllocator from "../IdAllocator.ts";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
  type ProviderAdapterDriverCreateInput,
} from "../ProviderAdapterDriver.ts";
import { AcpProviderCapabilitiesV2, makeAcpAdapterV2 } from "./AcpAdapterV2.ts";

const decodeKimiSettings = Schema.decodeUnknownSync(KimiSettings);
const DRIVER = ProviderDriverKind.make("kimi");
export type KimiAdapterV2DriverEnv =
  | Crypto.Crypto
  | FileSystem.FileSystem
  | ChildProcessSpawner.ChildProcessSpawner
  | IdAllocator.IdAllocatorV2
  | ServerConfig.ServerConfig
  | Path.Path;
export const KimiAdapterV2Driver: ProviderAdapterDriver<KimiSettings, KimiAdapterV2DriverEnv> = {
  driverKind: DRIVER,
  configSchema: KimiSettings,
  defaultConfig: () => decodeKimiSettings({}),
  create: Effect.fn("KimiAdapterV2Driver.create")(
    function* (input: ProviderAdapterDriverCreateInput<KimiSettings>) {
      const crypto = yield* Crypto.Crypto;
      const fileSystem = yield* FileSystem.FileSystem;
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const serverConfig = yield* ServerConfig.ServerConfig;
      const hostEnvironment = yield* HostProcessEnvironment;
      const environment = mergeProviderInstanceEnvironment(input.environment, hostEnvironment);
      const selfInvocation = yield* resolveSelfInvocation();
      return makeAcpAdapterV2({
        instanceId: input.instanceId,
        crypto,
        fileSystem,
        idAllocator,
        serverConfig,
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
