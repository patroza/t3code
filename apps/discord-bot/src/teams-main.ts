// @effect-diagnostics layerMergeAllWithDependencies:off missingEffectContext:off anyUnknownInErrorContext:off unsafeEffectTypeAssertion:off multipleEffectProvide:off
import { NodeRuntime } from "@effect/platform-node";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";

import { DiscordBotConfig } from "./config.ts";
import { runTeamsNativeApp } from "./features/TeamsNativeApp.ts";
import { layerFromOptionalPath as projectAliasStoreLayer } from "./projectAliases.ts";
import { layer as threadLinkStoreLayer } from "./store/ThreadLinkStore.ts";
import { T3Session, layer as t3SessionLayer } from "./t3/T3Session.ts";

const TeamsMainLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* DiscordBotConfig;
    return Layer.mergeAll(
      t3SessionLayer(config),
      threadLinkStoreLayer(config.dataDir),
      projectAliasStoreLayer(config.projectAliasesPath),
    ).pipe(
      Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromEnv())),
      Layer.provideMerge(Logger.layer([Logger.consolePretty()])),
    );
  }),
).pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv())));

const program = Effect.gen(function* () {
  const config = yield* DiscordBotConfig;
  if (!config.teamsNativeEnabled) {
    return yield* Effect.die(
      new Error("TEAMS_NATIVE_ENABLED=1 is required by the Teams-only entrypoint."),
    );
  }
  const t3 = yield* T3Session;
  yield* t3.connectUntilReady();
  yield* runTeamsNativeApp(config);
  return yield* Effect.never;
});

NodeRuntime.runMain(
  program.pipe(
    Effect.provide(TeamsMainLayer),
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv())),
  ) as Effect.Effect<never, unknown>,
);
