import * as Effect from "effect/Effect";
import * as Context from "effect/Context";

import type { VcsProcessOutput } from "./VcsProcess.ts";

const PROBE_ARGS = ["rev-parse", "--is-bare-repository", "--is-inside-work-tree"] as const;

/** Set only after a workflow explicitly permits a detected bare source. */
export const ExplicitGitDirectory = Context.Reference<{
  readonly cwd: string;
  readonly gitDir: string;
} | null>("t3/vcs/ExplicitGitDirectory", { defaultValue: () => null });

/** Explicit source selection may name a bare root, but never a folder inside one. */
export const probeGitRepository = Effect.fnUntraced(function* <E, R>(
  absoluteCwd: string,
  run: (
    args: ReadonlyArray<string>,
  ) => Effect.Effect<Pick<VcsProcessOutput, "exitCode" | "stdout" | "stderr">, E, R>,
) {
  let result = yield* run(PROBE_ARGS);
  let gitDir: string | null = null;
  if (result.exitCode !== 0 && result.stderr.includes("safe.bareRepository")) {
    // Only the named root is retried; git must not discover a bare ancestor.
    gitDir = absoluteCwd;
    result = yield* run(["--git-dir", gitDir, ...PROBE_ARGS]);
  }
  if (result.exitCode !== 0) return null;
  const [bare, insideWorkTree] = result.stdout
    .trim()
    .split("\n")
    .map((line) => line.trim());
  if (gitDir !== null && (bare !== "true" || insideWorkTree !== "false")) return null;
  return { bare: bare === "true", insideWorkTree: insideWorkTree === "true", gitDir };
});
