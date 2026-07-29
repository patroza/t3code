import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

export const DEFAULT_TAILSCALE_SERVE_PORT = 443;
export const TAILSCALE_STATUS_TIMEOUT = Duration.millis(1_500);
export const TAILSCALE_SERVE_TIMEOUT = Duration.seconds(10);
export const TAILSCALE_PROBE_TIMEOUT = Duration.millis(2_500);

// tailscale is a real executable everywhere (`tailscale.exe` on Windows), so
// it is always spawned directly rather than through cmd.exe shell mode.
const tailscaleCommandForPlatform = (platform: NodeJS.Platform): "tailscale" | "tailscale.exe" =>
  platform === "win32" ? "tailscale.exe" : "tailscale";

const TailscaleCommandContext = {
  executable: Schema.Literals(["tailscale", "tailscale.exe"]),
  subcommand: Schema.Literals(["status", "serve"]),
  argumentCount: Schema.Number,
};

/**
 * Failure kinds we can name without quoting the CLI. Anything unrecognized
 * becomes "unknown" rather than falling back to raw text — stderr can contain
 * auth keys (`tskey-…`) and node names, and these labels are logged.
 */
export const TailscaleStderrDiagnostic = Schema.Literals([
  "no-existing-handler",
  "not-logged-in",
  "permission-denied",
  "unknown",
]);
export type TailscaleStderrDiagnostic = typeof TailscaleStderrDiagnostic.Type;

// Matched against stderr, most specific first. Patterns are deliberately short
// and anchored on tailscale's own wording.
const STDERR_DIAGNOSTIC_PATTERNS: ReadonlyArray<
  readonly [RegExp, Exclude<TailscaleStderrDiagnostic, "unknown">]
> = [
  [/handler does not exist/i, "no-existing-handler"],
  [/not logged in|logged out|needs? login/i, "not-logged-in"],
  [/permission denied|access denied|must be root|operation not permitted/i, "permission-denied"],
];

/** Classifies stderr into a safe label, dropping the text itself. */
export const stderrDiagnosticOf = (stderr: string): TailscaleStderrDiagnostic | undefined => {
  if (stderr.trim().length === 0) {
    return undefined;
  }
  return STDERR_DIAGNOSTIC_PATTERNS.find(([pattern]) => pattern.test(stderr))?.[1] ?? "unknown";
};

export class TailscaleCommandSpawnError extends Schema.TaggedErrorClass<TailscaleCommandSpawnError>()(
  "TailscaleCommandSpawnError",
  {
    ...TailscaleCommandContext,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to spawn tailscale ${this.subcommand}.`;
  }
}

export class TailscaleCommandOutputError extends Schema.TaggedErrorClass<TailscaleCommandOutputError>()(
  "TailscaleCommandOutputError",
  {
    ...TailscaleCommandContext,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to read output from tailscale ${this.subcommand}.`;
  }
}

export class TailscaleCommandExitError extends Schema.TaggedErrorClass<TailscaleCommandExitError>()(
  "TailscaleCommandExitError",
  {
    ...TailscaleCommandContext,
    exitCode: Schema.Number,
    stdoutLength: Schema.optional(Schema.Number),
    stderrLength: Schema.Number,
    // A classified diagnostic, never raw CLI output. `tailscale` prints auth
    // keys and node identifiers into stderr, and this field is surfaced in
    // dev-runner logs — so it carries only a known-safe label from the closed
    // set below. Callers that need to recognize a specific failure (e.g.
    // `serve off` on a port with no mapping) match on the label.
    stderrDiagnostic: Schema.optional(TailscaleStderrDiagnostic),
  },
) {
  override get message(): string {
    return `tailscale ${this.subcommand} exited with code ${this.exitCode}.`;
  }
}

export class TailscaleCommandTimeoutError extends Schema.TaggedErrorClass<TailscaleCommandTimeoutError>()(
  "TailscaleCommandTimeoutError",
  {
    ...TailscaleCommandContext,
    timeoutMs: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `tailscale ${this.subcommand} timed out after ${this.timeoutMs}ms.`;
  }
}

export const TailscaleCommandError = Schema.Union([
  TailscaleCommandSpawnError,
  TailscaleCommandOutputError,
  TailscaleCommandExitError,
  TailscaleCommandTimeoutError,
]);
export type TailscaleCommandError = typeof TailscaleCommandError.Type;

export class TailscaleStatusParseError extends Schema.TaggedErrorClass<TailscaleStatusParseError>()(
  "TailscaleStatusParseError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to decode tailscale status JSON.";
  }
}

