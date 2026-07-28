// @effect-diagnostics globalDate:off globalFetch:off globalTimers:off globalErrorInEffectCatch:off globalErrorInEffectFailure:off anyUnknownInErrorContext:off missingEffectContext:off missingEffectError:off preferSchemaOverJson:off tryCatchInEffectGen:off missingReturnYieldStar:off layerMergeAllWithDependencies:off unsafeEffectTypeAssertion:off
import { NodeRuntime } from "@effect/platform-node";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import { FetchHttpClient } from "effect/unstable/http";
import { OtlpSerialization, OtlpTracer } from "effect/unstable/observability";

import { DiscordBotConfig } from "./config.ts";
import { makeDiscordLayer } from "./discord/DiscordLive.ts";
import { runAlertWatchdog } from "./features/Alerts.ts";
import { layer as bridgeHubLayer } from "./features/BridgeHub.ts";
import { DiscordBotRunning, MentionRouterLive } from "./features/MentionRouter.ts";
import { runBridge } from "./features/ResponseBridge.ts";
import { runTeamsModule } from "./features/TeamsModule.ts";
import { backfillThreadInfoPins } from "./features/ThreadInfoPin.ts";
import { rehydrateBridges } from "./features/ThreadRestore.ts";
import { layerFromOptionalPath as identityMapStoreLayer, IdentityMapStore } from "./identityMap.ts";
import {
  layerFromOptionalPath as projectAliasStoreLayer,
  ProjectAliasStore,
} from "./projectAliases.ts";
import { layer as teamsSeenStoreLayer } from "./store/TeamsSeenStore.ts";
import { layer as threadLinkStoreLayer } from "./store/ThreadLinkStore.ts";
import { layer as threadWarmCacheStoreLayer } from "./store/ThreadWarmCacheStore.ts";
import { T3Session, layer as t3SessionLayer } from "./t3/T3Session.ts";

const BotObservabilityLive = Layer.unwrap(
  Effect.gen(function* () {
    const tracesUrl = yield* Config.option(Config.nonEmptyString("T3CODE_OTLP_TRACES_URL"));
    return Option.match(tracesUrl, {
      onNone: () => Layer.empty,
      onSome: (url) =>
        OtlpTracer.layer({
          url,
          resource: {
            serviceName: "t3-discord-bot",
            attributes: {
              "service.runtime": "discord-bot",
            },
          },
        }).pipe(Layer.provide(OtlpSerialization.layerJson), Layer.provide(FetchHttpClient.layer)),
    });
  }),
).pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv())));

/**
 * Build layers so MentionRouter is a *required* dependency of the program
 * (via DiscordBotRunning). effectDiscard-only layers can be pruned when
 * nothing in the program Effect requires them.
 */
const MainLayer = Layer.unwrap(
  Effect.gen(function* () {
    const botConfig = yield* DiscordBotConfig;
    const discord = makeDiscordLayer(botConfig.discordToken);
    const bridgeHub = bridgeHubLayer(runBridge);
    const core = Layer.mergeAll(
      t3SessionLayer(botConfig),
      threadLinkStoreLayer(botConfig.dataDir),
      teamsSeenStoreLayer(botConfig.dataDir),
      threadWarmCacheStoreLayer(botConfig.dataDir),
      projectAliasStoreLayer(botConfig.projectAliasesPath),
      identityMapStoreLayer(botConfig.identityMapPath),
      bridgeHub,
    ).pipe(Layer.provideMerge(discord));

    const router = MentionRouterLive(botConfig).pipe(Layer.provide(core));

    // Router first so DiscordBotRunning is provided; core+discord still available.
    return router.pipe(
      Layer.provideMerge(core),
      Layer.provideMerge(discord),
      Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromEnv())),
      Layer.provideMerge(Logger.layer([Logger.consolePretty()])),
    );
  }),
).pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv())));

