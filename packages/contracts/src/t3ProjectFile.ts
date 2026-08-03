import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import { ProjectScriptIcon } from "./orchestration.ts";

/** File name of the checked-in T3 project file, resolved at the workspace root. */
export const T3_PROJECT_FILE_NAME = "t3.json";

/** Public URL of the published JSON Schema for {@link T3ProjectFile}. */
export const T3_PROJECT_FILE_SCHEMA_URL = "https://t3.codes/schema/t3.json";

const T3_PROJECT_FILE_PATH_MAX_LENGTH = 512;
const T3_PROJECT_FILE_MAX_SCRIPTS = 50;
const T3_PROJECT_FILE_MAX_DEV_STACK_CONSUMERS = 20;
const T3_PROJECT_FILE_MAX_DEV_STACK_ROLES = 10;

// Annotations go on the encoded (string) side so they survive into the
// published JSON Schema; decoding still trims and re-validates non-emptiness.
const trimmedNonEmpty = (annotations: { readonly description: string }, maxLength?: number) => {
  const annotated = Schema.String.annotate(annotations);
  const encoded =
    maxLength === undefined
      ? annotated.check(Schema.isNonEmpty())
      : annotated.check(Schema.isNonEmpty(), Schema.isMaxLength(maxLength));
  return encoded.pipe(Schema.decodeTo(encoded, SchemaTransformation.trim()));
};

export const T3ProjectFileScript = Schema.Struct({
  name: trimmedNonEmpty({
    description: "Display name for the script, shown in the T3 Code scripts menu.",
  }),
  command: trimmedNonEmpty({
    description: "Shell command executed in a T3 Code terminal at the project root.",
  }),
  icon: Schema.optionalKey(
    ProjectScriptIcon.annotate({
      description: 'Icon shown next to the script in the scripts menu. Defaults to "play".',
    }),
  ),
  runOnWorktreeCreate: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "When true, the script runs automatically after a worktree is created for a new thread.",
    }),
  ),
  runOnWorktreeRemove: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "When true, the script runs automatically before a worktree is removed. Removal waits for the script to exit; a non-zero exit blocks removal.",
    }),
  ),
  runOnPrMerged: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "When true, the script runs automatically when T3 observes the branch change request transition to merged (independent of worktree removal). Runs in the status cwd (worktree or project root).",
    }),
  ),
  previewUrl: Schema.optionalKey(
    trimmedNonEmpty({
      description:
        "URL opened in the in-app browser preview when this script runs. Only honored on the desktop build.",
    }),
  ),
  autoOpenPreview: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "When true, automatically open the preview panel at `previewUrl` the moment the script starts.",
    }),
  ),
}).annotate({
  description: "A project script that team members can import into T3 Code.",
});
export type T3ProjectFileScript = typeof T3ProjectFileScript.Type;

/**
 * Policy for long-running dev servers a repository starts outside T3's own
 * process tree (test stacks, preview servers). The live instances themselves are
 * registered under `$TMPDIR/dev-stacks` in the repo-agnostic `dev-stack/1` format;
 * this declares how T3 should treat them.
 *
 * Policy lives here rather than in each registry entry on purpose: an idle window
 * is a property of the repository, not of one running instance, and changing it
 * should apply to instances that are already up on the next sweep instead of only
 * to ones started afterwards.
 */
export const T3ProjectFileDevStacks = Schema.Struct({
  idleMinutes: Schema.optionalKey(
    Schema.Number.check(Schema.isGreaterThan(0)).annotate({
      description:
        "Minutes a registered dev stack may go without an observed consumer before T3 stops it. Defaults to 20.",
    }),
  ),
  consumers: Schema.optionalKey(
    Schema.Array(
      trimmedNonEmpty({ description: "Substring matched against process command lines." }),
    )
      .annotate({
        description:
          'Processes whose presence inside the worktree counts as the stack being in use, e.g. ["playwright", "vitest"]. Deliberately narrow: a shell sitting in the worktree is not a consumer, and treating it as one would keep every stack alive for the length of a session.',
      })
      .check(Schema.isMaxLength(T3_PROJECT_FILE_MAX_DEV_STACK_CONSUMERS)),
  ),
  entryRoles: Schema.optionalKey(
    Schema.Array(trimmedNonEmpty({ description: "A role name used in the dev-stack registry." }))
      .annotate({
        description:
          'Roles a consumer connects to, most specific first, e.g. ["frontend", "api"]. T3 watches the first role present in an instance. Ordering matters: a frontend usually holds keep-alive connections to its own API, so counting the API port would read the stack as busy for as long as the frontend is up.',
      })
      .check(Schema.isMaxLength(T3_PROJECT_FILE_MAX_DEV_STACK_ROLES)),
  ),
}).annotate({
  description: "How T3 supervises long-running dev stacks this repository registers.",
});
export type T3ProjectFileDevStacks = typeof T3ProjectFileDevStacks.Type;

export const T3ProjectFile = Schema.Struct({
  $schema: Schema.optionalKey(
    Schema.String.annotate({
      description: `URL of the JSON Schema for this file, typically "${T3_PROJECT_FILE_SCHEMA_URL}".`,
    }),
  ),
  iconPath: Schema.optionalKey(
    trimmedNonEmpty(
      {
        description:
          'Workspace-relative path to the project icon (e.g. "assets/logo.svg"). Checked before T3 Code\'s built-in icon locations.',
      },
      T3_PROJECT_FILE_PATH_MAX_LENGTH,
    ),
  ),
  scripts: Schema.optionalKey(
    Schema.Array(T3ProjectFileScript)
      .annotate({
        description: "Project scripts shared with everyone who opens this repository in T3 Code.",
      })
      .check(Schema.isMaxLength(T3_PROJECT_FILE_MAX_SCRIPTS)),
  ),
  devStacks: Schema.optionalKey(
    T3ProjectFileDevStacks.annotate({
      description:
        "Opt in to T3 supervising the dev stacks this repository registers under $TMPDIR/dev-stacks. Omit it and T3 leaves them alone.",
    }),
  ),
}).annotate({
  title: "T3 project file",
  description:
    "Checked-in project configuration for T3 Code (t3.json at the repository root). See https://t3.codes for documentation.",
});
export type T3ProjectFile = typeof T3ProjectFile.Type;
