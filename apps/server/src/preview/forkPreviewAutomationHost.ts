import {
  type EnvironmentId,
  PREVIEW_AUTOMATION_HOST_WS_METHODS,
  type PreviewAutomationConnectionId,
  type PreviewAutomationError,
  type PreviewAutomationHost,
  type PreviewAutomationHostClaim,
  type PreviewAutomationResponse,
  type PreviewAutomationStreamEvent,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";

import * as PreviewAutomationBroker from "../mcp/PreviewAutomationBroker.ts";

type BrokerService = PreviewAutomationBroker.PreviewAutomationBroker["Service"];

/**
 * Browser hosts outside the server process (the Discord/Teams bot). Each host gets its own
 * broker instance so a thread it claims routes to exactly that host; every other thread keeps
 * upstream's routing through the shared broker.
 */
export class PreviewAutomationExternalHosts extends Context.Service<
  PreviewAutomationExternalHosts,
  {
    readonly connect: (
      host: PreviewAutomationHost,
    ) => Effect.Effect<Stream.Stream<PreviewAutomationStreamEvent>>;
    readonly respond: (
      response: PreviewAutomationResponse,
    ) => Effect.Effect<void, PreviewAutomationError>;
    readonly focusHost: (focus: PreviewAutomationHostClaim) => Effect.Effect<void>;
  }
>()("t3/preview/forkPreviewAutomationHost/PreviewAutomationExternalHosts") {}

interface ExternalHost {
  readonly broker: BrokerService;
  readonly environmentId: EnvironmentId;
  readonly connectionId: PreviewAutomationConnectionId | undefined;
}

interface ThreadClaim {
  readonly clientId: string;
  readonly connectionId: PreviewAutomationConnectionId;
}

interface State {
  readonly hosts: ReadonlyMap<string, ExternalHost>;
  readonly claims: ReadonlyMap<string, ThreadClaim>;
}

const threadClaimKey = (environmentId: EnvironmentId, threadId: ThreadId): string =>
  `${environmentId}\u0000${threadId}`;

const make = Effect.gen(function* () {
  const random = yield* SecureRandom.SecureRandom;
  const primary = yield* PreviewAutomationBroker.make;
  const state = yield* SynchronizedRef.make<State>({ hosts: new Map(), claims: new Map() });

  const updateHost = (current: State, clientId: string, host: ExternalHost): State => {
    const hosts = new Map(current.hosts);
    hosts.set(clientId, host);
    return { ...current, hosts };
  };

  const releaseConnection = (clientId: string, connectionId: PreviewAutomationConnectionId) =>
    SynchronizedRef.update(state, (current) => {
      const host = current.hosts.get(clientId);
      if (host?.connectionId !== connectionId) return current;
      const claims = new Map(
        Array.from(current.claims).filter(([, claim]) => claim.connectionId !== connectionId),
      );
      return { ...updateHost(current, clientId, { ...host, connectionId: undefined }), claims };
    });

  const connect: PreviewAutomationExternalHosts["Service"]["connect"] = Effect.fn(
    "PreviewAutomationExternalHosts.connect",
  )(function* (host) {
    const broker = yield* SynchronizedRef.modifyEffect(state, (current) => {
      const existing = current.hosts.get(host.clientId);
      const brokerEffect = existing
        ? Effect.succeed(existing.broker)
        : PreviewAutomationBroker.make.pipe(
            Effect.provideService(SecureRandom.SecureRandom, random),
          );
      return brokerEffect.pipe(
        Effect.map(
          (broker) =>
            [
              broker,
              updateHost(current, host.clientId, {
                broker,
                environmentId: host.environmentId,
                connectionId: existing?.connectionId,
              }),
            ] as const,
        ),
      );
    });
    const events = yield* broker.connect(host);
    let connectionId: PreviewAutomationConnectionId | undefined;
    return events.pipe(
      Stream.tap((event) => {
        if (event.type !== "connected") return Effect.void;
        connectionId = event.connectionId;
        return SynchronizedRef.update(state, (current) => {
          const existing = current.hosts.get(host.clientId);
          if (!existing) return current;
          return updateHost(current, host.clientId, {
            ...existing,
            environmentId: host.environmentId,
            connectionId: event.connectionId,
          });
        });
      }),
      Stream.ensuring(
        Effect.suspend(() =>
          connectionId === undefined ? Effect.void : releaseConnection(host.clientId, connectionId),
        ),
      ),
    );
  });

  const liveHost = (current: State, clientId: string, connectionId: string) => {
    const host = current.hosts.get(clientId);
    return host?.connectionId === connectionId ? host : undefined;
  };

  const respond: PreviewAutomationExternalHosts["Service"]["respond"] = Effect.fn(
    "PreviewAutomationExternalHosts.respond",
  )(function* (response) {
    const host = (yield* SynchronizedRef.get(state)).hosts.get(response.clientId);
    if (host) yield* host.broker.respond(response);
  });

  const focusHost: PreviewAutomationExternalHosts["Service"]["focusHost"] = Effect.fn(
    "PreviewAutomationExternalHosts.focusHost",
  )(function* ({ threadId, ...focus }) {
    const host = yield* SynchronizedRef.modify(state, (current) => {
      const host = liveHost(current, focus.clientId, focus.connectionId);
      if (!host || host.environmentId !== focus.environmentId) {
        return [undefined, current] as const;
      }
      if (threadId === undefined) return [host, current] as const;
      const claims = new Map(current.claims);
      const key = threadClaimKey(focus.environmentId, threadId);
      if (focus.focused) {
        claims.set(key, { clientId: focus.clientId, connectionId: focus.connectionId });
      } else if (claims.get(key)?.connectionId === focus.connectionId) {
        claims.delete(key);
      }
      return [undefined, { ...current, claims }] as const;
    });
    if (host) yield* host.broker.focusHost(focus);
  });

  const claimedBroker = (scope: PreviewAutomationBroker.PreviewAutomationInvokeInput["scope"]) =>
    SynchronizedRef.get(state).pipe(
      Effect.map((current) => {
        const claim = current.claims.get(
          threadClaimKey(scope.environmentId, scope.thread.threadId),
        );
        const host = claim && liveHost(current, claim.clientId, claim.connectionId);
        return host?.environmentId === scope.environmentId ? host.broker : primary;
      }),
    );

  const invoke = Effect.fn("PreviewAutomationExternalHosts.invoke")(function* <A = unknown>(
    input: PreviewAutomationBroker.PreviewAutomationInvokeInput,
  ): Effect.fn.Return<A, PreviewAutomationError> {
    const selected = yield* claimedBroker(input.scope);
    return yield* selected.invoke<A>(input);
  });

  const broker = PreviewAutomationBroker.PreviewAutomationBroker.of({ ...primary, invoke });

  return Context.make(PreviewAutomationBroker.PreviewAutomationBroker, broker).pipe(
    Context.add(PreviewAutomationExternalHosts, { connect, respond, focusHost }),
  );
});

/** Replaces `PreviewAutomationBroker.layer`: the same broker, with external hosts and claims. */
export const layer: Layer.Layer<
  PreviewAutomationBroker.PreviewAutomationBroker | PreviewAutomationExternalHosts,
  never,
  SecureRandom.SecureRandom
> = Layer.effectContext(make);

export const previewAutomationHostRpcAggregates = {
  [PREVIEW_AUTOMATION_HOST_WS_METHODS.previewAutomationConnect]: "preview",
  [PREVIEW_AUTOMATION_HOST_WS_METHODS.previewAutomationRespond]: "preview",
  [PREVIEW_AUTOMATION_HOST_WS_METHODS.previewAutomationFocusHost]: "preview",
} as const;

/** The previewAutomation.* handlers; hosts without the fork layer (tests) reject them. */
export const makePreviewAutomationHostWsHandlers = Effect.fn("preview.makeExternalHostHandlers")(
  function* () {
    const hosts = yield* Effect.serviceOption(PreviewAutomationExternalHosts);
    const require: Effect.Effect<PreviewAutomationExternalHosts["Service"]> = Option.match(hosts, {
      onNone: () => Effect.die("PreviewAutomationExternalHosts is not provided"),
      onSome: Effect.succeed,
    });
    return {
      [PREVIEW_AUTOMATION_HOST_WS_METHODS.previewAutomationConnect]: (
        host: PreviewAutomationHost,
      ) => Stream.unwrap(require.pipe(Effect.flatMap((service) => service.connect(host)))),
      [PREVIEW_AUTOMATION_HOST_WS_METHODS.previewAutomationRespond]: (
        response: PreviewAutomationResponse,
      ) => require.pipe(Effect.flatMap((service) => service.respond(response))),
      [PREVIEW_AUTOMATION_HOST_WS_METHODS.previewAutomationFocusHost]: (
        focus: PreviewAutomationHostClaim,
      ) => require.pipe(Effect.flatMap((service) => service.focusHost(focus))),
    };
  },
);
