import * as Electron from "electron";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

export class MacApplicationIconResolutionError extends Schema.TaggedErrorClass<MacApplicationIconResolutionError>()(
  "MacApplicationIconResolutionError",
  {
    applicationPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to resolve the macOS application icon for ${this.applicationPath}.`;
  }
}

export class MacApplicationIcon extends Context.Service<
  MacApplicationIcon,
  {
    readonly resolveDataUrl: (
      applicationPath: string,
    ) => Effect.Effect<string, MacApplicationIconResolutionError>;
  }
>()("@t3tools/desktop/electron/MacApplicationIcon") {}

export const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const pathService = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;

  const resolveBundleIconPath = Effect.fn(
    "desktop.electron.macApplicationIcon.resolveBundleIconPath",
  )(function* (applicationPath: string) {
    const infoPlistPath = pathService.join(applicationPath, "Contents", "Info.plist");
    const configuredName = yield* spawner
      .string(
        ChildProcess.make(
          "/usr/bin/plutil",
          ["-extract", "CFBundleIconFile", "raw", infoPlistPath],
          { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
        ),
      )
      .pipe(Effect.map((output) => output.trim()));
    if (
      configuredName.length === 0 ||
      pathService.basename(configuredName) !== configuredName ||
      configuredName === "." ||
      configuredName === ".."
    ) {
      return Option.none();
    }
    const iconName = pathService.extname(configuredName)
      ? configuredName
      : `${configuredName}.icns`;
    const iconPath = pathService.join(applicationPath, "Contents", "Resources", iconName);
    const stat = yield* fs.stat(iconPath);
    return stat.type === "File" ? Option.some(iconPath) : Option.none();
  });

  const convertIcnsToDataUrl = Effect.fn(
    "desktop.electron.macApplicationIcon.convertIcnsToDataUrl",
  )(function* (applicationPath: string, iconPath: string) {
    return yield* Effect.gen(function* () {
      const temporaryDirectory = yield* fs.makeTempDirectoryScoped({
        prefix: "t3code-open-with-icon-",
      });
      const pngPath = pathService.join(temporaryDirectory, "icon.png");
      yield* spawner.string(
        ChildProcess.make("/usr/bin/sips", ["-s", "format", "png", iconPath, "--out", pngPath], {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        }),
      );
      const png = yield* fs.readFile(pngPath);
      const image = yield* Effect.try({
        try: () => Electron.nativeImage.createFromBuffer(Buffer.from(png)),
        catch: (cause) => new MacApplicationIconResolutionError({ applicationPath, cause }),
      });
      if (image.isEmpty()) {
        return yield* new MacApplicationIconResolutionError({
          applicationPath,
          cause: new Error("The converted application icon is empty."),
        });
      }
      return image.toDataURL();
    }).pipe(Effect.scoped);
  });

  const resolveDataUrl = Effect.fn("desktop.electron.macApplicationIcon.resolveDataUrl")(function* (
    applicationPath: string,
  ) {
    // Electron can return a generic bundle icon, so prefer the app's declared ICNS asset.
    const iconPath = yield* resolveBundleIconPath(applicationPath).pipe(
      Effect.orElseSucceed(() => Option.none()),
    );
    if (Option.isSome(iconPath)) {
      const bundleIcon = yield* convertIcnsToDataUrl(applicationPath, iconPath.value).pipe(
        Effect.map(Option.some),
        Effect.orElseSucceed(() => Option.none()),
      );
      if (Option.isSome(bundleIcon)) return bundleIcon.value;
    }

    const image = yield* Effect.tryPromise({
      try: () => Electron.app.getFileIcon(applicationPath, { size: "large" }),
      catch: (cause) => new MacApplicationIconResolutionError({ applicationPath, cause }),
    });
    return yield* Effect.try({
      try: () => image.toDataURL(),
      catch: (cause) => new MacApplicationIconResolutionError({ applicationPath, cause }),
    });
  });

  return MacApplicationIcon.of({ resolveDataUrl });
});

export const layer = Layer.effect(MacApplicationIcon, make);
