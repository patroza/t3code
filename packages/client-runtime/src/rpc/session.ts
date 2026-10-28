import {
  type ServerConfig,
  type ServerConfigStreamEvent,
  WsSubscribeServerConfigRpc,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type * as Rpc from "effect/rpc/Rpc";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcClientError from "effect/rpc/RpcClientError";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Socket from "effect/socket/Socket";

import { makeWsRpcProtocolClient, PING_TIMEOUT, type WsRpcProtocolClient } from "./protocol.ts";
import { NETWORK_BLOCKING_HINT, UNRESPONSIVE_HOST_HINT } from "../errors/network.ts";
import type {
  ConnectionAttemptError,
  ConnectionTransientError,
  ConnectionTransientReason,
  PreparedConnection,
} from "../connection/model.ts";
import {
  ConnectionBlockedError,
  ConnectionTransientError as ConnectionTransientErrorClass,
} from "../connection/model.ts";
import { formatDisconnectDetail, type SocketCloseCapture } from "../connection/disconnectDetail.ts";
import * as ConnectionDiagnosticsLog from "../connection/diagnosticsLog.ts";
import {
  applyServerConfigProjection,
  type ServerConfigProjection,
  withoutEnvironmentThemes,
} from "../state/serverConfigProjection.ts";
import { environmentMismatchError } from "../connection/errors.ts";

const SOCKET_OPEN_TIMEOUT = "15 seconds";

/** Mutable sink filled before onDisconnect so we never emit a bare "disconnected." */
type DisconnectCauseSink = {
  causeMessage?: string;
  reason?: ConnectionTransientReason;
  close?: SocketCloseCapture;
};

function socketHostFromUrl(socketUrl: string): string | undefined {
  try {
    return new URL(socketUrl).host;
  } catch {
    return undefined;
  }
}

function captureSocketClose(
  webSocketConstructor: (
    url: string,
    options?: Socket.WebSocketConstructorOptions,
  ) => Socket.WebSocketLike,
  sink: { current: SocketCloseCapture },
): (url: string, options?: Socket.WebSocketConstructorOptions) => Socket.WebSocketLike {
  return (url, options) => {
    const socket = webSocketConstructor(url, options);
    socket.addEventListener(
      "close",
      (event) => {
        const closeEvent = event as CloseEvent;
        sink.current = {
          code: typeof closeEvent.code === "number" ? closeEvent.code : undefined,
          reason: typeof closeEvent.reason === "string" ? closeEvent.reason : undefined,
        };
      },
      { once: true },
    );
    return socket;
  };
}

function causeTextOf(cause: unknown, fallback: string): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  return fallback;
}

function noteSocketError(sink: DisconnectCauseSink, error: Socket.SocketError): void {
  const reason = error.reason;
  switch (reason._tag) {
    case "SocketCloseError": {
      sink.close = {
        code: reason.code,
        reason: reason.closeReason,
      };
      // Prefer close-code formatting over a generic SocketCloseError string.
      sink.reason ??= "transport";
      return;
    }
    case "SocketOpenError": {
      const causeText = causeTextOf(reason.cause, reason.kind);
      const lower = causeText.toLowerCase();
      if (lower.includes("ping timeout")) {
        sink.causeMessage = "ping timeout";
        sink.reason = "timeout";
        return;
      }
      // WebSocket openTimeout (not keepalive) — leave cause empty so formatters use open wording.
      if (reason.kind === "Timeout") {
        sink.reason ??= "timeout";
        return;
      }
      sink.causeMessage ??= causeText;
      sink.reason ??= lower.includes("timeout") ? "timeout" : "transport";
      return;
    }
    case "SocketReadError":
    case "SocketWriteError": {
      sink.causeMessage ??= causeTextOf(reason.cause, reason._tag);
      sink.reason ??= "transport";
      return;
    }
  }
}

function mergeCloseCapture(
  fromEvent: SocketCloseCapture,
  fromError: SocketCloseCapture | undefined,
): SocketCloseCapture {
  return {
    code: fromEvent.code ?? fromError?.code,
    reason: fromEvent.reason ?? fromError?.reason,
  };
}

/**
 * Wrap a Socket so transport failures are recorded before ConnectionHooks.onDisconnect.
 * onDisconnect alone only sees an empty close capture when the failure is a ping timeout
 * (socket still open; browser close event fires later/async).
 */
