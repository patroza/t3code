import { DirenvEnvironment } from "./DirenvEnvironment.ts";
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/process";
import { ProviderInstanceId, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { KimiAdapterV2Driver } from "../orchestration-v2/Adapters/KimiAdapterV2.ts";
import { ProviderAdapterV2RuntimePolicy } from "@t3tools/provider-core/server/ProviderAdapter";
const layer = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
  McpProviderSessions.layer,
);
it.effect("registers Kimi as a native ACP adapter and launches its ACP command", () =>
  Effect.gen(function* () {
    const launches: Array<ReadonlyArray<string>> = [];
    let spawnedEnvironment: NodeJS.ProcessEnv | undefined;
    const spawner = ChildProcessSpawner.make((command) => {
      if (command._tag === "StandardCommand") {
        launches.push(command.args);
        spawnedEnvironment = command.options.env;
      }
      return Effect.fail(
        PlatformError.systemError({
          _tag: "NotFound",
          module: "kimi-launch-test",
          method: "spawn",
        }),
      );
    });
    const instanceId = ProviderInstanceId.make("kimi-test");
    const adapter = yield* KimiAdapterV2Driver.create({
      instanceId,
      displayName: "Kimi",
      enabled: true,
      config: KimiAdapterV2Driver.defaultConfig(),
      environment: [],
    }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
    expect(adapter.driver).toBe("kimi");
    const capabilities = yield* adapter.getCapabilities();
    expect(capabilities).toMatchObject({ turns: { supportsInterrupt: true } });
    yield* adapter
      .openSession({
        threadId: ThreadId.make("kimi-thread"),
        providerSessionId: ProviderSessionId.make("kimi-session"),
        modelSelection: { instanceId, model: "kimi-k2.5" },
        runtimePolicy: ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "auto",
          interactionMode: "default",
          cwd: process.cwd(),
        }),
      })
      .pipe(Effect.ignore);
    expect(launches.some((args) => args.includes("acp"))).toBe(true);
    expect(spawnedEnvironment?.T3_TEST_DIRENV).toBe("project-value");
  }).pipe(
    Effect.scoped,
    Effect.provide(layer),
    Effect.provideService(DirenvEnvironment, {
      allow: () => Effect.void,
      resolve: (input) => Effect.succeed({ ...input.environment, T3_TEST_DIRENV: "project-value" }),
    }),
  ),
);
