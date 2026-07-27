import { assert, describe, it } from "@effect/vitest";
import { PreviewPortUnreachableError } from "@t3tools/contracts";
import * as Net from "@t3tools/shared/Net";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/unstable/http";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { PreviewPortExposure, layer as portExposureLayer } from "./PortExposure.ts";

const encoder = new TextEncoder();

const CLIENT_ON_TAILNET = "https://smart.tail.ts.net/";
const CLIENT_ON_LOOPBACK = "http://localhost:5732/";

interface SpawnCall {
  readonly args: ReadonlyArray<string>;
}

const serveStatusWith = (mappings: ReadonlyArray<{ servePort: number; localPort: number }>) =>
  JSON.stringify({
    Web: Object.fromEntries(
      mappings.map(({ servePort, localPort }) => [
        `smart.tail.ts.net:${servePort}`,
        { Handlers: { "/": { Proxy: `http://127.0.0.1:${localPort}` } } },
      ]),
    ),
  });

/**
 * Records every tailscale invocation and answers `serve status` from a mutable
 * script, so a test can assert that publishing a port is what makes it appear.
 */
const spawnerHarness = (input: {
  readonly serveStatus: () => string;
  readonly onServe?: (args: ReadonlyArray<string>) => { stderr?: string; code?: number };
}) =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<SpawnCall>>([]);
    const layer = Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make((command) => {
        const spawned = command as unknown as { readonly args: ReadonlyArray<string> };
        const args = spawned.args;
        const isStatusRead = args[0] === "serve" && args[1] === "status";
        const result = isStatusRead
          ? { stdout: input.serveStatus(), code: 0 }
          : { stdout: "", ...(input.onServe?.(args) ?? { code: 0 }) };
        return Ref.update(calls, (previous) => [...previous, { args }]).pipe(
          Effect.as(
            ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(1),
              exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.code ?? 0)),
              isRunning: Effect.succeed(false),
              kill: () => Effect.void,
              unref: Effect.succeed(Effect.void),
              stdin: Sink.drain,
              stdout: Stream.make(encoder.encode(result.stdout ?? "")),
              stderr: Stream.make(encoder.encode(result.stderr ?? "")),
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
            }),
          ),
        );
      }),
    );
    return { calls, layer };
  });

const netLayer = (listeningPorts: ReadonlyArray<number>) =>
  Layer.succeed(Net.NetService, {
    canListenOnHost: () => Effect.succeed(true),
    isPortAvailableOnLoopback: (port: number) => Effect.succeed(!listeningPorts.includes(port)),
    reserveLoopbackPort: () => Effect.succeed(0),
    findAvailablePort: (preferred: number) => Effect.succeed(preferred),
  } as Net.NetServiceShape);

/**
 * Answers a probe only for origins the test says are actually serving. Modelled
 * on reachability rather than a fixed status code, because the resolver's whole
 * job is to tell a route that answers from one that does not.
 */
const httpLayer = (isReachable: (url: string) => boolean) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make(
      (
        request,
      ): Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError> =>
        isReachable(request.url)
          ? Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 200 })))
          : Effect.fail(
              new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({
                  request,
                  description: "connection refused",
                }),
              }),
            ),
    ),
  );

const runResolve = (input: {
  readonly port: number;
  readonly clientBaseUrl: string;
  readonly serveStatus: () => string;
  readonly listeningPorts: ReadonlyArray<number>;
  readonly onServe?: (args: ReadonlyArray<string>) => { stderr?: string; code?: number };
  /** Origins that answer beyond whatever the current serve status publishes. */
  readonly alsoReachable?: ReadonlyArray<string>;
  /** Set when a published mapping still must not answer. */
  readonly neverReachable?: boolean;
}) =>
  Effect.gen(function* () {
    const harness = yield* spawnerHarness({
      serveStatus: input.serveStatus,
      ...(input.onServe ? { onServe: input.onServe } : {}),
    });
    const reachable = (url: string) => {
      if (input.neverReachable) return false;
      if (input.alsoReachable?.some((origin) => url.startsWith(origin))) return true;
      const published = JSON.parse(input.serveStatus()) as {
        Web?: Record<string, unknown>;
      };
      return Object.keys(published.Web ?? {}).some((hostKey) =>
        url.startsWith(`https://${hostKey}`),
      );
    };
    const resolving = yield* Effect.forkChild(
      Effect.gen(function* () {
        const exposure = yield* PreviewPortExposure;
        return yield* exposure
          .resolve({ port: input.port, clientBaseUrl: input.clientBaseUrl })
          .pipe(Effect.result);
      }).pipe(
        Effect.provide(
          portExposureLayer.pipe(
            Layer.provide(harness.layer),
            Layer.provide(netLayer(input.listeningPorts)),
            Layer.provide(httpLayer(reachable)),
          ),
        ),
      ),
    );
    // The reachability probe retries on a schedule until a deadline, so an
    // unreachable port only resolves once virtual time passes that deadline.
    yield* TestClock.adjust("10 seconds");
    const result = yield* Fiber.join(resolving);
    return { result, calls: yield* Ref.get(harness.calls) };
  });

