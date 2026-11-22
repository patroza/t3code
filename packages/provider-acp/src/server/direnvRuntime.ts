import { resolveCurrentProviderEnvironment } from "@t3tools/provider-core/server/DirenvEnvironment";
import * as Effect from "effect/Effect";
import { AcpSpawnError } from "effect-acp/errors";

import type { AcpAdapterV2Flavor, AcpAdapterV2RuntimeInput } from "./adapter.ts";

/**
 * Starts every ACP runtime with the project's direnv environment. The runtime layers
 * `processEnvironment` over the server's own environment, so only the keys direnv changed
 * are passed on.
 */
export const withDirenvRuntime = (flavor: AcpAdapterV2Flavor): AcpAdapterV2Flavor => ({
  ...flavor,
  makeRuntime: Effect.fnUntraced(function* (input: AcpAdapterV2RuntimeInput) {
    const base = { ...process.env, ...input.processEnvironment };
    const resolved = yield* resolveCurrentProviderEnvironment(input.cwd, base).pipe(
      Effect.mapError((cause) => new AcpSpawnError({ command: flavor.driver, cause })),
    );
    const patch: NodeJS.ProcessEnv = { ...input.processEnvironment };
    for (const key of new Set([...Object.keys(base), ...Object.keys(resolved)])) {
      if (base[key] !== resolved[key]) patch[key] = resolved[key];
    }
    return yield* flavor.makeRuntime({ ...input, processEnvironment: patch });
  }),
});
