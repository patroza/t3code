import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as DesktopDirInstallUpdates from "./DesktopDirInstallUpdates.ts";
import * as DesktopUpdatePolicy from "./DesktopUpdatePolicy.ts";
import * as DesktopUpdates from "./DesktopUpdates.ts";
import { makeHarness } from "./updatesTestHarness.ts";

// Directory deploys ship no app-update.yml, so nothing stands in for a feed.
const noFeed = { T3CODE_DESKTOP_MOCK_UPDATES: "false" };

const fileSystem = (files: ReadonlySet<string> = new Set()) =>
  FileSystem.layerNoop({
    exists: (path) => Effect.succeed(files.has(path)),
    readFileString: (path) =>
      Effect.fail(
        PlatformError.systemError({
          module: "FileSystem",
          method: "readFileString",
          _tag: "NotFound",
          pathOrDescriptor: path,
        }),
      ),
    makeDirectory: () => Effect.void,
    writeFileString: () => Effect.void,
    rename: () => Effect.void,
    remove: () => Effect.void,
  });

const dirInstall = () => {
  const installDirectory = { build: "build-a", relaunches: 0 };
  const layer = Layer.effect(DesktopUpdates.DesktopUpdates, DesktopUpdates.make).pipe(
    Layer.provide(
      DesktopDirInstallUpdates.layerTest({
        readInstalledBuild: Effect.sync(() => installDirectory.build),
        version: "1.2.3",
        relaunch: Effect.sync(() => {
          installDirectory.relaunches += 1;
        }),
      }),
    ),
    Layer.provide(Layer.mergeAll(fileSystem(), DesktopUpdatePolicy.layerTest())),
    Layer.provide(makeHarness({ platform: "linux", env: noFeed }).layer),
  );
  return { installDirectory, layer };
};

const untilDownloaded = Effect.gen(function* () {
  const updates = yield* DesktopUpdates.DesktopUpdates;
  const { changes } = yield* updates.subscribe;
  return yield* changes.pipe(
    Stream.filter((state) => state.status === "downloaded"),
    Stream.runHead,
    Effect.forkChild,
  );
});

describe("DesktopDirInstallUpdates", () => {
  it.effect("offers a build swapped into the install directory and relaunches into it", () => {
    const { installDirectory, layer } = dirInstall();
    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        assert.notEqual((yield* updates.getState).status, "disabled");

        const unchanged = yield* updates.check("menu");
        assert.isTrue(unchanged.checked);
        assert.equal(unchanged.state.status, "up-to-date");

        installDirectory.build = "build-b";
        const downloaded = yield* untilDownloaded;
        yield* TestClock.adjust("1 minute");
        yield* Fiber.join(downloaded);
        assert.equal((yield* updates.getState).downloadedVersion, "1.2.3");

        const install = yield* updates.install;
        assert.isTrue(install.accepted);
        assert.equal(installDirectory.relaunches, 1);
      }),
    ).pipe(Effect.provide(layer));
  });

  it.effect("finds a swapped build on an explicit check", () => {
    const { installDirectory, layer } = dirInstall();
    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        installDirectory.build = "build-b";
        const downloaded = yield* untilDownloaded;
        yield* updates.check("menu");
        yield* Fiber.join(downloaded);
      }),
    ).pipe(Effect.provide(layer));
  });

  it.effect("takes over only packaged directory installs", () =>
    Effect.gen(function* () {
      const takesOver = (input: {
        readonly platform: NodeJS.Platform;
        readonly executable: string;
        readonly files?: ReadonlyArray<string>;
        readonly env?: Record<string, string>;
        readonly policy?: DesktopUpdatePolicy.UpdatePolicy;
      }) =>
        DesktopDirInstallUpdates.enableDirInstall.pipe(
          Effect.flatMap((enable) => enable(Effect.succeedSome("disabled upstream"))),
          Effect.map(Option.isNone),
          Effect.provide(
            DesktopDirInstallUpdates.layer.pipe(
              Layer.provide(
                Layer.mergeAll(
                  fileSystem(new Set(input.files)),
                  DesktopUpdatePolicy.layerTest(input.policy),
                  Layer.mock(ElectronApp.ElectronApp, {}),
                  Layer.succeed(HostProcess.ExecutablePath, input.executable),
                ),
              ),
              Layer.provide(
                makeHarness({ platform: input.platform, env: { ...noFeed, ...input.env } }).layer,
              ),
            ),
          ),
          Effect.scoped,
        );
      const linuxDir = { platform: "linux", executable: "/opt/t3code/t3code" } as const;
      const windows = { platform: "win32", executable: "/T3 Code/T3 Code.exe" } as const;

      assert.isTrue(yield* takesOver(linuxDir));
      assert.isFalse(yield* takesOver({ ...linuxDir, files: ["/missing/resources/package-type"] }));
      assert.isFalse(yield* takesOver({ ...linuxDir, env: { APPIMAGE: "/opt/T3.AppImage" } }));
      assert.isFalse(
        yield* takesOver({ ...linuxDir, env: { T3CODE_DISABLE_AUTO_UPDATE: "true" } }),
      );
      assert.isFalse(
        yield* takesOver({
          ...linuxDir,
          policy: { ...DesktopUpdatePolicy.unmanagedUpdatePolicy, mode: "off" },
        }),
      );

      assert.isFalse(yield* takesOver(windows));
      assert.isTrue(
        yield* takesOver({
          ...windows,
          files: [`/T3 Code/${DesktopDirInstallUpdates.DIR_DEPLOY_MARKER_FILE}`],
        }),
      );

      assert.isFalse(
        yield* takesOver({ platform: "darwin", executable: "/Applications/T3 Code.app/t3code" }),
      );
    }),
  );
});