describe("PreviewPortExposure", () => {
  it.effect("keeps a same-machine client on loopback and publishes nothing", () =>
    Effect.gen(function* () {
      const { result, calls } = yield* runResolve({
        port: 5733,
        clientBaseUrl: CLIENT_ON_LOOPBACK,
        serveStatus: () => "{}",
        listeningPorts: [5733],
      });

      assert.deepEqual(result._tag === "Success" ? result.success : null, {
        origin: "http://localhost:5733",
        strategy: "loopback",
        createdExposure: false,
      });
      // Nothing was asked of tailscale: a local client never needs the tailnet,
      // and publishing here would share a dev server nobody asked to share.
      assert.deepEqual(calls, []);
    }),
  );

  it.effect("reuses an existing mapping instead of assuming port parity", () =>
    Effect.gen(function* () {
      const { result, calls } = yield* runResolve({
        port: 5733,
        clientBaseUrl: CLIENT_ON_TAILNET,
        // Published on a different tailnet port, over https — exactly the shape
        // the old client-side guess (same port, same scheme) got wrong.
        serveStatus: () => serveStatusWith([{ servePort: 45733, localPort: 5733 }]),
        listeningPorts: [5733],
      });

      assert.deepEqual(result._tag === "Success" ? result.success : null, {
        origin: "https://smart.tail.ts.net:45733",
        strategy: "tailnet-serve",
        createdExposure: false,
      });
      assert.isUndefined(calls.find((call) => call.args.includes("--bg")));
    }),
  );

  it.effect("uses the environment's own address when the port already answers there", () =>
    Effect.gen(function* () {
      const { result, calls } = yield* runResolve({
        port: 5173,
        // A WSL / LAN environment, where a dev server bound to a wildcard
        // address is genuinely reachable at the host the client already uses.
        clientBaseUrl: "http://172.25.85.75:3773/",
        serveStatus: () => "{}",
        listeningPorts: [5173],
        alsoReachable: ["http://172.25.85.75:5173"],
      });

      assert.deepEqual(result._tag === "Success" ? result.success : null, {
        origin: "http://172.25.85.75:5173",
        strategy: "direct-private-network",
        createdExposure: false,
      });
      // Nothing published: a route that already works needs no second one.
      assert.isUndefined(calls.find((call) => call.args.includes("--bg")));
    }),
  );

  it.effect("publishes a loopback-only port on demand", () =>
    Effect.gen(function* () {
      let published = false;
      const { result, calls } = yield* runResolve({
        port: 6545,
        clientBaseUrl: CLIENT_ON_TAILNET,
        serveStatus: () =>
          published ? serveStatusWith([{ servePort: 6545, localPort: 6545 }]) : "{}",
        listeningPorts: [6545],
        onServe: () => {
          published = true;
          return { code: 0 };
        },
      });

      assert.deepEqual(result._tag === "Success" ? result.success : null, {
        origin: "https://smart.tail.ts.net:6545",
        strategy: "tailnet-serve",
        createdExposure: true,
      });
      // Targets `localhost`, not `127.0.0.1`: Vite's default bind is `::1` only,
      // and an IPv4-pinned mapping proxies to nothing and answers 502.
      assert.deepEqual(calls.find((call) => call.args.includes("--bg"))?.args, [
        "serve",
        "--bg",
        "--https=6545",
        "http://localhost:6545",
      ]);
    }),
  );

  it.effect("fails with a remedy when the dev server is not running", () =>
    Effect.gen(function* () {
      const { result } = yield* runResolve({
        port: 6545,
        clientBaseUrl: CLIENT_ON_TAILNET,
        serveStatus: () => "{}",
        listeningPorts: [],
      });

      const error = result._tag === "Failure" ? result.failure : null;
      assert.instanceOf(error, PreviewPortUnreachableError);
      assert.equal(error?.reason, "not-listening");
      assert.include(error?.message ?? "", "Start the dev server first");
    }),
  );

  it.effect("refuses to take over a tailnet port that routes elsewhere", () =>
    Effect.gen(function* () {
      const { result, calls } = yield* runResolve({
        port: 6545,
        clientBaseUrl: CLIENT_ON_TAILNET,
        serveStatus: () =>
          serveStatusWith([
            { servePort: 6545, localPort: 9999 },
            { servePort: 46545, localPort: 9998 },
          ]),
        listeningPorts: [6545],
      });

      const error = result._tag === "Failure" ? result.failure : null;
      assert.equal(error?.reason, "serve-port-conflict");
      // The pre-existing mapping is left exactly as it was found.
      assert.isUndefined(calls.find((call) => call.args.includes("--bg")));
    }),
  );

  it.effect("surfaces a permission failure as an actionable reason", () =>
    Effect.gen(function* () {
      const { result } = yield* runResolve({
        port: 6545,
        clientBaseUrl: CLIENT_ON_TAILNET,
        serveStatus: () => "{}",
        listeningPorts: [6545],
        onServe: () => ({ code: 1, stderr: "access denied: must be root" }),
      });

      const error = result._tag === "Failure" ? result.failure : null;
      assert.equal(error?.reason, "tailscale-permission-denied");
      // The classified label travels, never the raw stderr.
      assert.notInclude(error?.message ?? "", "must be root");
    }),
  );

  it.effect("withdraws a mapping it published but could not reach", () =>
    Effect.gen(function* () {
      let published = false;
      const { result, calls } = yield* runResolve({
        port: 6545,
        clientBaseUrl: CLIENT_ON_TAILNET,
        serveStatus: () =>
          published ? serveStatusWith([{ servePort: 6545, localPort: 6545 }]) : "{}",
        listeningPorts: [6545],
        onServe: () => {
          published = true;
          return { code: 0 };
        },
        neverReachable: true,
      });

      const error = result._tag === "Failure" ? result.failure : null;
      assert.equal(error?.reason, "not-reachable");
      // Publishing a port and then leaving it behind would keep a dead route on
      // the tailnet, so the failure path has to undo its own mapping.
      assert.deepEqual(calls.at(-1)?.args, ["serve", "--https=6545", "off"]);
    }),
  );
});
