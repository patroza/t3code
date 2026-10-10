import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export class DirenvEnvironmentError extends Schema.TaggedError<DirenvEnvironmentError>()(
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
}): Effect.Effect<NodeJS.ProcessEnv, DirenvEnvironmentError> =>
  input.resolve === undefined
    ? Effect.succeed(input.environment)
    : input.resolve({ cwd: input.cwd, environment: input.environment });

/** Optional at adapter boundaries so isolated adapters keep their configured environment. */
export const resolveCurrentProviderEnvironment = Effect.fn("resolveCurrentProviderEnvironment")(
  function* (cwd: string, environment: NodeJS.ProcessEnv) {
    const resolver = yield* Effect.serviceOption(DirenvEnvironment);
    return Option.isSome(resolver)
      ? yield* resolver.value.resolve({ cwd, environment })
      : environment;
  },
);
