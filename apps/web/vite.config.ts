// @effect-diagnostics-next-line nodeBuiltinImport:off -- Vite config runs before any Effect runtime.
import * as NodeFSP from "node:fs/promises";
import * as NodeZlib from "node:zlib";

import react from "@vitejs/plugin-react";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import compression from "compression";
import { playwright } from "vite-plus/test/browser-playwright";
import { defineProject, type TestProjectInlineConfiguration } from "vite-plus/test/config";
import "vite-plus/test/config";
import { defineConfig, type Connect, type Plugin } from "vite-plus";
import * as Hash from "effect/Hash";
import pkg from "./package.json" with { type: "json" };
import pdfjsPkg from "pdfjs-dist/package.json" with { type: "json" };

import {
  DEV_PROXIED_ORIGIN_PRESERVING_PREFIXES,
  DEV_PROXIED_PATH_PREFIXES,
} from "@t3tools/shared/devProxy";

import { loadRepoEnv } from "../../scripts/lib/public-config";
import { thirdPartyLicensesPlugin } from "../../scripts/lib/third-party-licenses";
import { tailwindPlugins } from "./vite/tailwind";
import { warmBundledDevPlugin } from "./vite/warmBundledDev";

const repoEnv = loadRepoEnv();
Object.assign(process.env, repoEnv);

// Signal single-origin dev explicitly; loadRepoEnv can restore deleted URL keys from .env.
const isSingleOriginDev = process.env.T3CODE_SINGLE_ORIGIN_DEV === "1";

const port = Number(process.env.PORT ?? 5733);
const explicitHost = process.env.HOST?.trim();
const host = explicitHost || "localhost";
const configuredWsUrl = isSingleOriginDev ? undefined : process.env.VITE_WS_URL?.trim();
const configuredHttpUrl = isSingleOriginDev ? undefined : process.env.VITE_HTTP_URL?.trim();
const configuredRelayUrl = repoEnv.VITE_T3CODE_RELAY_URL?.trim() || "";
const configuredClerkPublishableKey = repoEnv.VITE_CLERK_PUBLISHABLE_KEY?.trim() || "";
const configuredClerkJwtTemplate = repoEnv.VITE_CLERK_JWT_TEMPLATE?.trim() || "";
const configuredClerkCliOAuthClientId = repoEnv.VITE_CLERK_CLI_OAUTH_CLIENT_ID?.trim() || "";
const configuredRelayTracingUrl = repoEnv.VITE_RELAY_OTLP_TRACES_URL?.trim() || "";
const configuredRelayTracingDataset = repoEnv.VITE_RELAY_OTLP_TRACES_DATASET?.trim() || "";
const configuredRelayTracingToken = repoEnv.VITE_RELAY_OTLP_TRACES_TOKEN?.trim() || "";
const configuredHostedAppChannel = process.env.VITE_HOSTED_APP_CHANNEL?.trim() || "";
const configuredReleaseChannel =
  process.env.T3CODE_BUILT_DEV === "1" ? "dev" : process.env.VITE_RELEASE_CHANNEL?.trim() || "";
const configuredAppVersion = process.env.APP_VERSION?.trim() || pkg.version;
const configuredDesktopUpdateRepository =
  process.env.T3CODE_DESKTOP_UPDATE_REPOSITORY?.trim() ||
  process.env.GITHUB_REPOSITORY?.trim() ||
  "";