export class TailscaleServeStatusParseError extends Schema.TaggedErrorClass<TailscaleServeStatusParseError>()(
  "TailscaleServeStatusParseError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to decode tailscale serve status JSON.";
  }
}

const TailscaleStatusSelf = Schema.Struct({
  DNSName: Schema.optional(Schema.Unknown),
  TailscaleIPs: Schema.optional(Schema.Unknown),
});

const TailscaleStatusJson = Schema.Struct({
  Self: Schema.optional(TailscaleStatusSelf),
});

export type TailscaleStatusSelf = typeof TailscaleStatusSelf.Type;
export type TailscaleStatusJson = typeof TailscaleStatusJson.Type;

export interface TailscaleStatus {
  readonly magicDnsName: string | null;
  readonly tailnetIpv4Addresses: readonly string[];
}

const collectStdout = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => acc + chunk,
    ),
  );

const collectStderr = collectStdout;

const decodeTailscaleStatusJson = Schema.decodeEffect(Schema.fromJsonString(TailscaleStatusJson));

function normalizeMagicDnsName(status: TailscaleStatusJson): string | null {
  const dnsName = status.Self?.DNSName;
  if (typeof dnsName !== "string") {
    return null;
  }

  const normalized = dnsName.trim().replace(/\.$/u, "");
  return normalized.length > 0 ? normalized : null;
}

export const parseTailscaleMagicDnsName = (
  rawStatusJson: string,
): Effect.Effect<string | null, TailscaleStatusParseError> =>
  decodeTailscaleStatusJson(rawStatusJson).pipe(
    Effect.mapError((cause) => new TailscaleStatusParseError({ cause })),
    Effect.map(normalizeMagicDnsName),
  );

export function isTailscaleIpv4Address(address: string): boolean {
  const parts = address.split(".");
  if (parts.length !== 4) {
    return false;
  }
  const [first, second, third, fourth] = parts.map((part) => Number.parseInt(part, 10));
  if (
    first === undefined ||
    second === undefined ||
    third === undefined ||
    fourth === undefined ||
    [first, second, third, fourth].some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }
  return first === 100 && second >= 64 && second <= 127;
}

export const parseTailscaleStatus = (
  rawStatusJson: string,
): Effect.Effect<TailscaleStatus, TailscaleStatusParseError> =>
  decodeTailscaleStatusJson(rawStatusJson).pipe(
    Effect.mapError((cause) => new TailscaleStatusParseError({ cause })),
    Effect.map((parsed) => {
      const rawIps = parsed.Self?.TailscaleIPs;
      const tailnetIpv4Addresses: Array<string> = [];
      if (Array.isArray(rawIps)) {
        for (const address of rawIps) {
          if (typeof address === "string" && isTailscaleIpv4Address(address)) {
            tailnetIpv4Addresses.push(address);
          }
        }
      }

      return {
        magicDnsName: normalizeMagicDnsName(parsed),
        tailnetIpv4Addresses,
      };
    }),
  );

/**
 * Runs a tailscale subcommand that answers on stdout, applying the same
 * spawn/exit/timeout error mapping as the rest of this module. `serve status`
 * and `status` differ only in arguments and how the payload is decoded.
 */
const readTailscaleCommandStdout = (input: {
  readonly args: readonly string[];
  readonly subcommand: "status" | "serve";
  readonly timeout: Duration.Duration;
}) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const hostPlatform = yield* HostProcessPlatform;
    const executable = tailscaleCommandForPlatform(hostPlatform);
    const commandContext = {
      executable,
      subcommand: input.subcommand,
      argumentCount: input.args.length,
    };
    return yield* Effect.gen(function* () {
      const child = yield* spawner
        .spawn(ChildProcess.make(executable, input.args))
        .pipe(
          Effect.mapError((cause) => new TailscaleCommandSpawnError({ ...commandContext, cause })),
        );
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          collectStdout(child.stdout),
          collectStderr(child.stderr),
          child.exitCode.pipe(Effect.map(Number)),
        ],
        { concurrency: "unbounded" },
      ).pipe(
        Effect.mapError((cause) => new TailscaleCommandOutputError({ ...commandContext, cause })),
      );
      if (exitCode !== 0) {
        return yield* new TailscaleCommandExitError({
          ...commandContext,
          exitCode,
          stdoutLength: stdout.length,
          stderrLength: stderr.length,
          ...(stderrDiagnosticOf(stderr) !== undefined
            ? { stderrDiagnostic: stderrDiagnosticOf(stderr) }
            : {}),
        });
      }
      return stdout;
    }).pipe(
      Effect.scoped,
      Effect.timeout(input.timeout),
      Effect.catchTags({
        TimeoutError: (cause) =>
          Effect.fail(
            new TailscaleCommandTimeoutError({
              ...commandContext,
              timeoutMs: Duration.toMillis(input.timeout),
              cause,
            }),
          ),
      }),
    );
  });

