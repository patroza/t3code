import "vite-plus/test/config";
import { defineConfig, mergeConfig } from "vite-plus";

import baseConfig from "../../vite.config.ts";
import { loadRepoEnv } from "../../scripts/lib/public-config.ts";
import packageJson from "./package.json" with { type: "json" };

const bundledPackagePrefixes = [
  "@pierre/diffs",
  "@t3tools/",
  "effect-acp",
  "effect-codex-app-server",
];

export function shouldBundleCliDependency(id: string): boolean {
  return bundledPackagePrefixes.some((prefix) => id.startsWith(prefix));
}

const repoEnv = loadRepoEnv();
const cliBuildChannel = packageJson.version.includes("-nightly.") ? "nightly" : "latest";
const serverTestTimeout = 120_000;

export default mergeConfig(
  baseConfig,
  defineConfig({
    run: {
      tasks: {
        build: {
          command: "node scripts/cli.ts build",
          dependsOn: ["@t3tools/web#build"],
          cache: false,
        },
      },
    },
    pack: {
      entry: ["src/bin.ts"],
      outDir: "dist",
      sourcemap: true,
      // Never wipe dist/ wholesale: deploy builds the server while a live
      // process is still serving dist/client. Full clean deletes that tree and
      // desktop opens to an empty shell until (if) the client is recopied.
      // cli.ts selectively removes non-client artifacts before pack instead.
      clean: false,
      deps: {
        alwaysBundle: shouldBundleCliDependency,
        onlyBundle: false,
      },
      banner: {
        js: "#!/usr/bin/env node\n",
      },
      define: {
        __T3CODE_BUILD_CHANNEL__: JSON.stringify(cliBuildChannel),
        __T3CODE_BUILD_RELAY_URL__: JSON.stringify(repoEnv.T3CODE_RELAY_URL?.trim() ?? ""),
        __T3CODE_BUILD_CLERK_PUBLISHABLE_KEY__: JSON.stringify(
          repoEnv.T3CODE_CLERK_PUBLISHABLE_KEY?.trim() ?? "",
        ),
        __T3CODE_BUILD_CLERK_CLI_OAUTH_CLIENT_ID__: JSON.stringify(
          repoEnv.T3CODE_CLERK_CLI_OAUTH_CLIENT_ID?.trim() ?? "",
        ),
        __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_URL__: JSON.stringify(
          repoEnv.T3CODE_RELAY_CLIENT_OTLP_TRACES_URL?.trim() ?? "",
        ),
        __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_DATASET__: JSON.stringify(
          repoEnv.T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET?.trim() ?? "",
        ),
        __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_TOKEN__: JSON.stringify(
          repoEnv.T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN?.trim() ?? "",
        ),
      },
    },
    test: {
      fileParallelism: true,
      maxWorkers: 4,
      projects: [
        {
          test: {
            name: "server",
            isolate: false,
            hookTimeout: serverTestTimeout,
            testTimeout: serverTestTimeout,
            include: ["integration/**/*.test.ts", "scripts/**/*.test.ts", "src/**/*.test.ts"],
            exclude: [
              "src/bootstrap.test.ts",
              "src/terminal/NodePtyAdapter.test.ts",
              "src/workspace/WorkspaceEntries.test.ts",
            ],
          },
        },
        {
          test: {
            name: "server-isolated-module-mocks",
            isolate: true,
            hookTimeout: serverTestTimeout,
            testTimeout: serverTestTimeout,
            include: [
              "src/bootstrap.test.ts",
              "src/terminal/NodePtyAdapter.test.ts",
              "src/workspace/WorkspaceEntries.test.ts",
            ],
          },
        },
      ],
      // Server integration tests exercise sqlite, git, and orchestration together.
      // Under package-wide runs they can exceed the default budget on loaded CI hosts.
      hookTimeout: serverTestTimeout,
      testTimeout: serverTestTimeout,
    },
  }),
);
