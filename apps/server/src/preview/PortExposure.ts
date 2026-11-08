// Resolve preview URLs on the server: only it knows local listeners and actual tailnet routes.
// Reuse or publish a verified mapping; fail with a reason instead of guessing a host/port URL.
import {
  PreviewPortUnreachableError,
  type PreviewPortResolution,
  type PreviewPortResolveRequest,
} from "@t3tools/contracts";
import * as Net from "@t3tools/shared/Net";
import { isLoopbackHost } from "@t3tools/shared/preview";
import {
  disableTailscaleServe,
  ensureTailscaleServe,
  findRootServeMappingForLocalPort,
  readTailscaleServeMappings,
  type TailscaleServeMapping,
} from "@t3tools/tailscale";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import { HttpClient, HttpClientRequest } from "effect/http";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

export class PreviewPortExposure extends Context.Service<
  PreviewPortExposure,
  {
    readonly resolve: (
      request: PreviewPortResolveRequest,
    ) => Effect.Effect<PreviewPortResolution, PreviewPortUnreachableError>;
  }
>()("t3/preview/PortExposure/PreviewPortExposure") {}

/**
 * A tailnet mapping only carries a dev server correctly when it is offered at
 * the site root, so the serve port is the only free variable. Preferring the
 * local port number keeps parity with `vp run dev --share`, which makes an
 * already-shared dev server resolve to the URL the developer was told about.
 */
const SERVE_PORT_FALLBACK_OFFSET = 40_000;

const PROBE_TIMEOUT = Duration.seconds(2);
// A new serve listener or MagicDNS certificate may not be ready when tailscale returns.
// Retry against one overall deadline so slow attempts cannot multiply the caller wait.
const PROBE_SCHEDULE = Schedule.spaced(Duration.millis(250));
const PROBE_DEADLINE = Duration.seconds(5);

// Use localhost so tailscale reaches either IPv4 or IPv6; Vite may bind only ::1.
const SERVE_TARGET_HOST = "localhost";

const REMEDY_BY_REASON = {
  "tailscale-unavailable":
    "This machine has no tailnet identity, so a loopback-only dev server cannot be reached from a remote client. Run the client on this machine, or bring up Tailscale here.",
  "tailscale-not-logged-in": "Run `tailscale up` on the environment host, then retry.",
  "tailscale-permission-denied":
    "The server may not manage tailnet routes. Run `sudo tailscale set --operator=$USER` on the environment host, or publish the port yourself with `tailscale serve`.",
  "not-listening": "Start the dev server first, then open the port again.",
} as const;

const conflictRemedy = (port: number, servePort: number): string =>
  `Tailnet port ${servePort} already routes somewhere else, so port ${port} cannot be published without taking it over. Free it with \`tailscale serve --https=${servePort} off\`, or publish the port yourself on a spare tailnet port.`;

const exposureRemedy = (port: number): string =>
  `Publish it manually with \`tailscale serve --bg --https=${port} http://${SERVE_TARGET_HOST}:${port}\`, or restart the dev server with \`vp run dev --share\`.`;

const unreachableRemedy = (port: number, origin: string): string =>
  `${origin} was published but did not answer. Confirm the dev server on port ${port} is serving, and that this client is on the same tailnet.`;

/** Maps a tailscale CLI failure onto a reason the caller can act on. */
const reasonForTailscaleError = (
  error: unknown,
): "tailscale-not-logged-in" | "tailscale-permission-denied" | "exposure-failed" => {
  const diagnostic =
    typeof error === "object" && error !== null && "stderrDiagnostic" in error
      ? (error as { readonly stderrDiagnostic?: string }).stderrDiagnostic
      : undefined;
  if (diagnostic === "not-logged-in") return "tailscale-not-logged-in";
  if (diagnostic === "permission-denied") return "tailscale-permission-denied";
  return "exposure-failed";
};

const originOf = (url: string): string => new URL(url).origin;

