/** @type {import("lint-staged").Configuration} */
export default {
  // Keep format/lint in sync with vite.config.ts; the ship gate owns types/tests. Unsupported formats are a no-op.
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
