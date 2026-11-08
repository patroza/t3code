import "vite-plus/test/config";
import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    environment: "node",
    include: ["scripts/**/*.test.ts", "src/**/*.test.ts"],
    // Relay tests own and release their Effect scopes. Reusing the transformed
    // graph per worker avoids importing the Alchemy/Effect graph for every file.
    isolate: false,
    fileParallelism: true,
    maxWorkers: 4,
    hookTimeout: 60_000,
    testTimeout: 60_000,
  },
});
