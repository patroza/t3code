import {
  type ServerConfig,
  type ServerConfigStreamEvent,
  WsSubscribeServerConfigRpc,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcClientError from "effect/unstable/rpc/RpcClientError";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as Socket from "effect/unstable/socket/Socket";

import { makeWsRpcProtocolClient, type WsRpcProtocolClient } from "./protocol.ts";
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
  webSocketConstructor: (url: string, protocols?: string | string[]) => globalThis.WebSocket,
  sink: { current: SocketCloseCapture },
): (url: string, protocols?: string | string[]) => globalThis.WebSocket {
  return (url, protocols) => {
    const socket = webSocketConstructor(url, protocols);
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
      if (reason.kind === "Timeout" && (lower.includes("open") || lower.includes("waiting"))) {
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
function captureSocketFailures(socket: Socket.Socket, sink: DisconnectCauseSink): Socket.Socket {
  return Socket.make({
    runRaw: (handler, options) =>
      socket.runRaw(handler, options).pipe(
        Effect.tapError((error) =>
          Effect.sync(() => {
            if (Socket.SocketError.is(error)) {
              noteSocketError(sink, error);
            }
          }),
        ),
      ),
    writer: socket.writer,
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
  readonly closed: Effect.Effect<never, ConnectionAttemptError>;
}

export interface RpcSessionOptions {
  readonly environmentThemes?: boolean;
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

interface ServerConfigReplayState {
  readonly projection: ServerConfigProjection;
  readonly revision: number;
  readonly themesEvent: EnvironmentThemesUpdatedEvent | undefined;
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
  return state.themesEvent === undefined ? [snapshot] : [snapshot, state.themesEvent];
}

function mapSessionRpcError(
  error: InitialConfigError | ProbeError | ServerConfigSubscriptionError,
): ConnectionAttemptError {
  switch (error._tag) {
    case "EnvironmentAuthorizationError":
      return new ConnectionBlockedError({
        reason: "permission",
        detail: error.message,
      });
    case "KeybindingsConfigParseError":
    case "ServerSettingsError":
      return new ConnectionTransientErrorClass({
        reason: "remote-unavailable",
        detail: error.message,
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
        detail: error.message,
      });
    }
  }
}

export const make = Effect.fn("RpcSessionFactory.make")(function* (
  options: RpcSessionOptions = {},
) {
  const webSocketConstructor = yield* Socket.WebSocketConstructor;
  const diagnosticsLog = yield* Effect.serviceOption(
    ConnectionDiagnosticsLog.ConnectionDiagnosticsLog,
  );
  const serverConfigInput: ServerConfigSubscriptionInput =
    options.environmentThemes === true ? { environmentThemes: true } : {};

  const connect = Effect.fnUntraced(function* (connection: PreparedConnection) {
    yield* Effect.annotateCurrentSpan({
      "connection.environment.id": connection.environmentId,
    });

    const connected = yield* Deferred.make<void>();
    const disconnected = yield* Deferred.make<never, ConnectionTransientError>();
    const closeCapture: { current: SocketCloseCapture } = { current: {} };
    const causeSink: DisconnectCauseSink = {};
    const trackedConstructor = captureSocketClose(webSocketConstructor, closeCapture);
    const hooks = RpcClient.ConnectionHooks.of({
      onConnect: Deferred.succeed(connected, undefined).pipe(Effect.asVoid),
      // Fork patch: runs before the protocol fails the socket with SocketOpenError(ping timeout).
      onPingTimeout: Effect.sync(() => {
        causeSink.causeMessage = "ping timeout";
        causeSink.reason = "timeout";
      }),
      onDisconnect: Deferred.isDone(connected).pipe(
        Effect.flatMap((wasConnected) => {
          const close = mergeCloseCapture(closeCapture.current, causeSink.close);
          const detail = formatDisconnectDetail({
            label: connection.label,
            wasConnected,
            close,
            causeMessage: causeSink.causeMessage,
          });
          const error = new ConnectionTransientErrorClass({
            reason: causeSink.reason ?? "transport",
            detail,
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
    // Build socket, wrap to capture SocketError (close codes / open errors), then protocol.
    const protocolLayer = Layer.effect(
      RpcClient.Protocol,
      Effect.gen(function* () {
        const rawSocket = yield* Socket.makeWebSocket(connection.socketUrl, {
          openTimeout: SOCKET_OPEN_TIMEOUT,
        }).pipe(Effect.provideService(Socket.WebSocketConstructor, trackedConstructor));
        const socket = captureSocketFailures(rawSocket, causeSink);
        return yield* RpcClient.makeProtocolSocket({
          retryTransientErrors: false,
          retryPolicy: Schedule.recurs(0),
        }).pipe(
          Effect.provideService(Socket.Socket, socket),
          Effect.provide(RpcSerialization.layerJson),
          Effect.provideService(RpcClient.ConnectionHooks, hooks),
        );
      }),
    );
    const protocolContext = yield* Layer.build(protocolLayer).pipe(
      Effect.withSpan("environment.websocket.connect"),
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
      serverConfigInput,
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
                  : event.type === "snapshot" &&
                      event.config.environment.capabilities.environmentThemes !== true
                    ? undefined
                    : Option.getOrUndefined(current)?.themesEvent,
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
          Deferred.failCause(configSubscriptionClosed, Cause.map(exit.cause, mapSessionRpcError)),
        ]).pipe(Effect.asVoid);
      }),
    );
    yield* serverConfigSource.pipe(Effect.forkScoped);
    const initialConfig = Effect.raceFirst(
      Deferred.await(initialConfigDeferred),
      Deferred.await(serverConfigExit).pipe(
        Effect.mapError(mapSessionRpcError),
        Effect.flatMap(() => Effect.fail(configSubscriptionEndedError)),
      ),
    ).pipe(Effect.withSpan("environment.initialSync"));
    const serverConfigEvents = Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(serverConfigUpdates);
        yield* Effect.raceFirst(
          Deferred.await(initialConfigDeferred).pipe(Effect.asVoid),
          Deferred.await(serverConfigExit),
        );
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
    const subscribeServerConfig = (input: ServerConfigSubscriptionInput) =>
      Equal.equals(input, serverConfigInput)
        ? serverConfigEvents
        : protocolClient[WS_METHODS.subscribeServerConfig](input);
    const probe = initialConfig.pipe(
      Effect.flatMap((config) =>
        (config.environment.capabilities.connectionProbe === true
          ? protocolClient[WS_METHODS.serverProbe]({})
          : protocolClient[WS_METHODS.serverGetConfig]({})
        ).pipe(Effect.mapError(mapSessionRpcError)),
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
      closed: Effect.raceFirst(
        Deferred.await(disconnected),
        Deferred.await(configSubscriptionClosed),
      ),
    } satisfies RpcSession;
  });

  return RpcSessionFactory.of({ connect });
});

export const layerWithOptions = (options: RpcSessionOptions) =>
  Layer.effect(RpcSessionFactory, make(options));

export const layer = layerWithOptions({});