export const make = Effect.gen(function* () {
  const net = yield* Net.NetService;
  const httpClient = yield* HttpClient.HttpClient;
  // Captured once so the service's own signature stays free of process
  // plumbing: callers ask for a reachable URL, not for a way to run tailscale.
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  /**
   * Serve ports this process published, so they can be withdrawn again. A
   * mapping outlives the process that made it, so leaving them behind would
   * keep publishing a port on the tailnet long after its dev server exited.
   */
  const created = yield* Ref.make<ReadonlyMap<number, number>>(new Map());

  const withdraw = (localPort: number, servePort: number) =>
    disableTailscaleServe({ servePort }).pipe(
      Effect.tap(() =>
        Effect.logInfo("Withdrew preview tailnet mapping", { localPort, servePort }),
      ),
      Effect.catch((cause) =>
        Effect.logWarning("Failed to withdraw preview tailnet mapping", {
          cause,
          localPort,
          servePort,
        }),
      ),
      Effect.andThen(
        Ref.update(created, (entries) => {
          const next = new Map(entries);
          next.delete(localPort);
          return next;
        }),
      ),
    );

  /**
   * Drops mappings whose dev server has since exited. Reconciling here rather
   * than on a timer keeps the common path free of a background poller: a stale
   * mapping is only observable through this service, and every observation
   * passes through here first.
   */
  const reconcile = Effect.gen(function* () {
    const entries = yield* Ref.get(created);
    for (const [localPort, servePort] of entries) {
      if (yield* net.isPortAvailableOnLoopback(localPort)) {
        yield* withdraw(localPort, servePort);
      }
    }
  });

  const fail = (port: number, reason: PreviewPortUnreachableError["reason"], remedy: string) =>
    Effect.fail(new PreviewPortUnreachableError({ port, reason, remedy }));

  // Any HTTP answer proves the route works. A dev server is free to 404 its own
  // root (an API-only server does), and that is still reachable.
  const probeOnce = (origin: string) =>
    httpClient
      .execute(HttpClientRequest.get(origin))
      .pipe(Effect.timeout(PROBE_TIMEOUT), Effect.scoped, Effect.as(true));

  /** One attempt — used to test a route that either already exists or does not. */
  const isReachable = (origin: string) => probeOnce(origin).pipe(Effect.orElseSucceed(() => false));

  /** Resolves once a freshly published origin answers. */
  const becomesReachable = (origin: string) =>
    probeOnce(origin).pipe(
      Effect.retry({ schedule: PROBE_SCHEDULE }),
      Effect.timeout(PROBE_DEADLINE),
      Effect.orElseSucceed(() => false),
    );

  const pickServePort = (port: number, mappings: readonly TailscaleServeMapping[]) => {
    const takenBySomethingElse = (candidate: number) =>
      mappings.some((mapping) => mapping.servePort === candidate && mapping.localPort !== port);
    if (!takenBySomethingElse(port)) return port;
    const fallback = port + SERVE_PORT_FALLBACK_OFFSET;
    if (fallback < 65_536 && !takenBySomethingElse(fallback)) return fallback;
    return null;
  };

  const resolve = Effect.fn("PortExposure.resolve")(function* (request: PreviewPortResolveRequest) {
    const { port } = request;

    // A client on the same machine reaches the port directly; publishing it
    // on the tailnet would expose a dev server nobody asked to share.
    const clientUrl = yield* Effect.try({
      try: () => new URL(request.clientBaseUrl),
      catch: () => null,
    }).pipe(Effect.orElseSucceed(() => null));
    if (clientUrl !== null && isLoopbackHost(clientUrl.hostname)) {
      return {
        origin: `http://localhost:${port}`,
        strategy: "loopback",
        createdExposure: false,
      } satisfies PreviewPortResolution;
    }

    yield* reconcile;

    if (yield* net.isPortAvailableOnLoopback(port)) {
      return yield* fail(port, "not-listening", REMEDY_BY_REASON["not-listening"]);
    }

    // Read the tailnet's routes before probing anything. A host without
    // tailscale is not an error yet — the port may still answer directly —
    // so a failure here only rules out the tailnet branch.
    const mappings = yield* readTailscaleServeMappings.pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Failed to read tailnet serve mappings", { cause, port }).pipe(
          Effect.as(null),
        ),
      ),
    );

    const existing = mappings && findRootServeMappingForLocalPort(mappings, port);
    if (existing) {
      return {
        origin: originOf(existing.url),
        strategy: "tailnet-serve",
        createdExposure: false,
      } satisfies PreviewPortResolution;
    }

    // Prefer a verified environment-address listener over creating a redundant tailnet route.
    // Skip that probe if a serve mapping already uses the port, or it could identify the wrong app.
    const shadowedByOtherMapping =
      mappings?.some((mapping) => mapping.servePort === port && mapping.localPort !== port) ??
      false;
    if (clientUrl !== null && !shadowedByOtherMapping) {
      const directOrigin = `${clientUrl.protocol}//${clientUrl.hostname}:${port}`;
      if (yield* isReachable(directOrigin)) {
        return {
          origin: directOrigin,
          strategy: "direct-private-network",
          createdExposure: false,
        } satisfies PreviewPortResolution;
      }
    }

    if (mappings === null) {
      return yield* fail(port, "tailscale-unavailable", REMEDY_BY_REASON["tailscale-unavailable"]);
    }

    const servePort = pickServePort(port, mappings);
    if (servePort === null) {
      return yield* fail(port, "serve-port-conflict", conflictRemedy(port, port));
    }

    yield* ensureTailscaleServe({
      localPort: port,
      servePort,
      localHost: SERVE_TARGET_HOST,
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Failed to publish preview port on the tailnet", {
          cause,
          port,
          servePort,
        }).pipe(Effect.andThen(fail(port, reasonForTailscaleError(cause), exposureRemedy(port)))),
      ),
    );
    yield* Ref.update(created, (entries) => new Map(entries).set(port, servePort));

    const published = yield* readTailscaleServeMappings.pipe(
      Effect.map((refreshed) => findRootServeMappingForLocalPort(refreshed, port)),
      Effect.orElseSucceed(() => undefined),
    );
    if (!published) {
      yield* withdraw(port, servePort);
      return yield* fail(port, "exposure-failed", exposureRemedy(port));
    }

    const origin = originOf(published.url);
    // Verify before answering: a URL that resolves but does not serve is the
    // failure this whole path exists to remove.
    if (!(yield* becomesReachable(origin))) {
      yield* withdraw(port, servePort);
      return yield* fail(port, "not-reachable", unreachableRemedy(port, origin));
    }

    yield* Effect.logInfo("Published preview port on the tailnet", { port, servePort, origin });
    return {
      origin,
      strategy: "tailnet-serve",
      createdExposure: true,
    } satisfies PreviewPortResolution;
  });

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      for (const [localPort, servePort] of yield* Ref.get(created)) {
        yield* withdraw(localPort, servePort);
      }
    }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)),
  );

  return PreviewPortExposure.of({
    resolve: Effect.fn("PreviewPortExposure.resolve")((request) =>
      resolve(request).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      ),
    ),
  });
});

export const layer = Layer.effect(PreviewPortExposure, make);
