// @effect-diagnostics nodeBuiltinImport:off -- Starts the test CLI before any Effect runtime.
import * as NodeURL from "node:url";
import * as NodeChildProcess from "node:child_process";

// Opt in on Linux hosts whose interface churn aborts Chromium's localhost requests.
if (process.env.T3_TEST_NETWORK_ISOLATION === "1") {
  const result = NodeChildProcess.spawnSync(
    "unshare",
    [
      "--user",
      "--map-current-user",
      "--keep-caps",
      "--net",
      "sh",
      "-c",
      'ip link set lo up && exec "$@"',
      "t3-web-tests",
      process.execPath,
      NodeURL.fileURLToPath(import.meta.url),
      ...process.argv.slice(2),
    ],
    {
      stdio: "inherit",
      env: { ...process.env, T3_TEST_NETWORK_ISOLATION: "0" },
    },
  );
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

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
