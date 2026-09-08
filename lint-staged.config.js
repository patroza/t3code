/** @type {import("lint-staged").Configuration} */
export default {
  // Keep in sync with vite.config.ts `staged`.
  // Commit runs format + lint; the heavier typecheck + tests stay in the agent
  // ship gate (pre-push on ready PRs / `pnpm pr:ready`).
  // `--no-error-on-unmatched-pattern`: a commit whose staged files are all
  // unformattable (e.g. only *.nix) must not fail pre-commit.
  "*": "vp fmt --no-error-on-unmatched-pattern",
  // Lint (with autofix) only the code files oxlint understands.
  // `.repos/**` is in oxlint/fmt ignorePatterns; a sync merge stages thousands of
  // those files, and `vp lint` exits 1 when every path in the chunk is ignored.
  "*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}": (filenames) => {
    const lintable = filenames.filter((file) => {
      const normalized = file.replaceAll("\\", "/");
      return !normalized.startsWith(".repos/") && !normalized.includes("/.repos/");
    });
    if (lintable.length === 0) {
      return [];
    }
    return [`vp lint --fix ${lintable.map((file) => JSON.stringify(file)).join(" ")}`];
  },
};
