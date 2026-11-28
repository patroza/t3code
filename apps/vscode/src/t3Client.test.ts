// @effect-diagnostics nodeBuiltinImport:off - integration tests spin up a local Node HTTP server.
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  AuthAccessTokenType,
  CLIENT_CAPABILITIES_QUERY_PARAM,
  EnvironmentId,
  HTTP_USAGE_LIMIT_SOURCES_CAPABILITY,
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION,
  SETTINGS_SECRET_REFERENCES_CAPABILITY,
  type AuthSessionState,
  type ExecutionEnvironmentDescriptor,
} from "@t3tools/contracts";
import { ConnectionBlockedError } from "@t3tools/client-runtime/connection";
import { SOCKET_FRAME_PARTS_QUERY_PARAM } from "@t3tools/shared/socketFrameParts";

import { T3AuthenticationError, isConnectionBlockedError } from "./connectionErrors.ts";
import { buildRpcSocketUrl, localSocketUrl, T3Client } from "./t3Client.ts";

interface MockServerOptions {
  readonly descriptor?: Partial<ExecutionEnvironmentDescriptor> & {
    readonly omitProtocolVersion?: boolean;
  };
  readonly authSession?: {
    readonly status: number;
    readonly body: AuthSessionState | Record<string, unknown>;
  };
  readonly wsTicket?: {
    readonly status: number;
    readonly body: Record<string, unknown>;
  };
  readonly oauthToken?: {
    readonly status: number;
    readonly body: Record<string, unknown>;
  };
}

interface MockServerHandle {
  readonly url: string;
  readonly httpRequests: Array<{ readonly method: string; readonly path: string }>;
  readonly upgradeUrls: Array<string>;
  readonly close: () => Promise<void>;
}

const activeServers: Array<MockServerHandle> = [];
const activeClients: Array<T3Client> = [];

