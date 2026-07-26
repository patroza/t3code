import { resolveCommandPath } from "@t3tools/shared/shell";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "../processRunner.ts";
import { ProviderAdapterProcessError } from "./Errors.ts";

const DIRENV_MAX_OUTPUT_BYTES = 64 * 1024;
const DIRENV_TIMEOUT = "30 seconds";
const STDERR_DETAIL_MAX_LENGTH = 2_048;
// `decodeJsonResult` diagnostics deliberately exclude the raw values, so a
// failure here never leaks direnv stdout across process and UI boundaries.
const decodeDirenvPatch = decodeJsonResult(
  Schema.Record(Schema.String, Schema.NullOr(Schema.String)),
);

export class DirenvEnvironmentError extends Schema.TaggedErrorClass<DirenvEnvironmentError>()(
  "DirenvEnvironmentError",
  {
    stage: Schema.Literals(["inspection", "execution", "invalid-output"]),
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to resolve direnv environment during ${this.stage}: ${this.detail}`;
  }
}

export class DirenvEnvironment extends Context.Service<
  DirenvEnvironment,
  {
    readonly allow: (input: {
      readonly cwd: string;
      readonly environment: NodeJS.ProcessEnv;
    }) => Effect.Effect<void, DirenvEnvironmentError>;
    readonly resolve: (input: {
      readonly cwd: string;
      readonly environment: NodeJS.ProcessEnv;
    }) => Effect.Effect<NodeJS.ProcessEnv, DirenvEnvironmentError>;
  }
>()("t3/provider/DirenvEnvironment") {}

export const identityDirenvEnvironmentResolver: DirenvEnvironment["Service"]["resolve"] = (input) =>
  Effect.succeed(input.environment);

export const noopDirenvEnvironmentAllow: DirenvEnvironment["Service"]["allow"] = () => Effect.void;

/**
 * Resolves a provider session environment through the optional direnv
 * resolver, mapping failures into the adapter error domain. Adapters that
 * are constructed without a resolver (tests) keep the base environment.
 */
export const resolveProviderSessionEnvironment = (input: {
  readonly resolve: DirenvEnvironment["Service"]["resolve"] | undefined;
  readonly provider: string;
  readonly threadId: string;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
}): Effect.Effect<NodeJS.ProcessEnv, ProviderAdapterProcessError> =>
  input.resolve === undefined
    ? Effect.succeed(input.environment)
    : input.resolve({ cwd: input.cwd, environment: input.environment }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterProcessError({
              provider: input.provider,
              threadId: input.threadId,
              detail: cause.message,
              cause,
            }),
        ),
      );

function conciseStderr(stderr: string, environment: NodeJS.ProcessEnv): string | undefined {
  let redacted = stderr;
  const environmentValues = Array.from(
    new Set(
      Object.values(environment).filter(
        (value): value is string => typeof value === "string" && value.length >= 4,
      ),
    ),
  ).sort((left, right) => right.length - left.length);
  for (const value of environmentValues) {
    redacted = redacted.split(value).join("[redacted]");
  }

  const normalized = redacted.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) return undefined;
  if (normalized.length <= STDERR_DETAIL_MAX_LENGTH) return normalized;
  return `${normalized.slice(0, STDERR_DETAIL_MAX_LENGTH)}…`;
}

export const make = Effect.fn("DirenvEnvironment.make")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const processRunner = yield* ProcessRunner.ProcessRunner;

  const envrcExists = (candidate: string) =>
    fileSystem.exists(candidate).pipe(
      Effect.mapError(
        (cause) =>
          new DirenvEnvironmentError({
            stage: "inspection",
            detail: `Could not inspect '${candidate}'.`,
            cause,
          }),
      ),
    );

  // Cached per PATH value for the lifetime of the service: sessions in the
  // same environment would otherwise re-scan PATH on every start.
  const direnvPathCache = new Map<string, string | undefined>();
  const findDirenv = Effect.fn("DirenvEnvironment.findDirenv")(function* (
    environment: NodeJS.ProcessEnv,
  ) {
    const cacheKey = environment.PATH ?? "";
    if (direnvPathCache.has(cacheKey)) return direnvPathCache.get(cacheKey);
    const direnvPath = yield* resolveCommandPath("direnv", { env: environment }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.catchTag("CommandResolutionError", () => Effect.void),
    );
    direnvPathCache.set(cacheKey, direnvPath ?? undefined);
    return direnvPath ?? undefined;
  });

  /** Runs direnv, or returns `undefined` when direnv is not installed. */
  const runDirenv = Effect.fn("DirenvEnvironment.runDirenv")(function* (input: {
    readonly commandLabel: string;
    readonly args: ReadonlyArray<string>;
    readonly cwd: string;
    readonly environment: NodeJS.ProcessEnv;
  }) {
    const direnvPath = yield* findDirenv(input.environment);
    if (direnvPath === undefined) return undefined;

    const output = yield* processRunner
      .run({
        command: direnvPath,
        args: input.args,
        cwd: input.cwd,
        env: input.environment,
        extendEnv: false,
        maxOutputBytes: DIRENV_MAX_OUTPUT_BYTES,
        timeout: DIRENV_TIMEOUT,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new DirenvEnvironmentError({
              stage: "execution",
              detail: `Could not execute ${input.commandLabel}.`,
              cause,
            }),
        ),
      );

    if (output.code !== 0) {
      const stderr = conciseStderr(output.stderr, input.environment);
      return yield* new DirenvEnvironmentError({
        stage: "execution",
        detail: stderr
          ? `${input.commandLabel} exited unsuccessfully: ${stderr}`
          : `${input.commandLabel} exited unsuccessfully.`,
      });
    }
    return output;
  });

  /** Approves only the `.envrc` at the root of a worktree T3 just created. */
  const allow: DirenvEnvironment["Service"]["allow"] = Effect.fn("DirenvEnvironment.allow")(
    function* (input) {
      const cwd = path.resolve(input.cwd);
      const envrcPath = path.join(cwd, ".envrc");
      if (!(yield* envrcExists(envrcPath))) return;
      yield* runDirenv({
        commandLabel: "direnv allow",
        args: ["allow", envrcPath],
        cwd,
        environment: input.environment,
      });
    },
  );

  const findNearestEnvrc = Effect.fn("DirenvEnvironment.findNearestEnvrc")(function* (
    cwd: string,
  ): Effect.fn.Return<string | undefined, DirenvEnvironmentError> {
    let directory = path.resolve(cwd);
    while (true) {
      const candidate = path.join(directory, ".envrc");
      if (yield* envrcExists(candidate)) return candidate;

      const parent = path.dirname(directory);
      if (parent === directory) return undefined;
      directory = parent;
    }
  });

  const resolve: DirenvEnvironment["Service"]["resolve"] = Effect.fn("DirenvEnvironment.resolve")(
    function* (input) {
      const envrcPath = yield* findNearestEnvrc(input.cwd);
      if (envrcPath === undefined) return input.environment;

      const output = yield* runDirenv({
        commandLabel: "direnv",
        args: ["export", "json"],
        cwd: input.cwd,
        environment: input.environment,
      });
      if (output === undefined) return input.environment;

      const decoded = decodeDirenvPatch(output.stdout);
      if (Result.isFailure(decoded)) {
        return yield* new DirenvEnvironmentError({
          stage: "invalid-output",
          detail: "direnv returned an invalid environment patch.",
        });
      }

      const resolvedEnvironment = { ...input.environment };
      for (const [name, value] of Object.entries(decoded.success)) {
        if (value === null) {
          delete resolvedEnvironment[name];
        } else {
          resolvedEnvironment[name] = value;
        }
      }
      return resolvedEnvironment;
    },
  );

  return DirenvEnvironment.of({ allow, resolve });
});

export const layer = Layer.effect(DirenvEnvironment, make());

export const layerLive = layer.pipe(Layer.provide(ProcessRunner.layer));

export const layerNoop = Layer.succeed(DirenvEnvironment, {
  allow: noopDirenvEnvironmentAllow,
  resolve: identityDirenvEnvironmentResolver,
});
