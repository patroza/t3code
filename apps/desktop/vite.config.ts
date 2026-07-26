import { defineConfig } from "vite-plus";
import { defineProject } from "vite-plus/test/config";

import { loadRepoEnv } from "../../scripts/lib/public-config.ts";

const isolatedDesktopTestFiles = [
  "src/app/DesktopClerk.test.ts",
  "src/backend/DesktopNetworkInterfaces.test.ts",
  "src/electron/ElectronApp.test.ts",
  "src/electron/ElectronDialog.test.ts",
  "src/electron/ElectronMenu.test.ts",
  "src/electron/ElectronProtocol.test.ts",
  "src/electron/ElectronShell.test.ts",
  "src/electron/ElectronTheme.test.ts",
  "src/electron/ElectronUpdater.test.ts",
  "src/electron/ElectronWindow.test.ts",
  "src/electron/MacApplicationIcon.test.ts",
  "src/ipc/methods/preview.test.ts",
  "src/preview/BrowserSession.test.ts",
  "src/preview/Manager.test.ts",
  "src/window/DesktopWindow.test.ts",
] as const;

const repoEnv = loadRepoEnv();
const shouldLaunchElectronAfterPack = process.env.T3CODE_DESKTOP_DEV === "1";
const publicConfigDefine = {
  __T3CODE_BUILD_CLERK_PUBLISHABLE_KEY__: JSON.stringify(
    repoEnv.T3CODE_CLERK_PUBLISHABLE_KEY?.trim() ?? "",
  ),
};

export default defineConfig({
  test: {
    projects: [
      defineProject({
        test: {
          name: "desktop",
          environment: "node",
          include: ["src/**/*.test.ts"],
          exclude: [...isolatedDesktopTestFiles],
          isolate: false,
          fileParallelism: true,
          maxWorkers: 4,
          hookTimeout: 60_000,
          testTimeout: 60_000,
        },
      }),
      defineProject({
        test: {
          name: "desktop-isolated-module-mocks",
          environment: "node",
          include: [...isolatedDesktopTestFiles],
          isolate: true,
          fileParallelism: true,
          maxWorkers: 1,
          hookTimeout: 60_000,
          testTimeout: 60_000,
        },
      }),
    ],
  },
  run: {
    tasks: {
      build: {
        command: "node scripts/build-preview-annotation-css.mjs && vp pack",
        dependsOn: ["t3#build"],
        cache: false,
      },
      dev: {
        command:
          "node scripts/build-preview-annotation-css.mjs && cross-env T3CODE_DESKTOP_DEV=1 vp pack --watch",
        dependsOn: ["t3#build"],
        cache: false,
      },
      "dev:bundle": {
        command: "node scripts/build-preview-annotation-css.mjs && vp pack --watch",
        cache: false,
      },
      "dev:electron": {
        command: "node scripts/dev-electron.mjs",
        dependsOn: ["t3#build"],
        cache: false,
      },
    },
  },
  pack: [
    {
      format: "cjs",
      outDir: "dist-electron",
      sourcemap: true,
      outExtensions: () => ({ js: ".cjs" }),
      define: publicConfigDefine,
      entry: ["src/main.ts"],
      clean: true,
      deps: {
        alwaysBundle: (id) => id.startsWith("@t3tools/"),
      },
      ...(shouldLaunchElectronAfterPack ? { onSuccess: "node scripts/dev-electron.mjs" } : {}),
    },
    {
      format: "cjs",
      outDir: "dist-electron",
      sourcemap: true,
      outExtensions: () => ({ js: ".cjs" }),
      define: publicConfigDefine,
      entry: ["src/preload.ts"],
      deps: {
        // Sandboxed Electron preloads cannot reliably resolve package imports
        // from inside the packaged ASAR. Bundle Clerk's preload bridge into the
        // preload artifact instead of leaving a runtime require() behind.
        alwaysBundle: (id) => id === "@clerk/electron" || id.startsWith("@clerk/electron/"),
      },
    },
    {
      format: "cjs",
      outDir: "dist-electron",
      sourcemap: true,
      outExtensions: () => ({ js: ".cjs" }),
      entry: ["src/preview-pick-preload.ts"],
      deps: {
        alwaysBundle: (id) => id === "react-grab" || id.startsWith("react-grab/"),
      },
    },
  ],
});
