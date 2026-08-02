/** @type {import("lint-staged").Configuration} */
export default {
  // Keep in sync with vite.config.ts `staged`.
  // Commit runs format + lint; the heavier typecheck + tests stay in the agent
  // ship gate (pre-push on ready PRs / `pnpm pr:ready`).
  // `--no-error-on-unmatched-pattern`: a commit whose staged files are all
  // unformattable (e.g. only *.nix) must not fail pre-commit.
  "*": "vp fmt --no-error-on-unmatched-pattern",
  // Lint (with autofix) only the code files oxlint understands.
  "*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}": "vp lint --fix",
};
