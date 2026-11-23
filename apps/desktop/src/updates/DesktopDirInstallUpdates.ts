/**
 * Fork deploys copy a new build into the install directory under the running app, with no feed.
 * This stands in for electron-updater there: a different on-disk build is offered as downloaded,
 * and installing relaunches into it. DesktopUpdates keeps owning the state machine.
 */
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronProtocol from "../electron/ElectronProtocol.ts";
import * as ElectronUpdater from "../electron/ElectronUpdater.ts";
import * as DesktopUpdatePolicy from "./DesktopUpdatePolicy.ts";

/** Written beside the executable by the fork's directory deploy, on Linux and Windows. */
export const DIR_DEPLOY_MARKER_FILE = ".t3code-deploy-sha";

const POLL_INTERVAL = Duration.minutes(1);

const { logInfo } = DesktopObservability.makeComponentLogger("desktop-dir-install-updater");

const DirInstallMode = Context.Reference<boolean>(
  "@t3tools/desktop/updates/DesktopDirInstallUpdates/DirInstallMode",
  { defaultValue: () => false },
);

/**
 * Hook for DesktopUpdates' disabled reason. A directory install has no feed and is neither an
 * AppImage nor a .deb, yet still updates; the layer only enters this mode when the managed policy
 * and T3CODE_DISABLE_AUTO_UPDATE allow updates.
 */
export const enableDirInstall = Effect.map(
  DirInstallMode,
  (dirInstall) =>
    <E, R>(
      self: Effect.Effect<Option.Option<string>, E, R>,
    ): Effect.Effect<Option.Option<string>, E, R> =>
      dirInstall ? Effect.succeedNone : self,
);

type Listener = (...args: ReadonlyArray<unknown>) => void;

export interface DirInstallUpdaterOptions {
  /** A value that changes whenever a different build lands in the install directory. */
  readonly readInstalledBuild: Effect.Effect<string>;
  readonly version: string;
  readonly relaunch: Effect.Effect<void>;
}

/** An electron-updater stand-in whose only feed is the install directory itself. */
const makeDirInstallUpdater = Effect.fn("DesktopDirInstallUpdates.makeUpdater")(function* (
  options: DirInstallUpdaterOptions,
) {
  const runningBuild = yield* options.readInstalledBuild;
  const announcedBuildRef = yield* Ref.make(runningBuild);
  const listeners = new Map<string, Set<Listener>>();
  const info = { version: options.version };

  const emit = (eventName: string, payload?: unknown) => {
    const eventListeners = listeners.get(eventName);
    for (const listener of eventListeners ?? []) listener(payload);
    return (eventListeners?.size ?? 0) > 0;
  };
  // The build cannot be downloaded separately: it is already on disk, so offer it as downloaded.
  const offerInstalledBuild = () => {
    emit("update-available", info);
    return emit("update-downloaded", info);
  };

  const installedBuild = options.readInstalledBuild;

  yield* Effect.gen(function* () {
    const build = yield* installedBuild;
    if (build === runningBuild || build === (yield* Ref.get(announcedBuildRef))) return;
    yield* logInfo("different build detected in the install directory");
    if (offerInstalledBuild()) yield* Ref.set(announcedBuildRef, build);
  }).pipe(
    Effect.delay(POLL_INTERVAL),
    Effect.forever,
    Effect.withSpan("DesktopDirInstallUpdates.watch"),
    Effect.forkScoped,
  );

  const noop = () => Effect.void;
  return ElectronUpdater.ElectronUpdater.of({
    setFeedURL: noop,
    setAutoDownload: noop,
    setAutoInstallOnAppQuit: noop,
    setChannel: noop,
    setAllowPrerelease: noop,
    allowDowngrade: Effect.succeed(false),
    setAllowDowngrade: noop,
    setFullChangelog: noop,
    setDisableDifferentialDownload: noop,
    // Like electron-updater, a check settles through its events before it returns.
    checkForUpdates: Effect.gen(function* () {
      const build = yield* installedBuild;
      if (build === runningBuild) {
        emit("update-not-available", info);
        return;
      }
      yield* Ref.set(announcedBuildRef, build);
      offerInstalledBuild();
    }),
    downloadUpdate: Effect.sync(() => {
      emit("update-downloaded", info);
    }),
    quitAndInstall: Effect.fn("DesktopDirInstallUpdates.quitAndInstall")(function* () {
      yield* logInfo("relaunching into the build in the install directory");
      yield* options.relaunch;
    }),
    on: Effect.fn("DesktopDirInstallUpdates.on")(function (eventName, listener) {
      const untypedListener = listener as unknown as Listener;
      return Effect.acquireRelease(
        Effect.sync(() => {
          const eventListeners = listeners.get(eventName) ?? new Set<Listener>();
          eventListeners.add(untypedListener);
          listeners.set(eventName, eventListeners);
        }),
        () => Effect.sync(() => listeners.get(eventName)?.delete(untypedListener)),
      ).pipe(Effect.asVoid);
    }),
  });
});