export const readTailscaleStatus = readTailscaleCommandStdout({
  args: ["status", "--json"],
  subcommand: "status",
  timeout: TAILSCALE_STATUS_TIMEOUT,
}).pipe(Effect.flatMap(parseTailscaleStatus));

/**
 * One `tailscale serve` HTTPS mapping, flattened from the `Web` section of
 * `tailscale serve status --json`.
 *
 * `servePort` is the port the tailnet dials and `localPort` the loopback port
 * behind it. They are frequently different — nothing forces serve mappings to
 * preserve the port number — which is why callers must read this instead of
 * assuming the local port is also reachable on the tailnet.
 */
export interface TailscaleServeMapping {
  readonly magicDnsName: string;
  readonly servePort: number;
  readonly path: string;
  readonly localHost: string;
  readonly localPort: number;
  /** Always https: `tailscale serve` terminates TLS for every Web handler. */
  readonly url: string;
}

const TailscaleServeHandler = Schema.Struct({
  Proxy: Schema.optional(Schema.Unknown),
});

const TailscaleServeWebEntry = Schema.Struct({
  Handlers: Schema.optional(Schema.Record(Schema.String, TailscaleServeHandler)),
});

const TailscaleServeStatusJson = Schema.Struct({
  Web: Schema.optional(Schema.Record(Schema.String, TailscaleServeWebEntry)),
});

const decodeTailscaleServeStatusJson = Schema.decodeEffect(
  Schema.fromJsonString(TailscaleServeStatusJson),
);

/** Splits a `host:port` serve key, tolerating bracketed IPv6 literals. */
const parseServeHostKey = (key: string): { host: string; port: number } | null => {
  const separator = key.lastIndexOf(":");
  if (separator <= 0) return null;
  const host = key.slice(0, separator).replace(/^\[|\]$/gu, "");
  const port = Number.parseInt(key.slice(separator + 1), 10);
  return host.length > 0 && Number.isInteger(port) && port > 0 && port < 65536
    ? { host, port }
    : null;
};

export const parseTailscaleServeMappings = (
  rawServeStatusJson: string,
): Effect.Effect<readonly TailscaleServeMapping[], TailscaleServeStatusParseError> =>
  decodeTailscaleServeStatusJson(rawServeStatusJson).pipe(
    Effect.mapError((cause) => new TailscaleServeStatusParseError({ cause })),
    Effect.map((parsed) => {
      const mappings: Array<TailscaleServeMapping> = [];
      for (const [hostKey, entry] of Object.entries(parsed.Web ?? {})) {
        const target = parseServeHostKey(hostKey);
        if (!target) continue;
        for (const [path, handler] of Object.entries(entry.Handlers ?? {})) {
          if (typeof handler.Proxy !== "string") continue;
          // A non-proxy handler (static text, a file share) has no local port
          // to match against, so it is not a route to a dev server.
          let proxy: URL;
          try {
            proxy = new URL(handler.Proxy);
          } catch {
            continue;
          }
          const localPort = Number.parseInt(proxy.port, 10);
          if (!Number.isInteger(localPort) || localPort <= 0) continue;
          const url = new URL(`https://${hostKey}`);
          url.pathname = path;
          mappings.push({
            magicDnsName: target.host,
            servePort: target.port,
            path,
            localHost: proxy.hostname.replace(/^\[|\]$/gu, ""),
            localPort,
            url: url.toString(),
          });
        }
      }
      return mappings;
    }),
  );

export const readTailscaleServeMappings = readTailscaleCommandStdout({
  args: ["serve", "status", "--json"],
  subcommand: "serve",
  timeout: TAILSCALE_STATUS_TIMEOUT,
}).pipe(Effect.flatMap(parseTailscaleServeMappings));

/**
 * The mapping that serves `localPort` at the site root, if one exists.
 *
 * Root-only: a mapping under a sub-path rewrites neither the dev server's
 * absolute asset URLs (`/@vite/client`) nor its HMR websocket, so handing one
 * out would load a blank page instead of failing honestly.
 */
export const findRootServeMappingForLocalPort = (
  mappings: readonly TailscaleServeMapping[],
  localPort: number,
): TailscaleServeMapping | undefined =>
  mappings.find((mapping) => mapping.localPort === localPort && mapping.path === "/");

