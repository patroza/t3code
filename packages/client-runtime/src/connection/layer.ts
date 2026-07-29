import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ConnectionResolver from "./resolver.ts";
import * as ConnectionDriver from "./driver.ts";
import * as EnvironmentRegistry from "./registry.ts";
import * as ConnectionOnboarding from "./onboarding.ts";
import * as ConnectionDiagnosticsLog from "./diagnosticsLog.ts";
import * as PlatformConnectionSource from "../platform/source.ts";
import * as RelayEnvironmentDiscovery from "../relay/discovery.ts";
import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import * as RpcSession from "../rpc/session.ts";

const diagnosticsLogLayer = ConnectionDiagnosticsLog.layer;

const resolverLayer = ConnectionResolver.layer.pipe(
  Layer.provide(RemoteEnvironmentAuthorization.layer),
);

const driverLayer = ConnectionDriver.layer.pipe(
  Layer.provide(Layer.mergeAll(resolverLayer, RpcSession.layer, diagnosticsLogLayer)),
);

const registryLayer = EnvironmentRegistry.layer.pipe(
  Layer.provide(Layer.mergeAll(driverLayer, diagnosticsLogLayer)),
);

const onboardingLayer = ConnectionOnboarding.layer.pipe(Layer.provide(registryLayer));

const connectionServicesLayer = Layer.mergeAll(
  registryLayer,
  RelayEnvironmentDiscovery.layer,
  onboardingLayer,
  diagnosticsLogLayer,
);

const connectionStartupLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    const platformSource = yield* PlatformConnectionSource.PlatformConnectionSource;
    yield* registry.start;
    yield* platformSource.registrations.pipe(
      Stream.runForEach(registry.reconcilePlatform),
      Effect.forkScoped,
    );
  }).pipe(Effect.withSpan("clientRuntime.connection.application.start")),
);

export const layer = connectionStartupLayer.pipe(Layer.provideMerge(connectionServicesLayer));