const isDirInstall = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const config = yield* DesktopConfig.DesktopConfig;
  const policy = yield* DesktopUpdatePolicy.DesktopUpdatePolicy;
  const fileSystem = yield* FileSystem.FileSystem;
  if (
    !environment.isPackaged ||
    environment.isDevelopment ||
    config.disableAutoUpdate ||
    policy.mode === "off"
  ) {
    return false;
  }
  const exists = (path: string) => fileSystem.exists(path).pipe(Effect.orElseSucceed(() => false));
  const executablePath = yield* HostProcess.ExecutablePath;
  switch (environment.platform) {
    // AppImage and package installs (electron-builder writes `package-type`) keep electron-updater.
    // The `--target dir` build's executable is `t3code`.
    case "linux":
      return (
        environment.path.basename(executablePath) === "t3code" &&
        Option.isNone(config.appImagePath) &&
        !(yield* exists(environment.path.join(environment.resourcesPath, "package-type")))
      );
    // An NSIS install keeps electron-updater unless the directory deploy took it over.
    case "win32":
      return yield* exists(
        environment.path.join(environment.path.dirname(executablePath), DIR_DEPLOY_MARKER_FILE),
      );
    default:
      return false;
  }
});

const readInstalledBuild = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const executablePath = yield* HostProcess.ExecutablePath;
  // app.asar cannot tell: Electron keeps reading the archive it opened at startup.
  const marker = yield* fileSystem
    .readFileString(
      environment.path.join(environment.path.dirname(executablePath), DIR_DEPLOY_MARKER_FILE),
    )
    .pipe(Effect.orElseSucceed(() => ""));
  const executableModified = yield* fileSystem.stat(executablePath).pipe(
    Effect.map((info) => Option.match(info.mtime, { onNone: () => "", onSome: String })),
    Effect.orElseSucceed(() => ""),
  );
  return `${marker.trim()}|${executableModified}`;
});

const relaunch = Effect.gen(function* () {
  const electronApp = yield* ElectronApp.ElectronApp;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  // Startup already acted on the app link that launched it; passing it on replays it.
  const appLinkPrefix = `${ElectronProtocol.getDesktopScheme(environment.isDevelopment)}:`;
  const args = yield* HostProcess.Arguments;
  yield* electronApp.relaunch({
    execPath: yield* HostProcess.ExecutablePath,
    args: args.slice(1).filter((arg) => !arg.toLowerCase().startsWith(appLinkPrefix)),
  });
  // The ordinary quit runs the graceful shutdown; the relaunch starts once this process exits.
  yield* electronApp.quit;
});

/** Swaps DesktopUpdates' electron-updater for the directory-install updater when it applies. */
export const layer = Layer.effectContext(
  Effect.gen(function* () {
    const upstream = yield* ElectronUpdater.ElectronUpdater;
    if (!(yield* isDirInstall)) return Context.make(ElectronUpdater.ElectronUpdater, upstream);
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const context = yield* Effect.context<
      ElectronApp.ElectronApp | DesktopEnvironment.DesktopEnvironment | FileSystem.FileSystem
    >();
    yield* logInfo("directory install: updates come from the install directory");
    const updater = yield* makeDirInstallUpdater({
      readInstalledBuild: Effect.provideContext(readInstalledBuild, context),
      version: environment.appVersion,
      relaunch: Effect.provideContext(relaunch, context),
    });
    return Context.make(ElectronUpdater.ElectronUpdater, updater).pipe(
      Context.add(DirInstallMode, true),
    );
  }),
);

/** The directory-install updater with a scripted install directory. */
export const layerTest = (options: DirInstallUpdaterOptions) =>
  Layer.effectContext(
    makeDirInstallUpdater(options).pipe(
      Effect.map((updater) =>
        Context.make(ElectronUpdater.ElectronUpdater, updater).pipe(
          Context.add(DirInstallMode, true),
        ),
      ),
    ),
  );
