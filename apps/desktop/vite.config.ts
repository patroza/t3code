import "vite-plus/test/config";
import { defineConfig } from "vite-plus";
import { defineProject } from "vite-plus/test/config";

import { isDesktopRuntimeExternalDependency } from "../../scripts/lib/desktop-external-packages.ts";
import { loadRepoEnv } from "../../scripts/lib/public-config.ts";

const isolatedDesktopTestFiles = [
  "src/app/DesktopClerk.test.ts",
  "src/app/DesktopPreReadyPlatform.test.ts",
  "src/backend/DesktopNetworkInterfaces.test.ts",
  "src/electron/ElectronApp.test.ts",
  "src/electron/ElectronDialog.test.ts",
  "src/electron/ElectronMenu.test.ts",
  "src/electron/ElectronProtocol.test.ts",
  "src/electron/ElectronShell.test.ts",
  "src/electron/ElectronTheme.test.ts",
  "src/electron/ElectronUpdater.test.ts",
  "src/electron/ElectronWindow.test.ts",
  "src/electron/WindowsForegroundFocusThread.test.ts",
  "src/electron/MacApplicationIcon.test.ts",
  "src/ipc/methods/notificationBadge.test.ts",
  "src/ipc/methods/preview.test.ts",
  "src/ipc/methods/window.test.ts",
  "src/permissions/MacPermissionHelper.test.ts",
  "src/permissions/MacSettingsWindow.test.ts",
  "src/preview/BrowserSession.test.ts",
  "src/preview/Manager.test.ts",
  // Window-capture tests mock electron/nativeImage/child_process. Under
  // isolate:false those mocks leak and later files see a half-applied vi.mock.
  "src/snapShot/ActiveWindow.test.ts",
  "src/snapShot/CaptureShortcutConfig.test.ts",
  "src/snapShot/DesktopSnapShot.test.ts",
  "src/snapShot/GnomeCaptureSetup.test.ts",
  "src/snapShot/HyprlandSnapShot.test.ts",
  "src/snapShot/KdeSnapShot.test.ts",
  "src/snapShot/LinuxSnapShot.dbus.test.ts",
  "src/snapShot/LinuxSnapShot.test.ts",
  "src/snapShot/MacModifierPairShortcutProcess.test.ts",
  "src/snapShot/MacSnapShot.test.ts",
  "src/snapShot/NativeCaptureFeedback.test.ts",
  "src/snapShot/NiriSnapShot.test.ts",
  "src/snapShot/PortalCaptureShortcut.dbus.test.ts",
  "src/snapShot/PortalCaptureShortcut.test.ts",
  "src/snapShot/RegionSnapShot.test.ts",
  "src/snapShot/SnapShotAccessibilityProcess.test.ts",
  "src/snapShot/WindowsCaptureFeedback.test.ts",
  "src/snapShot/captureConfigEdit.test.ts",
  "src/snapShot/snapShot.test.ts",
  "src/window/DesktopWindow.test.ts",
] as const;

const repoEnv = loadRepoEnv();

// The main process is bundled the same way the server CLI is: every JS
// dependency is inlined and only packages Node must load from disk stay
// external. The packaged app then installs just those externals, instead of a
// full production install of apps/desktop's dependency tree next to a server
// bundle that already carries its own copy of the same libraries.
const isMainProcessExternal = (id: string) =>
  id === "electron" || id.startsWith("electron/") || isDesktopRuntimeExternalDependency(id);
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
    // The Windows lane runs workspace suites concurrently; filesystem-heavy
    // desktop integration tests can exceed Vitest's 5 second default there.
    testTimeout: 15_000,
    setupFiles: ["../../packages/shared/src/testing/longTempDir.ts"],
  },
  run: {
    tasks: {
      build: {
        command:
          "node scripts/build-browser-secret.mjs && node scripts/build-preview-annotation-css.mjs && vp pack",
        dependsOn: ["t3#build"],
        cache: false,
      },
      dev: {
        command:
          "node scripts/build-browser-secret.mjs && node scripts/build-preview-annotation-css.mjs && cross-env T3CODE_DESKTOP_DEV=1 vp pack --watch",
        dependsOn: ["t3#build"],
        cache: false,
      },
      "dev:bundle": {
        command:
          "node scripts/build-browser-secret.mjs && node scripts/build-preview-annotation-css.mjs && vp pack --watch",
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
      dts: false,
      sourcemap: true,
      outExtensions: () => ({ js: ".cjs" }),
      define: publicConfigDefine,
      outputOptions: { codeSplitting: false },
      entry: ["src/main.ts"],
      clean: true,
      deps: {
        alwaysBundle: (id) => !id.startsWith("node:") && !isMainProcessExternal(id),
        neverBundle: isMainProcessExternal,
        onlyBundle: false,
      },
      ...(shouldLaunchElectronAfterPack ? { onSuccess: "node scripts/dev-electron.mjs" } : {}),
    },
    {
      format: "cjs",
      outDir: "dist-electron",
      dts: false,
      sourcemap: true,
      outExtensions: () => ({ js: ".cjs" }),
      define: publicConfigDefine,
      entry: [
        "src/electron/WindowsForegroundFocusWorker.ts",
        "src/snapShot/GlobalShiftShortcutWorker.ts",
        "src/snapShot/RegionSnapShotWorker.ts",
        "src/snapShot/SnapShotAccessibilityWorker.ts",
      ],
      clean: false,
      deps: {
        alwaysBundle: (id) => !id.startsWith("node:") && !isMainProcessExternal(id),
        neverBundle: isMainProcessExternal,
        onlyBundle: false,
      },
    },
    {
      format: "cjs",
      outDir: "dist-electron",
      dts: false,
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
      dts: false,
      sourcemap: true,
      outExtensions: () => ({ js: ".cjs" }),
      entry: ["src/preview-pick-preload.ts"],
      deps: {
        alwaysBundle: (id) => id === "react-grab" || id.startsWith("react-grab/"),
      },
    },
    {
      format: "cjs",
      outDir: "dist-electron",
      dts: false,
      sourcemap: true,
      outExtensions: () => ({ js: ".cjs" }),
      entry: ["src/preview-pip-preload.ts"],
    },
    {
      // Sandboxed preloads must be self-contained, without shared runtime chunks.
      format: "cjs",
      outDir: "dist-electron",
      dts: false,
      sourcemap: true,
      outExtensions: () => ({ js: ".cjs" }),
      entry: ["src/mac-permission-preload.ts"],
    },
  ],
});
