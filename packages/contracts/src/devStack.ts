import * as Schema from "effect/Schema";

/** `dev-stack/1` registers repository-started dev servers outside T3's process tree for supervision.
 * Entries contain process facts only; policy belongs to repository `devStacks` in `t3.json`.
 * Repositories write entries under `$TMPDIR/dev-stacks`; T3 sweeps and reads them.
 */
export const DEV_STACK_SCHEMA_VERSION = "dev-stack/1";

/** Default registry directory name, resolved inside the OS temp directory. */
export const DEV_STACK_REGISTRY_DIR = "dev-stacks";

export const DevStackProcess = Schema.Struct({
  role: Schema.String.annotate({
    description:
      'Role within the stack, e.g. "api" or "frontend". Matched against `devStacks.entryRoles`.',
  }),
  pid: Schema.Int.check(Schema.isGreaterThan(0)).annotate({
    description: "PID of the process group leader. The stack is torn down by signalling the group.",
  }),
  port: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThan(0)).annotate({
      description: "Port the process listens on, verified by the producer's health check at start.",
    }),
  ),
  cwd: Schema.String.annotate({
    description:
      "Working directory relative to `root`. T3 confirms /proc/<pid>/cwd matches before signalling, so a recycled PID is never mistaken for the stack's own process.",
  }),
}).annotate({ description: "One process belonging to a registered dev stack." });
export type DevStackProcess = typeof DevStackProcess.Type;

export const DevStackEntry = Schema.Struct({
  schema: Schema.Literal(DEV_STACK_SCHEMA_VERSION),
  project: Schema.String,
  worktree: Schema.String.annotate({ description: "Stable hash of the worktree path." }),
  root: Schema.String.annotate({
    description: "Absolute path of the worktree that owns the stack.",
  }),
  instance: Schema.String.annotate({
    description:
      "What the repository shards stacks by: a company, a tenant, a variant. Opaque to T3; it only has to be unique within a worktree.",
  }),
  processes: Schema.Array(DevStackProcess),
}).annotate({
  title: "Dev stack registry entry",
  description: "A live dev stack registered for T3 to supervise.",
});
export type DevStackEntry = typeof DevStackEntry.Type;