function tapSocketError<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  sink: DisconnectCauseSink,
): Effect.Effect<A, E, R> {
  return effect.pipe(
    Effect.tapError((error) =>
      Effect.sync(() => {
        if (Socket.SocketError.is(error)) {
          noteSocketError(sink, error);
        }
      }),
    ),
  );
}

function captureSocketFailures(socket: Socket.Socket, sink: DisconnectCauseSink): Socket.Socket {
  return Socket.make({
    reader: tapSocketError(socket.reader, sink).pipe(
      Effect.map((reader) => ({
        ...reader,
        pull: tapSocketError(reader.pull, sink),
        upgrade: (options?: Parameters<typeof reader.upgrade>[0]) =>
          tapSocketError(reader.upgrade(options), sink),
      })),
    ),
    writer: socket.writer.pipe(
      Effect.map((writer) => ({
        ...writer,
        write: (chunk: Parameters<typeof writer.write>[0]) =>
          tapSocketError(writer.write(chunk), sink),
        writeAll: (chunks: Parameters<typeof writer.writeAll>[0]) =>
          tapSocketError(writer.writeAll(chunks), sink),
      })),
    ),
  });
}

export interface RpcSession {
  readonly client: WsRpcProtocolClient;
  readonly initialConfig: Effect.Effect<ServerConfig, ConnectionAttemptError>;
  readonly subscribeServerConfig: (
    input: ServerConfigSubscriptionInput,
  ) => ServerConfigSubscription;
  readonly ready: Effect.Effect<void, ConnectionAttemptError>;
  readonly probe: Effect.Effect<void, ConnectionAttemptError>;
  /** Frames received so far: proof the socket is alive that needs no reply. */
  readonly inboundFrames: Effect.Effect<number>;
  readonly closed: Effect.Effect<never, ConnectionAttemptError>;
}

export interface RpcSessionOptions {
  readonly environmentThemes?: boolean;
  readonly usageLimitSources?: boolean;
  readonly usageLimitsCommand?: boolean;
}

export class RpcSessionFactory extends Context.Service<
  RpcSessionFactory,
  {
    readonly connect: (
      connection: PreparedConnection,
    ) => Effect.Effect<RpcSession, ConnectionAttemptError, Scope.Scope>;
  }
>()("@t3tools/client-runtime/rpc/session/RpcSessionFactory") {}

type InitialConfigError = Effect.Error<
  ReturnType<WsRpcProtocolClient[typeof WS_METHODS.serverGetConfig]>
>;
type ProbeError = Effect.Error<ReturnType<WsRpcProtocolClient[typeof WS_METHODS.serverProbe]>>;
type ServerConfigSubscriptionError =
  | Rpc.ErrorExit<typeof WsSubscribeServerConfigRpc>
  | RpcClientError.RpcClientError;
type ServerConfigSubscription = Stream.Stream<
  ServerConfigStreamEvent,
  ServerConfigSubscriptionError
>;
type ServerConfigSubscriptionInput = Parameters<
  WsRpcProtocolClient[typeof WS_METHODS.subscribeServerConfig]
>[0];
type EnvironmentThemesUpdatedEvent = Extract<
  ServerConfigStreamEvent,
  { readonly type: "environmentThemesUpdated" }
>;
type UsageLimitSourcesUpdatedEvent = Extract<
  ServerConfigStreamEvent,
  { readonly type: "usageLimitSourcesUpdated" }
>;

interface ServerConfigReplayState {
  readonly projection: ServerConfigProjection;
  readonly revision: number;
  readonly themesEvent: EnvironmentThemesUpdatedEvent | undefined;
  readonly sourcesEvent: UsageLimitSourcesUpdatedEvent | undefined;
}

interface BufferedServerConfigEvent {
  readonly event: ServerConfigStreamEvent;
  readonly replay: ServerConfigReplayState;
  readonly revision: number;
}

function serverConfigReplayEvents(
  state: ServerConfigReplayState,
): ReadonlyArray<ServerConfigStreamEvent> {
  const snapshot = {
    version: 1 as const,
    type: "snapshot" as const,
    config: withoutEnvironmentThemes(state.projection.config),
  };
  return [
    snapshot,
    ...(state.themesEvent === undefined ? [] : [state.themesEvent]),
    ...(state.sourcesEvent === undefined ? [] : [state.sourcesEvent]),
  ];
}

const isSocketErrorReason = Schema.is(Socket.SocketErrorReason);
const PING_TIMEOUT_SECONDS = Duration.toSeconds(PING_TIMEOUT);

