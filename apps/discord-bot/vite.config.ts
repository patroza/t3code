import "vite-plus/test/config";
import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // The bot suite does not use module mocks and releases its Effect scopes,
    // so workers can safely reuse the transformed graph between test files.
    isolate: false,
    fileParallelism: true,
    maxWorkers: 4,
    hookTimeout: 60_000,
    testTimeout: 60_000,
  },
});
