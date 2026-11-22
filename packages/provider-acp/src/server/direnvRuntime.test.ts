import { DirenvEnvironment } from "@t3tools/provider-core/server/DirenvEnvironment";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { AcpAdapterV2Flavor, AcpAdapterV2RuntimeInput } from "./adapter.ts";
import { withDirenvRuntime } from "./direnvRuntime.ts";

const captureFlavor = () => {
  const inputs: Array<AcpAdapterV2RuntimeInput> = [];
  const flavor = {
    driver: "test-acp",
    makeRuntime: (input: AcpAdapterV2RuntimeInput) =>
      Effect.sync(() => {
        inputs.push(input);
        return {};
      }),
  } as unknown as AcpAdapterV2Flavor;
  const wrapped = withDirenvRuntime(flavor);
  const start = (input: AcpAdapterV2RuntimeInput) =>
    wrapped
      .makeRuntime(input)
      .pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));
  return { inputs, start };
};

const runtimeInput = (processEnvironment: NodeJS.ProcessEnv) =>
  ({ cwd: "/project", processEnvironment }) as unknown as AcpAdapterV2RuntimeInput;

describe("withDirenvRuntime", () => {
  it.effect("passes only the keys direnv changed on top of the instance environment", () => {
    const { inputs, start } = captureFlavor();
    const hostKey = Object.keys(process.env)[0];
    return Effect.gen(function* () {
      yield* start(runtimeInput({ INSTANCE: "kept", OVERRIDE: "instance" }));

      expect(inputs[0]?.processEnvironment).toEqual({
        INSTANCE: "kept",
        OVERRIDE: "direnv",
        ADDED: "direnv",
        ...(hostKey === undefined ? {} : { [hostKey]: undefined }),
      });
    }).pipe(
      Effect.provideService(DirenvEnvironment, {
        resolve: ({ cwd, environment }) =>
          Effect.sync(() => {
            expect(cwd).toBe("/project");
            const next: NodeJS.ProcessEnv = { ...environment, OVERRIDE: "direnv", ADDED: "direnv" };
            if (hostKey !== undefined) delete next[hostKey];
            return next;
          }),
      }),
    );
  });

  it.effect("keeps the instance environment when the server provides no direnv service", () => {
    const { inputs, start } = captureFlavor();
    return Effect.gen(function* () {
      yield* start(runtimeInput({ INSTANCE: "kept" }));
      expect(inputs[0]?.processEnvironment).toEqual({ INSTANCE: "kept" });
    });
  });
});
