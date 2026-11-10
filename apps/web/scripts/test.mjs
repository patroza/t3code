// @effect-diagnostics nodeBuiltinImport:off -- Starts the test CLI before any Effect runtime.
import * as NodeURL from "node:url";

// Chromium can retain retired test iframes until the renderer disappears. Use Vitest's
// built-in per-file collection workaround regardless of available temporary disk space.
// https://github.com/vitest-dev/vitest/pull/10912
process.env.VITEST_CHROMIUM_GC_DISK_THRESHOLD_GB ??= "Infinity";

const cli = new URL("../bin/vp", import.meta.resolve("vite-plus"));
process.argv = [
  process.execPath,
  NodeURL.fileURLToPath(cli),
  "test",
  "run",
  ...process.argv.slice(2),
];
await import(cli.href);