const configuredFeatureSecrets = process.env.T3CODE_FEATURE_SECRETS?.trim() || "";
const configuredHostedAppUrl = (() => {
  const explicitHostedAppUrl = process.env.VITE_HOSTED_APP_URL?.trim();
  if (explicitHostedAppUrl) {
    return explicitHostedAppUrl;
  }
  if (process.env.VERCEL_ENV === "production" && process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  }
  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}`;
  }
  return undefined;
})();
const sourcemapEnv = process.env.T3CODE_WEB_SOURCEMAP?.trim().toLowerCase();

// `vp run dev --share --built` rebuilds on every change. The license manifest
// is about 2 s of each build, and nothing in that mode reads it.
const builtDev = process.env.T3CODE_BUILT_DEV === "1";

const bundledDevEnv = process.env.T3CODE_BUNDLED_DEV?.trim().toLowerCase();
const bundledDev = bundledDevEnv === "1" || bundledDevEnv === "true";

const buildSourcemap: boolean | "hidden" =
  sourcemapEnv === "0" || sourcemapEnv === "false"
    ? false
    : sourcemapEnv === "hidden"
      ? "hidden"
      : true;

const isolatedUnitTestFiles = [
  // The published-theme harness must bind its server atom before the palette module loads.
  "src/hooks/useEnvironmentTheme.test.ts",
  // The terminal attach harness replaces modules also imported by terminal/status components.
  "src/state/terminalSessions.test.ts",
  // Retained action toasts use scoped server and runtime mocks.
  "src/components/GitActionsControl.lifecycle.test.ts",
  // Hook mocks must bind before imports, without a preceding file’s cached theme hook.
  "src/hooks/useHtmlRenderTheme.test.ts",
  // Partial server mocks must not replace capability atoms used by browser restoration.
  "src/hooks/useSettings.favorites.test.tsx",
  "src/components/chat/ThreadAutomationsPanel.permissions.test.tsx",
  "src/components/onboarding/WelcomeWizard.test.tsx",
  "src/components/settings/TelemetryExportSettings.test.tsx",
  // Direct hook harnesses replace React hooks and compiler caches, requiring fresh module binding.
  "src/hooks/useThreadActions.undo.test.ts",
  // The undo notice and its announcement de-duplication are module-level state; this harness
  // must start with fresh lifecycle state rather than inheriting another test file's notice.
  "src/hooks/showThreadUndoNotice.test.ts",
  "src/components/settings/ProjectFaviconPickerDialog.test.tsx",
  "src/components/settings/ThemeEditorHost.test.tsx",
  "src/components/settings/AcpSessionManagementSection.test.tsx",
  "src/components/settings/AcpRegistrySearchStep.test.tsx",
  "src/components/settings/SettingsPanels.restore.test.tsx",
  "src/components/settings/ProviderSetupSection.test.tsx",

  // Its direct component hook harness mocks React; real React from siblings must not bind first.
  "src/components/settings/AcpRegistryIcon.test.ts",
  // These exercise the real live-refresh hook; sibling presentation tests mock it.
  "src/hooks/usePullRequestChecksRefresh.test.ts",
  "src/authBootstrap.test.ts",
  // Mocks `~/state/session`; same isolate:false hazard as the favicon test —
  // it failed in one full run and passed in the next, purely on file ordering.
  "src/browserHistoryStore.test.ts",
  "src/browser/browserRecording.test.ts",
  // Mocks `~/hooks/useSettings`; under isolate:false an earlier file binds
  // the real store and getBrowserDefaults never sees the test profile list.
  "src/browser/browserDefaults.test.ts",
  // Mocks `~/hooks/useSettings`; under isolate:false the real hydrate path
  // already bound ensureLocalApi, so failed-read tests throw "Local API not found".
  "src/browser/browserLinkTarget.test.ts",
  // Mocks `~/localApi` persistence; same isolate:false binding as useSettings.
  "src/browser/HostedBrowserWebview.test.tsx",
  "src/browser/browserTargetResolver.test.ts",
  "src/browser/desktopTabLifetime.test.ts",
  // Runtime selection mocks capabilities and desktop availability; shared workers
  // can retain the real modules loaded by another preview test.
  "src/browser/previewRuntime.test.ts",
  "src/branding.test.ts",
  "src/clientPersistenceStorage.test.ts",
  "src/cloud/dpop.test.ts",
  "src/cloud/linkEnvironment.test.ts",
  "src/cloud/managedAuth.test.ts",
  "src/components/ComposerPromptEditor.test.ts",
  "src/components/ProjectFavicon.test.tsx",
  "src/components/ProviderUpdateEnvironmentRows.test.tsx",
  "src/components/ServerUpdateAction.test.tsx",
  // Mocks `~/lib/assistantTextSelection` and `../ui/toast`; under
  // isolate:false those modules are already bound and citation Range/CSS
  // highlight fixtures never attach.
  "src/components/chat/AssistantCitationSource.test.ts",
  // Mocks `@tanstack/react-router`; under isolate:false a sibling already
  // bound the real Link, which throws reading `isServer` without a router
  // (Fork CI on ce3ef6b4 failed all four source-disappearance tests).
  "src/components/chat/AssistantCitationChip.test.tsx",
  "src/components/chat/MessagesTimeline.test.tsx",
  // Mocks `../assets/assetUrls` while ChatMarkdown is already bound to the
  // real module under isolate:false — useAssetUrlState then sees
  // useAtomValue() === null and throws on `_tag`.
  "src/components/ChatMarkdown.workspace-images.test.tsx",
  "src/components/chat/draftHeroTransition.test.ts",
  // Mounts react-dom createRoot against a stub document; under isolate:false
  // an earlier file can bind a real document/ReactDOM so hide/unhide never
  // closes the popup.
  "src/components/chat/useComposerMenuState.test.tsx",
  // ComposerBanner uses buttonVariants. Under isolate:false a sibling's
  // stub `../ui/button` mock (Button only) binds first and these tests die
  // with "No buttonVariants export is defined on the mock".
  "src/components/chat/ComposerBannerStack.test.tsx",
  "src/components/chat/ComposerPendingUserInputPanel.test.tsx",
  "src/components/chat/ComposerStashMenu.test.tsx",
  "src/components/files/projectFilesQueryState.test.ts",
  // Same react-hook mock as the .ts sibling; the .tsx refresh tests were added
  // upstream and fail under isolate:false when real React is already bound.
  "src/components/files/projectFilesQueryState.test.tsx",
  // Mocks `~/browserFaviconStore`; under `isolate: false` an earlier file in
  // the same worker can bind the real module first, and the mock then never
  // applies — the icon falls back to the browser mockup and the stored-favicon
  // assertion fails, depending only on how files land across workers.
  "src/components/preview/PreviewFaviconIcon.test.tsx",
  "src/components/preview/PreviewView.test.tsx",
  "src/components/preview/openPreviewSession.test.ts",
  "src/components/preview/openTerminalLinkInPreview.test.ts",
  // Replaces `openPreviewSession` with a bare vi.fn(). Under isolate:false
  // that mock leaks into reopenClosedView.test.ts, so the session result is
  // undefined and reading `_tag` throws.
  "src/components/ReopenClosedViewShortcut.test.tsx",
  // React hook-harness mocks need isolated registries; shared workers can retain the real compiler runtime.
  "src/components/diffs/StyledDiffCodeView.test.tsx",
  "src/components/settings/AddProviderInstanceDialog.environment.test.tsx",
  // Replaces `window` with a capture-bridge stub and fakes rAF/localStorage;
  // under isolate:false that window leak makes later files miss animation
  // frames or fail composer persist verification, depending on worker order.
  "src/components/desktop/SnapShotCoordinator.test.ts",
  // Mocks `~/lib/desktopSnapShot` and drives keyboard recording against a
  // stub window; under isolate:false an earlier file can bind the real
  // capture bridge so suppression never arms.
  "src/components/settings/useSnapShotShortcutRecorder.test.tsx",
  // Mounts CaptureShortcutConfig through react-test-renderer; under
  // isolate:false useTheme's useSyncExternalStore hits a second React copy.
  "src/components/settings/CaptureShortcutConfig.test.tsx",
  // Mocks `../../hooks/useSettings` without usePrimarySettingsAvailable;
  // under isolate:false that incomplete mock leaks into SettingsRow and
  // ProviderInstanceCard.test.ts throws on the missing export.
  "src/components/settings/SnapShotSettings.test.tsx",
  // Mocks `~/hooks/useSettings` with only useEnvironmentIdentificationMode;
  // same isolate:false SettingsRow leak as SnapShotSettings.test.tsx.
  "src/components/chat/ComposerPrimaryActions.test.tsx",
  // Mocks `../../hooks/useSettings` and `../../state/environments`; under
  // isolate:false an earlier file binds the real hooks so useEnvironments
  // sees a null presentations map and throws on `.entries()`.
  "src/components/settings/IntegrationsSettings.test.tsx",
  // Mocks `../ui/button` as a host-element string; under isolate:false that
  // stub leaks into later files (ComposerControl then renders variant as a
  // DOM attribute and drops size classes).
  "src/components/settings/ProjectIconPickerDialog.test.tsx",
  // Mocks `../ui/input`. Under isolate:false the real Base UI input binds
  // first, FieldControl reads a missing currentTarget, and Fork CI fails
  // on file order.
  "src/components/settings/SecretInput.test.tsx",
  "src/components/settings/ProviderSettingsPanel.environment.test.tsx",
  // Mocks `../ui/toast`; under isolate:false an earlier file binds the real
  // toast manager and the release-link error toast is never recorded.
  "src/components/sidebar/SidebarUpdateReleaseNotes.test.tsx",
  // Mocks `react` useState and `../ui/button` as "button"; same isolate:false
  // Button leak as ProjectIconPickerDialog.test.tsx.
  "src/components/usage/UsagePage.test.tsx",
  // Partial `../../state/server` mock (`serverEnvironment` only). Isolate so
  // it cannot replace the server module used by other test files.
  "src/components/usage/UsagePage.refresh.test.tsx",
  "src/connection/storage.test.ts",
  "src/contextMenuFallback.test.ts",
  "src/environments/primary/bootstrap.test.ts",
  "src/environments/primary/httpLayer.test.ts",
  "src/hooks/useCopyToClipboard.test.ts",
  // Mocks `react` (useCallback/useMemo) and `@effect/atom-react`; under
  // isolate:false an earlier file binds real React and useContext is null.
  "src/hooks/useHandleNewThread.test.ts",
  // Mocks `@effect/atom-react` so settled thread search returns the fixture.
  // Under isolate:false an earlier file binds the real hook and the atom
  // reports no matches.
  "src/state/queries.threadSearch.test.tsx",
  // Mocks `~/localApi` persistence; under isolate:false the real ensureLocalApi
  // is already bound and hydration throws "Local API not found".
  "src/hooks/useSettings.test.ts",
  "src/hooks/useLocalStorage.test.ts",
  "src/hooks/useTheme.test.ts",
  // Mocks `react` (useSyncExternalStore) like useTheme.test.ts; under
  // isolate:false an earlier file binds real React and the mock never applies.
  "src/hooks/useEnvironmentThemeSync.test.ts",
  "src/lib/elementContext.test.ts",
  // Mocks `@t3tools/client-runtime/state/runtime` without spreading the real
  // module; under isolate:false that incomplete mock leaks into later files
  // that import asset URL atoms (PullRequestListFilters.test.tsx).
  "src/lib/attachmentUploadQueue.test.ts",
  "src/localApi.test.ts",
  // Mocks `~/localApi`; under isolate:false terminalCloseConfirm is already
  // bound to the real module so confirm() is never the mock and pending stays false.
  "src/lib/terminalCloseConfirm.test.ts",
  "src/providerUpdateDismissal.test.ts",
  // Mocks `@pierre/diffs` getSharedHighlighter; under isolate:false ChatMarkdown
  // already binds the real highlighter so the recovered-text cache test sees
  // a live object instead of the stub.
  "src/lib/syntaxHighlighting.test.ts",
  // Real Pierre worker + 7k-line tokenizer. The 60-edit stale-highlight case
  // timed out at 15s under isolate:false CI load.
  "src/components/files/AttachmentFilePreview.test.tsx",
  "src/components/permissions/usePermissionStatus.test.ts",
  // react-test-renderer + Base UI Popover/Tooltip. Under isolate:false a
  // sibling can bind the real floating-ui modules first, so the mocks never
  // apply and CI dies with `Element is not defined` / `window is not defined`.
  "src/components/pullRequest/PullRequestDetailPanel.test.tsx",
  "src/components/pullRequest/PullRequestSummaryTab.test.tsx",
  "src/components/ThreadNotificationCoordinator.test.tsx",
  // Uses the real atom registry; shared-worker mocks omit RegistryContext.
  "src/components/ThreadStatusIndicators.subscriptions.test.tsx",
  // Queue presentation mocks must not replace stores used by draft recovery tests.
  "src/components/chat/QueuedRunsControl.test.tsx",
  // Mocks `./vendor/ghostty-vt.wasm?url`; under isolate:false runtime.ts is
  // already bound to the real asset URL and fetch('/src/...wasm') is invalid.
  "src/terminal/ghostty/core.test.ts",
  "src/uiStateStore.test.ts",
  "src/versionSkew.test.ts",
  // Mock react, the session store, or the router. Under isolate:false an
  // earlier file binds the real modules and these vi.mock calls never apply.
  "src/components/KeybindingsConfigWarning.test.tsx",
  "src/components/onboarding/WelcomeWizard.terminal.test.tsx",
  "src/components/preview/addBrowserSurface.test.ts",
  "src/components/settings/ProjectSettingsPanel.test.tsx",
  "src/hooks/useSettings.sync.test.tsx",
  "src/hooks/useThreadActionMenu.test.ts",
  "src/hooks/useThreadActions.permissions.test.ts",
  "src/state/sourceControlActions.test.ts",
  "src/state/terminalSessionAvailability.test.ts",
  // These mock react, settings scope, or a button stub. Left in the shared
  // worker, the mock binds first and a later file calls the real hook.
  "src/assets/assetUrls.test.ts",
  "src/editorPreferences.test.ts",
  "src/state/queries.filesystem.test.ts",
  "src/state/use-orchestration-command.test.ts",
  "src/components/GitActionsControl.test.ts",
  "src/components/PullRequestThreadDialog.test.ts",
  "src/components/media/MediaActions.test.tsx",
  "src/components/cloud/CloudEnvironmentConnectList.test.tsx",
  "src/components/ChatMarkdown.test.tsx",
  "src/components/ChatMarkdown.assets.test.tsx",
  "src/components/ChatMarkdown.permissions.test.tsx",
  "src/components/ThreadNotificationCoordinator.badge.test.tsx",
  "src/components/ThreadTerminalDrawer.permissions.test.tsx",
  "src/components/onboarding/WelcomeWizard.import.test.tsx",
  "src/components/pullRequest/PullRequestMarkdownEditor.test.tsx",
  "src/components/settings/KeybindingsSettings.environment.test.tsx",
  "src/components/settings/SourceControlWritingSettings.test.tsx",
  "src/components/settings/settingsLayout.test.tsx",
] as const;

const compilerTestFiles = ["src/components/ChatView.compiler.test.ts"] as const;

const unitTestProject = {
  extends: true,
  test: {
    name: "unit",
    // Reuse each worker's transformed module graph across test files. The suite
    // resets its stores explicitly; process isolation was spending most of CI
    // time re-importing the same React/Effect graph for every file.
    isolate: false,
    fileParallelism: true,
    maxWorkers: 4,
    sequence: { groupOrder: 1 },
    include: ["src/**/*.test.{ts,tsx}"],
    exclude: [...isolatedUnitTestFiles, ...compilerTestFiles, "src/**/*.browser.test.{ts,tsx}"],
    hookTimeout: 15_000,
    testTimeout: 15_000,
    setupFiles: [
      "../../packages/shared/src/testing/longTempDir.ts",
      "../../packages/shared/src/testing/providerEnv.ts",
    ],
  },
} satisfies TestProjectInlineConfiguration;

const isolatedUnitTestProject = {
  extends: true,
  test: {
    name: "unit-isolated",
    isolate: true,
    fileParallelism: true,
    maxWorkers: 4,
    sequence: { groupOrder: 1 },
    include: [...isolatedUnitTestFiles],
    hookTimeout: 15_000,
    testTimeout: 15_000,
  },
} satisfies TestProjectInlineConfiguration;

// Hash checkout paths to ports 61000-64999; the fixed browser port collides under strictPort.
const browserTestApiPort = 61_000 + ((Hash.string(import.meta.dirname) >>> 0) % 4_000);

const browserTestProject = {
  extends: true,
  // Lazy views and mocked imports hide these from the initial dependency scan.
  // Discovering them while a browser test runs reloads its page and closes its mock RPCs.
  optimizeDeps: {
    include: [
      "vite-plus/test/browser",
      "react/compiler-runtime",
      "@base-ui/react/toolbar",
      "@pierre/diffs/ssr",
      "effect/reactivity/Atom",
      "@tiptap/core",
      "@tiptap/extension-blockquote",
      "@tiptap/extension-code-block",
      "@tiptap/extension-code",
      "@tiptap/extension-heading",
      "@tiptap/extension-horizontal-rule",
      "@tiptap/extension-italic",
      "@tiptap/extension-list",
      "@tiptap/extension-task-item",
      "@tiptap/extension-task-list",
      "@tiptap/pm/commands",
      "@tiptap/pm/history",
      "@tiptap/pm/model",
      "@tiptap/pm/state",
      "@tiptap/pm/transform",
      "@tiptap/pm/view",
      "@tiptap/react",
      "@tiptap/starter-kit",
      "@base-ui/react/autocomplete",
      "@base-ui/react/field",
      "@base-ui/react/preview-card",
      "@formkit/auto-animate",
      "@pierre/diffs/worker",
      "@pierre/trees/react",
      "dompurify",
      "hast-util-to-html",
      "hast-util-to-jsx-runtime",
      "katex",
      "pele/lazy",
      "react-markdown",
      "saxes",
      "@betteroffice/docx/editor",
      "@betteroffice/docx/layout",
      "@betteroffice/docx/layout/render",
      "@betteroffice/docx/yrs",
      "@betteroffice/fonts",
      "@betteroffice/pptx",
      "@betteroffice/xlsx",
      "@betteroffice/xlsx/headless",
      "fast-xml-parser",
      "entities",
      "heic-to/next",
      "jszip",
      "pdfjs-dist",
      "sql.js",
      "tiff",
    ],
  },
  test: {
    name: "browser",
    maxWorkers: 4,
    sequence: { groupOrder: 2 },
    include: ["src/**/*.browser.test.{ts,tsx}"],
    hookTimeout: 15_000,
    testTimeout: 15_000,
    setupFiles: ["./test/browserSetup.ts"],
    api: { port: browserTestApiPort, strictPort: false },
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: "chromium" }],
      screenshotFailures: false,
      commands: {
        // Playwright's mouse outlives each test, so whatever mounts under its last
        // position starts hovered. test/browserSetup.ts parks it off the page before each test.
        resetPointer: async ({ page }) => {
          await page.mouse.move(-1, -1);
        },
      },
    },
  },
} satisfies TestProjectInlineConfiguration;

// Compile the full ChatView body after other web tests release their workers.
const compilerTestProject = {
  extends: true,
  test: {
    name: "compiler",
    // Compiling the full ChatView body is CPU work; use this project ceiling for compiler tests.
    testTimeout: 30_000,
    sequence: { groupOrder: 3 },
    include: [...compilerTestFiles],
  },
} satisfies TestProjectInlineConfiguration;

// Render scenarios count React commits; they run only through scripts/render-metrics.ts,
// which reads the per-scenario reports this command writes.
const renderScenariosProject = {
  ...browserTestProject,
  test: {
    ...browserTestProject.test,
    name: "renders",
    include: ["test/*.renders.tsx"],
    // App scenarios mount the whole app per test, which outlasts 15s on a loaded machine.
    hookTimeout: 60_000,
    testTimeout: 60_000,
    setupFiles: ["./test/renderCounter.ts", ...browserTestProject.test.setupFiles],
    browser: {
      ...browserTestProject.test.browser,
      // Vitest names each instance in place, so a shared array would clash with the browser project.
      instances: [{ browser: "chromium" }],
      commands: {
        ...browserTestProject.test.browser.commands,
        writeRenderReport: async (_context, scenario: string, json: string) => {
          const directory = process.env.T3CODE_RENDER_REPORT_DIR;
          if (!directory) throw new Error("T3CODE_RENDER_REPORT_DIR is not set");
          await NodeFSP.writeFile(`${directory}/${scenario}.json`, json);
        },
      },
    },
  },
} satisfies TestProjectInlineConfiguration;

function resolveDevProxyTarget(
  backendPort: string | undefined,
  wsUrl: string | undefined,
): string | undefined {
  const port = Number(backendPort?.trim());
  if (Number.isInteger(port) && port > 0) {
    return `http://localhost:${port}/`;
  }

  // dev:desktop connects directly to the backend; derive its target from the explicit WebSocket URL.
  if (!wsUrl) {
    return undefined;
  }

  try {
    const url = new URL(wsUrl);
    if (url.protocol === "ws:") {
      url.protocol = "http:";
    } else if (url.protocol === "wss:") {
      url.protocol = "https:";
    }
    url.pathname = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

const devProxyTarget = resolveDevProxyTarget(process.env.T3CODE_PORT, configuredWsUrl);

// Brotli quality 5 encodes in hundreds of ms; default quality 11 would replace transfer stalls with encode stalls.
function devCompressionPlugin(): Plugin {
  return {
    name: "t3code:dev-compression",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(
        compression({
          brotli: { params: { [NodeZlib.constants.BROTLI_PARAM_QUALITY]: 5 } },
        }) as unknown as Connect.NextHandleFunction,
      );
    },
  };
}