function mapSessionRpcError(
  error: InitialConfigError | ProbeError | ServerConfigSubscriptionError,
  networkHint: string,
  via: "relay" | "direct",
): ConnectionAttemptError {
  switch (error._tag) {
    case "EnvironmentAuthorizationError":
      return new ConnectionBlockedError({
        reason: "permission",
        detail: error.message,
        hop: "server",
        via,
      });
    case "KeybindingsConfigParseError":
    case "ServerSettingsError":
      return new ConnectionTransientErrorClass({
        reason: "remote-unavailable",
        detail: error.message,
        hop: "server",
        via,
      });
    case "RpcClientError": {
      const lower = error.message.toLowerCase();
      if (lower.includes("ping timeout")) {
        return new ConnectionTransientErrorClass({
          reason: "timeout",
          detail: "ping timeout",
        });
      }
      return new ConnectionTransientErrorClass({
        reason: "transport",
        detail: `${error.message}${isSocketErrorReason(error.reason) ? networkHint : ""}`,
        ...socketFailureLocation(via),
      });
    }
  }
}

/** Over T3 Connect the relay already reached the host, so a socket that drops failed between this device and the tunnel. */
function socketFailureLocation(via: "relay" | "direct") {
  return { hop: via === "relay" ? "tunnel" : "server", via } as const;
}