export function buildTailscaleHttpsBaseUrl(input: {
  readonly magicDnsName: string;
  readonly servePort?: number;
}): string {
  const url = new URL(`https://${input.magicDnsName}`);
  const servePort = input.servePort ?? DEFAULT_TAILSCALE_SERVE_PORT;
  if (servePort !== DEFAULT_TAILSCALE_SERVE_PORT) {
    url.port = String(servePort);
  }
  url.pathname = "/";
  return url.toString();
}

const runTailscaleCommand = (
  args: readonly string[],
  timeoutInput: Duration.Input,
): Effect.Effect<void, TailscaleCommandError, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const hostPlatform = yield* HostProcessPlatform;
    const executable = tailscaleCommandForPlatform(hostPlatform);
    const commandContext = {
      executable,
      subcommand: "serve" as const,
      argumentCount: args.length,
    };
    const timeout = Duration.fromInputUnsafe(timeoutInput);
    return yield* Effect.gen(function* () {
      const child = yield* spawner
        .spawn(ChildProcess.make(executable, args))
        .pipe(
          Effect.mapError((cause) => new TailscaleCommandSpawnError({ ...commandContext, cause })),
        );
      const [stderr, exitCode] = yield* Effect.all(
        [collectStderr(child.stderr), child.exitCode.pipe(Effect.map(Number))],
        { concurrency: "unbounded" },
      ).pipe(
        Effect.mapError((cause) => new TailscaleCommandOutputError({ ...commandContext, cause })),
      );
      if (exitCode !== 0) {
        return yield* new TailscaleCommandExitError({
          ...commandContext,
          exitCode,
          stderrLength: stderr.length,
          ...(stderrDiagnosticOf(stderr) !== undefined
            ? { stderrDiagnostic: stderrDiagnosticOf(stderr) }
            : {}),
        });
      }
    }).pipe(
      Effect.scoped,
      Effect.timeout(timeout),
      Effect.catchTags({
        TimeoutError: (cause) =>
          Effect.fail(
            new TailscaleCommandTimeoutError({
              ...commandContext,
              timeoutMs: Duration.toMillis(timeout),
              cause,
            }),
          ),
      }),
    );
  });

export const ensureTailscaleServe = (input: {
  readonly localPort: number;
  readonly servePort?: number;
  readonly localHost?: string;
}): Effect.Effect<void, TailscaleCommandError, ChildProcessSpawner.ChildProcessSpawner> => {
  const servePort = input.servePort ?? DEFAULT_TAILSCALE_SERVE_PORT;
  const localHost = input.localHost ?? "127.0.0.1";
  const args = ["serve", "--bg", `--https=${servePort}`, `http://${localHost}:${input.localPort}`];
  return runTailscaleCommand(args, TAILSCALE_SERVE_TIMEOUT);
};

export const disableTailscaleServe = (
  input: {
    readonly servePort?: number;
  } = {},
): Effect.Effect<void, TailscaleCommandError, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const servePort = input.servePort ?? DEFAULT_TAILSCALE_SERVE_PORT;
    return yield* runTailscaleCommand(
      ["serve", `--https=${servePort}`, "off"],
      TAILSCALE_SERVE_TIMEOUT,
    );
  });

export const probeTailscaleHttpsEndpoint = (input: {
  readonly baseUrl: string;
  readonly timeout?: Duration.Input;
}): Effect.Effect<boolean, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* Effect.gen(function* () {
      const url = new URL("/.well-known/t3/environment", input.baseUrl);
      const request = HttpClientRequest.get(url.toString());
      return yield* client.execute(request);
    }).pipe(Effect.timeoutOption(input.timeout ?? TAILSCALE_PROBE_TIMEOUT));

    return Option.match(response, {
      onNone: () => false,
      onSome: (httpResponse) => httpResponse.status >= 200 && httpResponse.status < 300,
    });
  }).pipe(Effect.orElseSucceed(() => false));

export const resolveTailscaleHttpsBaseUrl = (
  input: {
    readonly servePort?: number;
  } = {},
): Effect.Effect<
  string | null,
  TailscaleCommandError | TailscaleStatusParseError,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  readTailscaleStatus.pipe(
    Effect.map((status) =>
      status.magicDnsName
        ? buildTailscaleHttpsBaseUrl({
            magicDnsName: status.magicDnsName,
            ...(input.servePort === undefined ? {} : { servePort: input.servePort }),
          })
        : null,
    ),
  );
