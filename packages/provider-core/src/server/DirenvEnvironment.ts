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
    readonly resolve: (input: {
      readonly cwd: string;
      readonly environment: NodeJS.ProcessEnv;
    }) => Effect.Effect<NodeJS.ProcessEnv, DirenvEnvironmentError>;
  }
>()("@t3tools/provider-core/server/DirenvEnvironment") {}

/**
 * Applies the project's direnv environment when the server provides the service. Adapters
 * built without it (tests, isolated runtimes) keep their configured environment unchanged.
 */
export const resolveCurrentProviderEnvironment = Effect.fn("resolveCurrentProviderEnvironment")(
  function* (cwd: string, environment: NodeJS.ProcessEnv) {
    const resolver = yield* Effect.serviceOption(DirenvEnvironment);
    if (Option.isNone(resolver)) return environment;
    return yield* resolver.value.resolve({ cwd, environment });
  },
);