/** @public */
export const make = Effect.fn("RpcSessionFactory.make")(function* (
  options: RpcSessionOptions = {},
) {
  const webSocketConstructor = yield* Socket.WebSocketConstructor;
  const diagnosticsLog = yield* Effect.serviceOption(
    ConnectionDiagnosticsLog.ConnectionDiagnosticsLog,
  );
  const serverConfigInput: ServerConfigSubscriptionInput = {
    ...(options.environmentThemes === true ? { environmentThemes: true } : {}),
    ...(options.usageLimitSources === true ? { usageLimitSources: true } : {}),
    ...(options.usageLimitsCommand === true ? { usageLimitsCommand: true } : {}),
  };
  // Config state merges the snapshots it fetches back in, so no subscriber needs them broadcast.
  const onDemandSnapshots = (input: ServerConfigSubscriptionInput) => ({
    ...input,
    workspaceSnapshotsOnDemand: true,
  });

  const connect = Effect.fnUntraced(function* (connection: PreparedConnection) {
    const via = connection.target._tag === "RelayConnectionTarget" ? "relay" : "direct";
    const networkHint = via === "relay" ? ` ${NETWORK_BLOCKING_HINT}` : "";
    const mapRpcError = (error: Parameters<typeof mapSessionRpcError>[0]) =>
      mapSessionRpcError(error, networkHint, via);
    yield* Effect.annotateCurrentSpan({
      "connection.environment.id": connection.environmentId,
    });

    const connected = yield* Deferred.make<void>();
    const disconnected = yield* Deferred.make<never, ConnectionTransientError>();
    const closeCapture: { current: SocketCloseCapture } = { current: {} };
    const causeSink: DisconnectCauseSink = {};
    const trackedConstructor = captureSocketClose(webSocketConstructor, closeCapture);
    const pingTimedOut = yield* Ref.make(false);

    const hooks = RpcClient.ConnectionHooks.of({
      onConnect: Deferred.succeed(connected, undefined).pipe(Effect.asVoid),
      onDisconnect: Effect.all([Deferred.isDone(connected), Ref.get(pingTimedOut)]).pipe(
        Effect.flatMap(([wasConnected, timedOut]) => {
          const close = mergeCloseCapture(closeCapture.current, causeSink.close);
          // The network hint fits only a socket that never opened. A missed
          // pong means the connected host stopped answering.
          const detail =
            wasConnected && timedOut
              ? `${connection.label} stopped responding for ${PING_TIMEOUT_SECONDS}s. ${UNRESPONSIVE_HOST_HINT}`
              : `${formatDisconnectDetail({
                  label: connection.label,
                  wasConnected,
                  close,
                  causeMessage: causeSink.causeMessage,
                })}${wasConnected ? "" : networkHint}`;
          const error = new ConnectionTransientErrorClass({
            reason: timedOut ? "timeout" : (causeSink.reason ?? "transport"),
            detail,
            ...socketFailureLocation(via),
          });
          const record = Option.match(diagnosticsLog, {
            onNone: () => Effect.void,
            onSome: (log) =>
              log.record({
                environmentId: connection.environmentId,
                label: connection.label,
                kind: wasConnected ? "disconnect" : "connect_failed",
                reason: error.reason,
                detail: error.detail,
                closeCode: close.code,
                closeReason: close.reason,
                socketHost: socketHostFromUrl(connection.socketUrl),
              }),
          });
          return record.pipe(Effect.andThen(Deferred.fail(disconnected, error)), Effect.asVoid);
        }),
      ),
    });
    // The protocol never reopens its socket, so every frame counted here came
    // from this session's one socket.
    let inboundFrames = 0;
    const countingWebSocketConstructor: typeof webSocketConstructor = (url, options) => {
      const socket = trackedConstructor(url, options);
      socket.addEventListener("message", () => {
        inboundFrames += 1;
      });
      return socket;
    };
    const layerProtocol = Layer.effect(
      RpcClient.Protocol,
      Effect.gen(function* () {
        const rawSocket = yield* Socket.makeWebSocket(connection.socketUrl, {
          openTimeout: SOCKET_OPEN_TIMEOUT,
        }).pipe(Effect.provideService(Socket.WebSocketConstructor, countingWebSocketConstructor));
        const socket = captureSocketFailures(rawSocket, causeSink);
        return yield* RpcClient.makeProtocolSocket({
          pingTimeout: PING_TIMEOUT,
          retryTransientErrors: false,
          retryPolicy: Schedule.recurs(0),
          onPingTimeout: Ref.set(pingTimedOut, true).pipe(
            Effect.andThen(
              Effect.sync(() => {
                causeSink.causeMessage = "ping timeout";
                causeSink.reason = "timeout";
              }),
            ),
          ),
        }).pipe(
          Effect.provideService(Socket.Socket, socket),
          Effect.provide(RpcSerialization.layerJson),
          Effect.provideService(RpcClient.ConnectionHooks, hooks),
        );
      }),
    );
    const protocolContext = yield* Layer.build(layerProtocol).pipe(
      Effect.withSpan("environment.websocket.connect"),
    );
    // Building the protocol only starts the socket; this span times the
    // handshake up to the first open, without making `connect` wait for it.
    yield* Deferred.await(connected).pipe(
      Effect.raceFirst(Deferred.await(disconnected)),
      Effect.withSpan("environment.websocket.open"),
      Effect.ignore,
      Effect.forkScoped,
    );
    const protocolClient = yield* makeWsRpcProtocolClient.pipe(Effect.provide(protocolContext));
    const initialConfigDeferred = yield* Deferred.make<ServerConfig>();
    const serverConfigExit = yield* Deferred.make<void, ServerConfigSubscriptionError>();
    const configSubscriptionClosed = yield* Deferred.make<never, ConnectionAttemptError>();
    const serverConfigState = yield* Ref.make(Option.none<ServerConfigReplayState>());
    const serverConfigUpdates = yield* PubSub.sliding<BufferedServerConfigEvent>(64);
    const configSubscriptionEndedError = new ConnectionTransientErrorClass({
      reason: "remote-unavailable",
      detail: `${connection.label} config subscription ended.`,
    });
    const serverConfigSource = protocolClient[WS_METHODS.subscribeServerConfig](
      onDemandSnapshots(serverConfigInput),
    ).pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          const buffered = yield* Ref.modify(serverConfigState, (current) => {
            const projection = applyServerConfigProjection(
              Option.map(current, (state) => state.projection),
              event,
            );
            if (Option.isNone(projection)) {
              return [Option.none<BufferedServerConfigEvent>(), current] as const;
            }
            const next = {
              projection: projection.value,
              revision: Option.match(current, {
                onNone: () => 1,
                onSome: (state) => state.revision + 1,
              }),
              themesEvent:
                event.type === "environmentThemesUpdated"
                  ? event
                  : Option.getOrUndefined(current)?.themesEvent,
              sourcesEvent:
                event.type === "usageLimitSourcesUpdated"
                  ? event
                  : Option.getOrUndefined(current)?.sourcesEvent,
            } satisfies ServerConfigReplayState;
            return [
              Option.some({ event, replay: next, revision: next.revision }),
              Option.some(next),
            ] as const;
          });
          if (Option.isSome(buffered)) {
            yield* PubSub.publish(serverConfigUpdates, buffered.value);
          }
          if (event.type === "snapshot") {
            yield* Deferred.succeed(initialConfigDeferred, event.config);
          }
        }),
      ),
      Effect.onExit((exit) => {
        if (Exit.isSuccess(exit)) {
          return Effect.all([
            Deferred.succeed(serverConfigExit, undefined),
            Deferred.fail(configSubscriptionClosed, configSubscriptionEndedError),
          ]).pipe(Effect.asVoid);
        }
        if (Cause.hasInterruptsOnly(exit.cause)) {
          return Effect.void;
        }
        return Effect.all([
          Deferred.failCause(serverConfigExit, exit.cause),
          Deferred.failCause(configSubscriptionClosed, Cause.map(exit.cause, mapRpcError)),
        ]).pipe(Effect.asVoid);
      }),
    );
    yield* serverConfigSource.pipe(Effect.forkScoped);
    const initialConfig = Effect.raceFirst(
      Deferred.await(initialConfigDeferred),
      Deferred.await(serverConfigExit).pipe(
        Effect.mapError(mapRpcError),
        Effect.flatMap(() => Effect.fail(configSubscriptionEndedError)),
      ),
    ).pipe(
      Effect.filterOrElse(
        (config) => config.environment.environmentId === connection.environmentId,
        (config) =>
          environmentMismatchError({
            expected: connection.environmentId,
            actual: config.environment.environmentId,
          }),
      ),
      Effect.withSpan("environment.initialSync"),
    );
    const serverConfigEvents = Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(serverConfigUpdates);
        const snapshot = yield* Ref.get(serverConfigState);
        if (Option.isNone(snapshot)) {
          return Stream.empty;
        }
        const updates = Stream.fromSubscription(subscription).pipe(
          Stream.filter((buffered) => buffered.revision > snapshot.value.revision),
          Stream.mapAccum(
            () => snapshot.value.revision,
            (revision, buffered) => [
              buffered.revision,
              buffered.revision === revision + 1
                ? [buffered.event]
                : serverConfigReplayEvents(buffered.replay),
            ],
          ),
        );
        const terminal = Stream.fromEffect(Deferred.await(serverConfigExit)).pipe(Stream.drain);
        return Stream.concat(
          Stream.fromIterable(serverConfigReplayEvents(snapshot.value)),
          Stream.merge(updates, terminal, { haltStrategy: "either" }),
        );
      }),
    ).pipe(
      Stream.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Stream.failCause(cause);
        }
        // The supervisor keeps the original cause. Shared durable consumers
        // need a transport-shaped failure so they wait for its replacement.
        return Stream.fail(
          new RpcClientError.RpcClientError({
            reason: new RpcClientError.RpcClientDefect({
              message: `${connection.label} config subscription failed.`,
              cause,
            }),
          }),
        );
      }),
    );
    const validatedInitialConfig = initialConfig.pipe(
      Effect.mapError(
        (cause) =>
          new RpcClientError.RpcClientError({
            reason: new RpcClientError.RpcClientDefect({
              message: `${connection.label} config subscription failed.`,
              cause,
            }),
          }),
      ),
    );
    const subscribeServerConfig = (input: ServerConfigSubscriptionInput) =>
      Stream.unwrap(
        validatedInitialConfig.pipe(
          Effect.as(
            Equal.equals(input, serverConfigInput)
              ? serverConfigEvents
              : protocolClient[WS_METHODS.subscribeServerConfig](onDemandSnapshots(input)),
          ),
        ),
      );
    const probe = initialConfig.pipe(
      Effect.flatMap(() =>
        protocolClient[WS_METHODS.serverProbe]({}).pipe(Effect.mapError(mapRpcError)),
      ),
      Effect.asVoid,
      Effect.withSpan("clientRuntime.connection.rpcSession.probe"),
    );

    return {
      client: protocolClient,
      initialConfig,
      subscribeServerConfig,
      ready: Deferred.await(connected).pipe(
        Effect.andThen(initialConfig),
        Effect.asVoid,
        Effect.raceFirst(Deferred.await(disconnected)),
      ),
      probe,
      inboundFrames: Effect.sync(() => inboundFrames),
      closed: Effect.raceFirst(
        Deferred.await(disconnected),
        Deferred.await(configSubscriptionClosed),
      ),
    } satisfies RpcSession;
  });

  return RpcSessionFactory.of({ connect });
});

export const layer = (options: RpcSessionOptions) => Layer.effect(RpcSessionFactory, make(options));
