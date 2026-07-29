import { type ServerConfig, WS_METHODS } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as Socket from "effect/unstable/socket/Socket";

import { makeWsRpcProtocolClient, type WsRpcProtocolClient } from "./protocol.ts";
import type {
  ConnectionAttemptError,
  ConnectionTransientError,
  PreparedConnection,
} from "../connection/model.ts";
import {
  ConnectionBlockedError,
  ConnectionTransientError as ConnectionTransientErrorClass,
} from "../connection/model.ts";
import { formatDisconnectDetail, type SocketCloseCapture } from "../connection/disconnectDetail.ts";
import * as ConnectionDiagnosticsLog from "../connection/diagnosticsLog.ts";

const SOCKET_OPEN_TIMEOUT = "15 seconds";

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

export interface RpcSession {
  readonly client: WsRpcProtocolClient;
  readonly initialConfig: Effect.Effect<ServerConfig, ConnectionAttemptError>;
  readonly ready: Effect.Effect<void, ConnectionAttemptError>;
  readonly probe: Effect.Effect<void, ConnectionAttemptError>;
  readonly closed: Effect.Effect<never, ConnectionTransientError>;
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

function mapSessionRpcError(error: InitialConfigError | ProbeError): ConnectionAttemptError {
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

export const make = Effect.gen(function* () {
  const webSocketConstructor = yield* Socket.WebSocketConstructor;
  const diagnosticsLog = yield* Effect.serviceOption(
    ConnectionDiagnosticsLog.ConnectionDiagnosticsLog,
  );

  const connect = Effect.fnUntraced(function* (connection: PreparedConnection) {
    yield* Effect.annotateCurrentSpan({
      "connection.environment.id": connection.environmentId,
    });

    const connected = yield* Deferred.make<void>();
    const disconnected = yield* Deferred.make<never, ConnectionTransientError>();
    const closeCapture: { current: SocketCloseCapture } = { current: {} };
    const trackedConstructor = captureSocketClose(webSocketConstructor, closeCapture);
    const hooks = RpcClient.ConnectionHooks.of({
      onConnect: Deferred.succeed(connected, undefined).pipe(Effect.asVoid),
      onDisconnect: Deferred.isDone(connected).pipe(
        Effect.flatMap((wasConnected) => {
          const detail = formatDisconnectDetail({
            label: connection.label,
            wasConnected,
            close: closeCapture.current,
          });
          const error = new ConnectionTransientErrorClass({
            reason: "transport",
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
                closeCode: closeCapture.current.code,
                closeReason: closeCapture.current.reason,
                socketHost: socketHostFromUrl(connection.socketUrl),
              }),
          });
          return record.pipe(Effect.andThen(Deferred.fail(disconnected, error)), Effect.asVoid);
        }),
      ),
    });
    const socketLayer = Socket.layerWebSocket(connection.socketUrl, {
      openTimeout: SOCKET_OPEN_TIMEOUT,
    }).pipe(Layer.provide(Layer.succeed(Socket.WebSocketConstructor, trackedConstructor)));
    const protocolLayer = Layer.effect(
      RpcClient.Protocol,
      RpcClient.makeProtocolSocket({
        retryTransientErrors: false,
        retryPolicy: Schedule.recurs(0),
      }),
    ).pipe(
      Layer.provide(
        Layer.mergeAll(
          socketLayer,
          RpcSerialization.layerJson,
          Layer.succeed(RpcClient.ConnectionHooks, hooks),
        ),
      ),
    );
    const protocolContext = yield* Layer.build(protocolLayer).pipe(
      Effect.withSpan("environment.websocket.connect"),
    );
    const client = yield* makeWsRpcProtocolClient.pipe(Effect.provide(protocolContext));
    const initialConfig = yield* Effect.cached(
      client[WS_METHODS.serverGetConfig]({}).pipe(
        Effect.mapError(mapSessionRpcError),
        Effect.withSpan("environment.initialSync"),
      ),
    );
    const probe = initialConfig.pipe(
      Effect.flatMap((config) =>
        (config.environment.capabilities.connectionProbe === true
          ? client[WS_METHODS.serverProbe]({})
          : client[WS_METHODS.serverGetConfig]({})
        ).pipe(Effect.mapError(mapSessionRpcError)),
      ),
      Effect.asVoid,
      Effect.withSpan("clientRuntime.connection.rpcSession.probe"),
    );

    return {
      client,
      initialConfig,
      ready: Deferred.await(connected).pipe(
        Effect.andThen(initialConfig),
        Effect.asVoid,
        Effect.raceFirst(Deferred.await(disconnected)),
      ),
      probe,
      closed: Deferred.await(disconnected),
    } satisfies RpcSession;
  });

  return RpcSessionFactory.of({ connect });
});

export const layer = Layer.effect(RpcSessionFactory, make);