async function startMockServer(options: MockServerOptions = {}): Promise<MockServerHandle> {
  const httpRequests: Array<{ readonly method: string; readonly path: string }> = [];
  const upgradeUrls: Array<string> = [];

  const { omitProtocolVersion, ...descriptorOverrides } = options.descriptor ?? {};
  const descriptor: Record<string, unknown> = {
    environmentId: EnvironmentId.make("env-test-1"),
    label: "Test T3 Server",
    platform: { os: "linux", arch: "x64" },
    serverVersion: "0.0.1",
    capabilities: {
      repositoryIdentity: false,
    },
    ...descriptorOverrides,
  };
  if (!omitProtocolVersion && !("orchestrationProtocolVersion" in descriptorOverrides)) {
    descriptor.orchestrationProtocolVersion = ORCHESTRATION_PROTOCOL_VERSION;
  }

  const defaultAuthSession: AuthSessionState = {
    authenticated: true,
    auth: {
      policy: "unsafe-no-auth",
      bootstrapMethods: ["one-time-token"],
      sessionMethods: ["bearer-access-token"],
      sessionCookieName: "t3_session",
    },
  };

  const server = NodeHttp.createServer((req, res) => {
    const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    httpRequests.push({ method: req.method ?? "GET", path: requestUrl.pathname });

    if (req.method === "GET" && requestUrl.pathname === "/.well-known/t3/environment") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(descriptor));
      return;
    }

    if (req.method === "GET" && requestUrl.pathname === "/api/auth/session") {
      const status = options.authSession?.status ?? 200;
      const body = options.authSession?.body ?? defaultAuthSession;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
      return;
    }

    if (req.method === "POST" && requestUrl.pathname === "/api/auth/websocket-ticket/rpc") {
      const status = options.wsTicket?.status ?? 200;
      const body = options.wsTicket?.body ?? {
        ticket: "ticket-123",
        expiresAt: "2099-01-01T00:00:00.000Z",
      };
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
      return;
    }

    if (req.method === "POST" && requestUrl.pathname === "/oauth/token") {
      const status = options.oauthToken?.status ?? 200;
      const body = options.oauthToken?.body ?? {
        access_token: "bearer-123",
        issued_token_type: AuthAccessTokenType,
        token_type: "Bearer",
        expires_in: 2_592_000,
        scope: "orchestration:read orchestration:operate",
      };
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });

  server.on("upgrade", (req, socket) => {
    const rawUrl = req.url ?? "/";
    upgradeUrls.push(rawUrl);
    const parsed = new URL(rawUrl, "http://127.0.0.1");
    if (
      parsed.searchParams.get(ORCHESTRATION_PROTOCOL_QUERY_PARAM) !==
      String(ORCHESTRATION_PROTOCOL_VERSION)
    ) {
      socket.write(
        "HTTP/1.1 426 Upgrade Required\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n" +
          JSON.stringify({ code: "orchestration_protocol_incompatible" }),
      );
      socket.destroy();
      return;
    }
    socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
    socket.destroy();
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as NodeNet.AddressInfo;
  const handle: MockServerHandle = {
    url: `http://127.0.0.1:${address.port}`,
    httpRequests,
    upgradeUrls,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
  activeServers.push(handle);
  return handle;
}

function createClient(): T3Client {
  const client = new T3Client();
  activeClients.push(client);
  return client;
}

afterEach(async () => {
  while (activeClients.length > 0) {
    await activeClients.pop()!.dispose();
  }
  while (activeServers.length > 0) {
    await activeServers.pop()!.close();
  }
});

describe("WebSocket URL builders", () => {
  it("appends orchestration protocol, capabilities, and product handshake while preserving wsTicket", () => {
    const built = new URL(buildRpcSocketUrl("ws://127.0.0.1:3773/ws?wsTicket=ticket-abc"));
    expect(built.pathname).toBe("/ws");
    expect(built.searchParams.get("wsTicket")).toBe("ticket-abc");
    expect(built.searchParams.get(ORCHESTRATION_PROTOCOL_QUERY_PARAM)).toBe(
      String(ORCHESTRATION_PROTOCOL_VERSION),
    );
    expect(built.searchParams.get(CLIENT_CAPABILITIES_QUERY_PARAM)).toBe(
      `${SETTINGS_SECRET_REFERENCES_CAPABILITY},${HTTP_USAGE_LIMIT_SOURCES_CAPABILITY}`,
    );
    expect(built.searchParams.get("productFamily")).toBe("omegent-t3");
    expect(built.searchParams.get("productToken")).toBeTruthy();
  });

  it("builds a local /ws URL with orchestration protocol, capabilities, and product handshake", () => {
    const built = new URL(localSocketUrl("https://t3.example:8443/some/path?ignored=1#hash"));
    expect(built.protocol).toBe("wss:");
    expect(built.host).toBe("t3.example:8443");
    expect(built.pathname).toBe("/ws");
    expect(built.searchParams.get("ignored")).toBeNull();
    expect(built.searchParams.get(ORCHESTRATION_PROTOCOL_QUERY_PARAM)).toBe(
      String(ORCHESTRATION_PROTOCOL_VERSION),
    );
    expect(built.searchParams.get(CLIENT_CAPABILITIES_QUERY_PARAM)).toBe(
      `${SETTINGS_SECRET_REFERENCES_CAPABILITY},${HTTP_USAGE_LIMIT_SOURCES_CAPABILITY}`,
    );
    expect(built.searchParams.get("productFamily")).toBe("omegent-t3");
    expect(built.searchParams.get("productToken")).toBeTruthy();
  });
});

describe("T3Client.connect protocol and auth handling", () => {
  it("sends orchestration protocol, capabilities, wsTicket, frameParts, and product params on bearer upgrade", async () => {
    const server = await startMockServer();
    const client = createClient();

    let caught: unknown;
    try {
      await client.connect(server.url, "valid-token");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(T3AuthenticationError);
    expect(isConnectionBlockedError(caught)).toBe(false);
    expect(server.upgradeUrls).toHaveLength(1);
    const upgradeUrl = new URL(server.upgradeUrls[0]!, server.url);
    expect(upgradeUrl.pathname).toBe("/ws");
    expect(upgradeUrl.searchParams.get(ORCHESTRATION_PROTOCOL_QUERY_PARAM)).toBe(
      String(ORCHESTRATION_PROTOCOL_VERSION),
    );
    expect(upgradeUrl.searchParams.get(CLIENT_CAPABILITIES_QUERY_PARAM)).toBe(
      `${SETTINGS_SECRET_REFERENCES_CAPABILITY},${HTTP_USAGE_LIMIT_SOURCES_CAPABILITY}`,
    );
    expect(upgradeUrl.searchParams.get("wsTicket")).toBe("ticket-123");
    expect(upgradeUrl.searchParams.get(SOCKET_FRAME_PARTS_QUERY_PARAM)).toBe("1");
    expect(upgradeUrl.searchParams.get("productFamily")).toBe("omegent-t3");
    expect(upgradeUrl.searchParams.get("productToken")).toBeTruthy();
  });

  it("sends orchestration protocol, capabilities, frameParts, and product params on local unauthenticated upgrade", async () => {
    const server = await startMockServer();
    const client = createClient();

    let caught: unknown;
    try {
      await client.connect(server.url);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(server.httpRequests.some((req) => req.path === "/api/auth/websocket-ticket/rpc")).toBe(
      false,
    );
    expect(server.upgradeUrls).toHaveLength(1);
    const upgradeUrl = new URL(server.upgradeUrls[0]!, server.url);
    expect(upgradeUrl.pathname).toBe("/ws");
    expect(upgradeUrl.searchParams.get(ORCHESTRATION_PROTOCOL_QUERY_PARAM)).toBe(
      String(ORCHESTRATION_PROTOCOL_VERSION),
    );
    expect(upgradeUrl.searchParams.get(CLIENT_CAPABILITIES_QUERY_PARAM)).toBe(
      `${SETTINGS_SECRET_REFERENCES_CAPABILITY},${HTTP_USAGE_LIMIT_SOURCES_CAPABILITY}`,
    );
    expect(upgradeUrl.searchParams.get(SOCKET_FRAME_PARTS_QUERY_PARAM)).toBe("1");
    expect(upgradeUrl.searchParams.get("productFamily")).toBe("omegent-t3");
    expect(upgradeUrl.searchParams.get("productToken")).toBeTruthy();
  });

  it("rejects immediately with T3AuthenticationError when local desktop-managed-local session is unauthenticated", async () => {
    const server = await startMockServer({
      authSession: {
        status: 200,
        body: {
          authenticated: false,
          auth: {
            policy: "desktop-managed-local",
            bootstrapMethods: ["desktop-bootstrap", "one-time-token"],
            sessionMethods: ["bearer-access-token"],
            sessionCookieName: "t3_session",
          },
        },
      },
    });
    const client = createClient();

    let caught: unknown;
    try {
      await client.connect(server.url);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(T3AuthenticationError);
    if (caught instanceof T3AuthenticationError) {
      expect(caught.reason).toBe("missing_credential");
      expect(caught.message).toContain("T3 Code: Pair with Server…");
    }
    expect(server.upgradeUrls).toHaveLength(0);
  });

  it("rejects with T3AuthenticationError invalid_credential when bearer ticket endpoint returns 401", async () => {
    const server = await startMockServer({
      wsTicket: {
        status: 401,
        body: {
          _tag: "EnvironmentAuthInvalidError",
          code: "auth_invalid",
          reason: "invalid_credential",
          traceId: "trace-1",
        },
      },
    });
    const client = createClient();

    let caught: unknown;
    try {
      await client.connect(server.url, "bad-token");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(T3AuthenticationError);
    if (caught instanceof T3AuthenticationError) {
      expect(caught.reason).toBe("invalid_credential");
      expect(caught.message).not.toContain("could not establish a WebSocket connection");
    }
    expect(server.upgradeUrls).toHaveLength(0);
  });

  it("rejects with ConnectionBlockedError when server protocol v1 is too old", async () => {
    const server = await startMockServer({
      descriptor: { orchestrationProtocolVersion: 1 },
    });
    const client = createClient();

    let descriptorError: unknown;
    try {
      await client.fetchCompatibleDescriptor(server.url);
    } catch (error) {
      descriptorError = error;
    }
    expect(descriptorError).toBeInstanceOf(ConnectionBlockedError);
    if (isConnectionBlockedError(descriptorError)) {
      expect(descriptorError.reason).toBe("unsupported");
      expect(descriptorError.message).toContain("Update T3 Code");
    }

    let connectError: unknown;
    try {
      await client.connect(server.url, "token");
    } catch (error) {
      connectError = error;
    }
    expect(connectError).toBeInstanceOf(ConnectionBlockedError);
    expect(server.httpRequests.some((req) => req.path === "/api/auth/websocket-ticket/rpc")).toBe(
      false,
    );
    expect(server.upgradeUrls).toHaveLength(0);
  });

  it("rejects with ConnectionBlockedError when server omits orchestrationProtocolVersion", async () => {
    const server = await startMockServer({
      descriptor: { omitProtocolVersion: true },
    });
    const client = createClient();

    let connectError: unknown;
    try {
      await client.connect(server.url, "token");
    } catch (error) {
      connectError = error;
    }
    expect(connectError).toBeInstanceOf(ConnectionBlockedError);
    if (isConnectionBlockedError(connectError)) {
      expect(connectError.reason).toBe("unsupported");
      expect(connectError.message).toContain("Update T3 Code");
    }
    expect(server.httpRequests.some((req) => req.path === "/api/auth/websocket-ticket/rpc")).toBe(
      false,
    );
    expect(server.upgradeUrls).toHaveLength(0);
  });

  it("rejects with ConnectionBlockedError when server protocol v99 is newer than client", async () => {
    const server = await startMockServer({
      descriptor: { orchestrationProtocolVersion: 99 },
    });
    const client = createClient();

    let descriptorError: unknown;
    try {
      await client.fetchCompatibleDescriptor(server.url);
    } catch (error) {
      descriptorError = error;
    }
    expect(descriptorError).toBeInstanceOf(ConnectionBlockedError);
    if (isConnectionBlockedError(descriptorError)) {
      expect(descriptorError.reason).toBe("unsupported");
      expect(descriptorError.message).toContain("Update your app");
    }

    let connectError: unknown;
    try {
      await client.connect(server.url, "token");
    } catch (error) {
      connectError = error;
    }
    expect(connectError).toBeInstanceOf(ConnectionBlockedError);
    expect(server.httpRequests.some((req) => req.path === "/api/auth/websocket-ticket/rpc")).toBe(
      false,
    );
    expect(server.upgradeUrls).toHaveLength(0);
  });

  it("falls back to attempting /ws when /api/auth/session returns 404", async () => {
    const server = await startMockServer({
      authSession: {
        status: 404,
        body: { error: "not_found" },
      },
    });
    const client = createClient();

    let caught: unknown;
    try {
      await client.connect(server.url);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(T3AuthenticationError);
    expect(server.upgradeUrls).toHaveLength(1);
    const upgradeUrl = new URL(server.upgradeUrls[0]!, server.url);
    expect(upgradeUrl.searchParams.get(ORCHESTRATION_PROTOCOL_QUERY_PARAM)).toBe(
      String(ORCHESTRATION_PROTOCOL_VERSION),
    );
  });

  it("exchanges pairing credentials and unwraps EnvironmentAuthInvalidError on 401", async () => {
    const successServer = await startMockServer();
    const client = createClient();
    const token = await client.exchangePairingCredential(successServer.url, "pair-code-1");
    expect(token).toEqual({ accessToken: "bearer-123", expiresInSeconds: 2_592_000 });

    const invalidServer = await startMockServer({
      oauthToken: {
        status: 401,
        body: {
          _tag: "EnvironmentAuthInvalidError",
          code: "auth_invalid",
          reason: "invalid_credential",
          traceId: "trace-oauth-1",
        },
      },
    });
    let caught: unknown;
    try {
      await client.exchangePairingCredential(invalidServer.url, "used-code");
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      _tag: "EnvironmentAuthInvalidError",
      reason: "invalid_credential",
    });
    expect((caught as Error).message).toContain("invalid_credential");
  });
});
