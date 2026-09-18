import "vite-plus/test/config";
import { defineConfig, mergeConfig } from "vite-plus";

import baseConfig from "../../vite.config.ts";
import { loadRepoEnv } from "../../scripts/lib/public-config.ts";
import packageJson from "./package.json" with { type: "json" };

// The bundle used to inline only workspace packages, leaving every third-party
// runtime dep external. External deps must exist on the real filesystem (the WSL
// backend runs plain `wsl.exe -- node`, which cannot read inside an asar), so the
// desktop build unpacked `**\/node_modules\/**` wholesale: 13,875 loose files to
// support 20 native binaries. NSIS install time tracks file count, not bytes.
//
// Inverted here — bundle everything except the packages that genuinely cannot be
// inlined. See scripts/lib/cli-external-packages.ts for what earns an exemption.
import {
  isExternalCliDependency,
  shouldBundleCliDependency,
} from "../../scripts/lib/cli-external-packages.ts";

export { shouldBundleCliDependency };

const repoEnv = loadRepoEnv();
const cliBuildChannel = /^[^-+]+-(?:nightly|preview)\./.test(packageJson.version)
  ? "nightly"
  : "latest";
const serverTestTimeout = 120_000;

// `build:exe` wraps the same bundle in a Node single-executable. tsdown's exe
// step refuses multi-chunk output and counts the sourcemap as a chunk, and the
// executable needs a host Node that supports `--build-sea` (25.7+), so this is
// a separate mode rather than a second entry in the default build.
const packExecutable = process.env.T3CODE_PACK_EXE === "1";
// `<platform>-<arch>` in nodejs.org naming (darwin-x64, linux-arm64, win-x64).
// When set, tsdown injects the bundle into a downloaded Node of that target
// instead of the host Node, which is how the arm64 macOS runner produces the
// x64 archive. Cross-building is safe because the code cache is off.
//
// The Node inside the executable is pinned here rather than taken from the
// build host, so every archive of a release embeds the same runtime no matter
// which Node happens to run the build.
const SEA_NODE_VERSION = "26.8.2";
const SEA_TARGETS = {
  "darwin-arm64": { platform: "darwin", arch: "arm64" },
  "darwin-x64": { platform: "darwin", arch: "x64" },
  "linux-arm64": { platform: "linux", arch: "arm64" },
  "linux-x64": { platform: "linux", arch: "x64" },
  "win-arm64": { platform: "win", arch: "arm64" },
  "win-x64": { platform: "win", arch: "x64" },
} as const;
const packExecutableTarget = process.env.T3CODE_PACK_EXE_TARGET?.trim();
if (packExecutableTarget && !Object.hasOwn(SEA_TARGETS, packExecutableTarget)) {
  throw new Error(
    `T3CODE_PACK_EXE_TARGET must be one of ${Object.keys(SEA_TARGETS).join(", ")}, got "${packExecutableTarget}".`,
  );
}
const packExecutableTargets = packExecutableTarget
  ? [
      {
        ...SEA_TARGETS[packExecutableTarget as keyof typeof SEA_TARGETS],
        nodeVersion: SEA_NODE_VERSION,
      },
    ]
  : undefined;

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
      // The executable embeds one entry; the history worker becomes a hidden
      // subcommand there instead of a sibling script.
      entry: packExecutable ? ["src/bin.ts"] : ["src/bin.ts", "src/claude-history-worker.ts"],
      outDir: packExecutable ? "dist-exe" : "dist",
      sourcemap: !packExecutable,
      // Never wipe dist/ wholesale during the default pack: deploy builds the
      // server while a live process is still serving dist/client. The exe pack
      // writes to dist-exe and can clean. cli.ts selectively removes non-client
      // artifacts before pack instead.
      clean: packExecutable,
      ...(packExecutable
        ? {
            exe: {
              fileName: "t3",
              outDir: "dist-exe",
              ...(packExecutableTargets ? { targets: packExecutableTargets } : {}),
              // Node's SEA docs: `import()` does not work when useCodeCache is
              // true, and the server reaches several modules that way. The
              // cache is also platform-bound, so leaving it off keeps the
              // build correct on any host.
              seaConfig: { useCodeCache: false },
            },
          }
        : {}),
      deps: {
        // Both halves are required. `alwaysBundle` forces the JS dependencies in
        // (declared deps are external by default, which is what this change is
        // undoing). `neverBundle` forces the native packages out: returning
        // false from `alwaysBundle` only means "no opinion", so a transitive
        // dependency would still be bundled — which silently inlined native
        // loaders such as node-gyp-build, losing native acceleration.
        alwaysBundle: shouldBundleCliDependency,
        neverBundle: (id: string) => isExternalCliDependency(id),
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
      // Appended to the root setup, which mergeConfig concatenates.
      setupFiles: ["./src/testUtils/gitConfig.setup.ts"],
      projects: [
        {
          test: {
            name: "server",
            isolate: false,
            hookTimeout: serverTestTimeout,
            testTimeout: serverTestTimeout,
            include: ["integration/**/*.test.ts", "scripts/**/*.test.ts", "src/**/*.test.ts"],
            exclude: [
              "src/assets/AssetAccess.test.ts",
              "src/bootstrap.test.ts",
              "src/cli/app.test.ts",
              "src/provider/Layers/ClaudeCapabilitiesProbe.test.ts",
              "src/provider/Layers/GrokAdapter.test.ts",
              "src/provider/Layers/ProviderRegistry.test.ts",
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
              // Mocks `node:fs/promises`.open so a path swap during open is
              // visible. Under isolate:false the real module is already bound
              // and the descriptor is not rejected.
              "src/assets/AssetAccess.test.ts",
              "src/bootstrap.test.ts",
              // Mocks `node:os`.homedir so `t3 app` resolves ~/.t3 into the
              // fixture tree. Under isolate:false an earlier file binds the
              // real os module and the mock never applies — the CLI then
              // connects to the live Linux desktop socket.
              "src/cli/app.test.ts",
              // xAI prompt-complete can land after the assertion under
              // isolate:false CI load (`hello from ` vs `hello from mock`).
              "src/provider/Layers/GrokAdapter.test.ts",
              // Wraps ChildProcessSpawner and drives SettingsWatcherLive
              // through TestClock. Under isolate:false a sibling file in
              // the same worker can swallow the second binaryPath probe.
              "src/provider/Layers/ProviderRegistry.test.ts",
              "src/terminal/NodePtyAdapter.test.ts",
              "src/workspace/WorkspaceEntries.test.ts",
            ],
          },
        },
        {
          test: {
            name: "server-isolated-claude-probe",
            isolate: true,
            fileParallelism: false,
            maxWorkers: 1,
            hookTimeout: serverTestTimeout,
            testTimeout: serverTestTimeout,
            include: [
              // Spies `@anthropic-ai/claude-agent-sdk`.query. Under isolate:false
              // ClaudeProvider already bound the real query. Keep this file out
              // of the Grok isolated pool so its 4s live timeout does not race
              // prompt-complete assertions (`hello from ` vs `hello from mock`).
              "src/provider/Layers/ClaudeCapabilitiesProbe.test.ts",
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