// A static import cycle between chunks can run a chunk before the values it imports exist,
// which blanks the app at boot. Fail the build instead of shipping it.
function chunkCycleGuardPlugin(): Plugin {
  return {
    name: "t3code:chunk-cycle-guard",
    apply: "build",
    generateBundle(_options, bundle) {
      const done = new Set<string>();
      const visit = (fileName: string, path: string[]) => {
        if (done.has(fileName)) return;
        const start = path.indexOf(fileName);
        if (start !== -1) {
          this.error(`Chunk import cycle: ${[...path.slice(start), fileName].join(" -> ")}`);
        }
        const chunk = bundle[fileName];
        if (chunk?.type !== "chunk") return;
        for (const imported of chunk.imports) visit(imported, [...path, fileName]);
        done.add(fileName);
      };
      for (const fileName of Object.keys(bundle)) visit(fileName, []);
    },
  };
}

// Allow Tailnet hosts for sharing; Tailscale-controlled DNS prevents attacker rebinding.
const configuredAllowedHosts = (process.env.T3CODE_DEV_ALLOWED_HOSTS ?? "")
  .split(",")
  .map((entry) => entry.trim())
  .filter((entry) => entry.length > 0);
const allowedHosts = [".ts.net", ...configuredAllowedHosts];

export default defineConfig(() => {
  return {
    run: {
      tasks: {
        // tsc (tsc-rs) rewrites the tsbuildinfo it reads, which keeps a task out of the cache.
        typecheck: {
          command: "tsc --noEmit",
          cache: { input: [{ auto: true }, "!*.tsbuildinfo"] },
        },
      },
    },
    assetsInclude: ["**/*.wasm"],
    plugins: [
      devCompressionPlugin(),
      chunkCycleGuardPlugin(),
      builtDev
        ? undefined
        : thirdPartyLicensesPlugin({
            bundleName: "web",
            configFile: new URL("../../third-party-licenses.config.json", import.meta.url),
            packageManifests: [
              { bundle: "web", path: new URL("./package.json", import.meta.url) },
              { bundle: "server", path: new URL("../server/package.json", import.meta.url) },
              { bundle: "desktop", path: new URL("../desktop/package.json", import.meta.url) },
            ],
          }),
      tanstackRouter({ autoCodeSplitting: true }),
      react({ compiler: true }),
      tailwindPlugins(bundledDev),
      warmBundledDevPlugin(),
    ],
    optimizeDeps: {
      include: [
        "@clerk/clerk-js",
        "@clerk/react/internal",
        "@pierre/diffs",
        "@pierre/diffs/edit",
        "@pierre/diffs/react",
        "@pierre/diffs/worker/worker.js",
        "effect/Array",
        "effect/Order",
        "react-dom/client",
      ],
    },
    define: {
      "import.meta.env.VITE_WS_URL": JSON.stringify(configuredWsUrl ?? ""),
      // Override .env URLs with empty values in single-origin dev so clients use window.location.origin.
      "import.meta.env.VITE_HTTP_URL": JSON.stringify(configuredHttpUrl ?? ""),
      "import.meta.env.VITE_T3CODE_RELAY_URL": JSON.stringify(configuredRelayUrl),
      "import.meta.env.VITE_CLERK_PUBLISHABLE_KEY": JSON.stringify(configuredClerkPublishableKey),
      "import.meta.env.VITE_CLERK_JWT_TEMPLATE": JSON.stringify(configuredClerkJwtTemplate),
      "import.meta.env.VITE_CLERK_CLI_OAUTH_CLIENT_ID": JSON.stringify(
        configuredClerkCliOAuthClientId,
      ),
      "import.meta.env.VITE_RELAY_OTLP_TRACES_URL": JSON.stringify(configuredRelayTracingUrl),
      "import.meta.env.VITE_RELAY_OTLP_TRACES_DATASET": JSON.stringify(
        configuredRelayTracingDataset,
      ),
      "import.meta.env.VITE_RELAY_OTLP_TRACES_TOKEN": JSON.stringify(configuredRelayTracingToken),
      "import.meta.env.VITE_HOSTED_APP_URL": JSON.stringify(configuredHostedAppUrl ?? ""),
      "import.meta.env.VITE_HOSTED_APP_CHANNEL": JSON.stringify(configuredHostedAppChannel),
      "import.meta.env.T3CODE_DESKTOP_UPDATE_REPOSITORY": JSON.stringify(
        configuredDesktopUpdateRepository,
      ),
      "import.meta.env.T3CODE_FEATURE_SECRETS": JSON.stringify(configuredFeatureSecrets),
      "import.meta.env.VITE_RELEASE_CHANNEL": JSON.stringify(configuredReleaseChannel),
      "import.meta.env.APP_VERSION": JSON.stringify(configuredAppVersion),
    },
    resolve: {
      tsconfigPaths: true,
      alias: {
        "@betteroffice/fonts-cjk": new URL(
          "./src/components/files/office/fonts-cjk.ts",
          import.meta.url,
        ).pathname,
      },
      dedupe: ["react", "react-dom"],
    },
    experimental: {
      bundledDev,
    },
    server: {
      host,
      port,
      strictPort: true,
      allowedHosts,
      // Warm the module graph before first request to avoid serial import transforms over tailnet.
      // Bundled dev ignores this; warmBundledDevPlugin handles it there.
      warmup: {
        clientFiles: ["./src/main.tsx"],
      },
      ...(devProxyTarget
        ? {
            // Share prefixes with the backend catch-all so the proxy and 404 lists cannot drift.
            proxy: Object.fromEntries(
              DEV_PROXIED_PATH_PREFIXES.map((prefix) => [
                prefix,
                {
                  target: devProxyTarget,
                  changeOrigin: !DEV_PROXIED_ORIGIN_PRESERVING_PREFIXES.has(prefix),
                  ...(prefix === "/ws" || prefix === "/api" ? { ws: true } : {}),
                },
              ]),
            ),
          }
        : {}),
      // Electron needs an explicit HMR host; elsewhere derive it from page origin for Tailscale/LAN.
      ...(explicitHost
        ? {
            hmr: {
              protocol: "ws",
              host: explicitHost,
              clientPort: port,
            },
          }
        : {}),
    },
    // Tailwind needs devSourcemap to avoid Rolldown SOURCEMAP_BROKEN on sourcemapped builds.
    css: {
      devSourcemap: buildSourcemap !== false,
    },
    build: {
      outDir: "dist",
      emptyOutDir: true,
      manifest: true,
      sourcemap: buildSourcemap,
      rolldownOptions: {
        output: {
          // PDF.js resolves decoder modules and ICC data relative to wasmUrl.
          assetFileNames: (asset) =>
            asset.originalFileNames.some((path) => /[/\\]pdfjs-dist[/\\]wasm[/\\]/.test(path))
              ? `assets/pdfjs-${pdfjsPkg.version}/[name][extname]`
              : "assets/[name]-[hash][extname]",
        },
      },
    },
    worker: { format: "es" },
    test: {
      projects: [
        defineProject(unitTestProject),
        defineProject(isolatedUnitTestProject),
        defineProject(browserTestProject),
        defineProject(compilerTestProject),
        defineProject(renderScenariosProject),
      ],
    },
  };
});