const program = Effect.gen(function* () {
  const botConfig = yield* DiscordBotConfig;
  yield* Effect.logInfo("Starting T3 Discord bot", {
    t3HttpBaseUrl: botConfig.t3HttpBaseUrl,
    dataDir: botConfig.dataDir,
    projectAliasesPath: botConfig.projectAliasesPath ?? "(unset)",
    identityMapPath: botConfig.identityMapPath ?? "(unset)",
    alertProcessRulesPath: botConfig.alertProcessRulesPath ?? "(unset)",
  });

  // Force acquisition of MentionRouter + Discord gateway (must not be pruned).
  // Discord can become READY before guest T3 is listening — that is expected on
  // restart. Mentions that land early get a transient "still connecting" reply.
  const running = yield* DiscordBotRunning;
  yield* Effect.logInfo("Discord gateway active", { botUserId: running.botUserId });

  const t3 = yield* T3Session;

  // Capture ambient services so T3 auto-reconnect can rehydrate Discord bridges.
  // Register before connectUntilReady so a drop immediately after first success
  // still rehydrates. provideContext erases R at runtime; cast so Effect.runPromise
  // accepts the program. (setOnReconnected is a Promise callback outside the Effect
  // runtime, so runPromise is intentional.)
  const services = yield* Effect.context();
  t3.setOnReconnected(() =>
    // @effect-diagnostics-next-line runEffectInsideEffect:off
    Effect.runPromise(
      rehydrateBridges("reconnect").pipe(
        Effect.provideContext(services),
        Effect.catchCause((cause) =>
          Effect.logError("Reconnect rehydrate failed").pipe(
            Effect.andThen(Effect.logError(cause)),
          ),
        ),
        Effect.asVoid,
      ) as Effect.Effect<void, never, never>,
    ),
  );

  // Retry forever until shell is ready — do not exit the process when T3 is late.
  yield* t3.connectUntilReady();
  const aliasStore = yield* ProjectAliasStore;
  const identityStore = yield* IdentityMapStore;
  yield* Effect.logInfo(
    `Connected to T3; bot project aliases=${aliasStore.list().length}; identity map entries=${identityStore.list().length}`,
  );

  // Restore running/pending bridges + catch-up finalize for open stream tips.
  // Without this, mid-turn Discord threads go silent until a human @mentions again.
  yield* rehydrateBridges("boot").pipe(
    Effect.catchCause((cause) =>
      Effect.logError("Boot rehydrate failed").pipe(Effect.andThen(Effect.logError(cause))),
    ),
  );

  // Backfill pinned thread-info messages (Model / Open in Omegent / Jira links) for active links.
  yield* backfillThreadInfoPins(botConfig).pipe(
    Effect.catchCause((cause) =>
      Effect.logError("Thread info pin backfill failed").pipe(
        Effect.andThen(Effect.logError(cause)),
      ),
    ),
  );

  // Guest ops alerts (load / mem / runaway Sentry MCP / long turns) → Discord channel.
  // forkDetach: program Effect has no Scope (unlike Layer.effect fibers).
  yield* Effect.forkDetach(
    runAlertWatchdog(botConfig).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("Alert watchdog stopped").pipe(Effect.andThen(Effect.logError(cause))),
      ),
    ),
  );
  if (botConfig.alertsChannelId) {
    yield* Effect.logInfo("Discord ops alerts enabled", {
      channelId: botConfig.alertsChannelId,
    });
  }

  // Optional Teams Graph intake → Discord/T3 (off unless TEAMS_ENABLED=1).
  yield* Effect.forkDetach(
    runTeamsModule(botConfig).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("Teams module stopped").pipe(Effect.andThen(Effect.logError(cause))),
      ),
    ),
  );

  // Keep process alive; router fibers are scoped to this layer lifetime.
  return yield* Effect.never;
});

NodeRuntime.runMain(
  program.pipe(Effect.provide(Layer.merge(MainLayer, BotObservabilityLive))) as Effect.Effect<
    never,
    unknown
  >,
);
