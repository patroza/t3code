#!/usr/bin/env node
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  DEVELOPMENT_ICON_OVERRIDES,
  resolveWebAssetBrandForPackageVersion,
  resolveWebIconOverrides,
} from "../../../scripts/lib/brand-assets.ts";
import { resolveCatalogDependencies } from "../../../scripts/lib/resolve-catalog.ts";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import { fromYaml } from "@t3tools/shared/schemaYaml";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import serverPackageJson from "../package.json" with { type: "json" };
import {
  ServerCliBuildAssetMissingError,
  ServerCliCommandExitError,
  ServerCliDevelopmentIconSourceMissingError,
  ServerCliDevelopmentIconTargetMissingError,
  ServerCliPublishIconSourceMissingError,
  ServerCliPublishIconTargetMissingError,
  ServerCliWebClientBundleMissingError,
} from "./cliErrors.ts";
import { shouldPreserveServerDistEntry } from "./serverDistClean.ts";

interface PackageJson {
  name: string;
  repository: {
    type: string;
    url: string;
    directory: string;
  };
  bin: Record<string, string>;
  type: string;
  version: string;
  engines: Record<string, string>;
  files: string[];
  dependencies: Record<string, string>;
  overrides: Record<string, string>;
}

const PackageJsonPrettyJson = fromJsonStringPretty(Schema.Unknown);
const encodePackageJson = Schema.encodeEffect(PackageJsonPrettyJson);

const WorkspaceConfig = Schema.Struct({
  catalog: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  overrides: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
type WorkspaceConfig = typeof WorkspaceConfig.Type;
const decodeWorkspaceConfig = Schema.decodeEffect(fromYaml(WorkspaceConfig));

const RepoRoot = Effect.service(Path.Path).pipe(
  Effect.flatMap((path) => path.fromFileUrl(new URL("../../..", import.meta.url))),
);

const readWorkspaceConfig = Effect.fn("readWorkspaceConfig")(function* () {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const repoRoot = yield* RepoRoot;
  const workspaceYaml = yield* fs.readFileString(path.join(repoRoot, "pnpm-workspace.yaml"));
  return yield* decodeWorkspaceConfig(workspaceYaml);
});

const runCommand = Effect.fn("runCommand")(function* (command: ChildProcess.StandardCommand) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(command);
  const exitCode = yield* child.exitCode;

  if (exitCode !== 0) {
    return yield* new ServerCliCommandExitError({
      command: command.command,
      args: command.args,
      cwd: command.options.cwd,
      exitCode,
    });
  }
});

const preparePublishIcons = Effect.fn("preparePublishIcons")(function* (
  repoRoot: string,
  serverDir: string,
  version: string,
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const brand = resolveWebAssetBrandForPackageVersion(version);
  const icons = resolveWebIconOverrides(brand, "dist/client").map((override) => ({
    sourcePath: path.join(repoRoot, override.sourceRelativePath),
    targetPath: path.join(serverDir, override.targetRelativePath),
  }));

  for (const icon of icons) {
    if (!(yield* fs.exists(icon.sourcePath))) {
      return yield* new ServerCliPublishIconSourceMissingError({ sourcePath: icon.sourcePath });
    }
    if (!(yield* fs.exists(icon.targetPath))) {
      return yield* new ServerCliPublishIconTargetMissingError({ targetPath: icon.targetPath });
    }
  }

  return yield* Effect.forEach(icons, (icon) =>
    Effect.all({
      original: fs.readFile(icon.targetPath),
      publish: fs.readFile(icon.sourcePath),
    }).pipe(Effect.map((contents) => ({ ...icon, ...contents }))),
  );
});

const applyDevelopmentIconOverrides = Effect.fn("applyDevelopmentIconOverrides")(function* (
  repoRoot: string,
  serverDir: string,
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;

  for (const override of DEVELOPMENT_ICON_OVERRIDES) {
    const sourcePath = path.join(repoRoot, override.sourceRelativePath);
    const targetPath = path.join(serverDir, override.targetRelativePath);

    if (!(yield* fs.exists(sourcePath))) {
      return yield* new ServerCliDevelopmentIconSourceMissingError({ sourcePath });
    }
    if (!(yield* fs.exists(targetPath))) {
      return yield* new ServerCliDevelopmentIconTargetMissingError({ targetPath });
    }

    yield* fs.copyFile(sourcePath, targetPath);
  }

  yield* Effect.log("[cli] Applied development icon overrides to dist/client");
});

// ---------------------------------------------------------------------------
// build subcommand
// ---------------------------------------------------------------------------

/**
 * Remove pack outputs under dist/ while leaving the live web client tree alone.
 * Deploy rebuilds the server with the process still serving dist/client; a
 * full `vp pack --clean` wipe is what left desktop on an empty "Not Found"
 * shell until someone re-ran `pnpm build` by hand.
 */
const cleanServerDistPreservingClient = Effect.fn("cleanServerDistPreservingClient")(function* (
  distDir: string,
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(distDir))) {
    return;
  }
  const entries = yield* fs.readDirectory(distDir);
  for (const entry of entries) {
    if (shouldPreserveServerDistEntry(entry)) {
      continue;
    }
    yield* fs.remove(path.join(distDir, entry), { recursive: true, force: true });
  }
});

const promoteWebClientBundle = Effect.fn("promoteWebClientBundle")(function* (input: {
  readonly repoRoot: string;
  readonly serverDir: string;
}) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const webDist = path.join(input.repoRoot, "apps/web/dist");
  const webIndex = path.join(webDist, "index.html");
  const distDir = path.join(input.serverDir, "dist");
  const clientTarget = path.join(distDir, "client");
  const previousDir = path.join(distDir, "client.prev");

  // Fail closed: soft-skipping shipped empty client trees that surface as
  // desktop "Not Found" after deploy.
  if (!(yield* fs.exists(webIndex))) {
    return yield* new ServerCliWebClientBundleMissingError({ webDistPath: webDist });
  }

  yield* fs.makeDirectory(distDir, { recursive: true });
  const stagingDir = yield* fs.makeTempDirectory({
    directory: distDir,
    prefix: "client.next.",
  });

  yield* Effect.gen(function* () {
    yield* fs.copy(webDist, stagingDir);
    if (!(yield* fs.exists(path.join(stagingDir, "index.html")))) {
      return yield* new ServerCliWebClientBundleMissingError({ webDistPath: stagingDir });
    }

    if (yield* fs.exists(previousDir)) {
      yield* fs.remove(previousDir, { recursive: true, force: true });
    }
    if (yield* fs.exists(clientTarget)) {
      yield* fs.rename(clientTarget, previousDir);
    }
    yield* fs.rename(stagingDir, clientTarget).pipe(
      Effect.catch((cause) =>
        // If promote fails after the live tree was moved aside, put the
        // previous client back so the process never stays empty.
        Effect.gen(function* () {
          if ((yield* fs.exists(previousDir)) && !(yield* fs.exists(clientTarget))) {
            yield* fs.rename(previousDir, clientTarget).pipe(Effect.ignore);
          }
          return yield* Effect.fail(cause);
        }),
      ),
    );
    if (yield* fs.exists(previousDir)) {
      yield* fs.remove(previousDir, { recursive: true, force: true }).pipe(Effect.ignore);
    }

    yield* applyDevelopmentIconOverrides(input.repoRoot, input.serverDir);

    if (!(yield* fs.exists(path.join(clientTarget, "index.html")))) {
      return yield* new ServerCliWebClientBundleMissingError({ webDistPath: clientTarget });
    }
    yield* Effect.log("[cli] Bundled web app into dist/client");
  }).pipe(
    Effect.ensuring(
      // Staging only remains if promote failed before rename; force so a
      // successful promote (path gone) is a no-op.
      fs.remove(stagingDir, { recursive: true, force: true }).pipe(Effect.ignore),
    ),
  );
});

const buildCmd = Command.make(
  "build",
  {
    verbose: Flag.boolean("verbose").pipe(Flag.withDefault(false)),
  },
  (config) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const repoRoot = yield* RepoRoot;
      const serverDir = path.join(repoRoot, "apps/server");
      const distDir = path.join(serverDir, "dist");

      // Prefer a complete client tree *before* packing when web dist is already
      // present (dependsOn web#build). That way a live server keeps serving
      // through the JS rebuild window instead of losing index.html at pack clean.
      const webIndex = path.join(repoRoot, "apps/web/dist", "index.html");
      if (yield* fs.exists(webIndex)) {
        yield* promoteWebClientBundle({ repoRoot, serverDir });
      }

      yield* Effect.log("[cli] Cleaning server dist (preserving dist/client)...");
      yield* cleanServerDistPreservingClient(distDir);

      yield* Effect.log("[cli] Running tsdown...");
      yield* runCommand(
        ChildProcess.make(process.execPath, ["--run", "build:bundle"], {
          cwd: serverDir,
          stdout: config.verbose ? "inherit" : "ignore",
          stderr: "inherit",
          shell: false,
        }),
      );

      // Always re-promote after pack so the served tree matches the web build
      // that this package depends on (and fail closed if it is missing).
      yield* promoteWebClientBundle({ repoRoot, serverDir });
    }),
).pipe(Command.withDescription("Build the server package (tsdown + bundle web client)."));

// ---------------------------------------------------------------------------
// publish subcommand
// ---------------------------------------------------------------------------

interface PublishCommandConfig {
  readonly access: string;
  readonly tag: string;
  readonly provenance: boolean;
  readonly dryRun: boolean;
}

const createVpPmPublishArgs = (config: PublishCommandConfig): ReadonlyArray<string> => {
  const args = [
    "publish",
    "--filter",
    "t3",
    "--access",
    config.access,
    "--tag",
    config.tag,
    "--no-git-checks",
  ];

  if (config.provenance) args.push("--provenance");
  if (config.dryRun) args.push("--dry-run");

  return args;
};

const publishCmd = Command.make(
  "publish",
  {
    tag: Flag.string("tag").pipe(Flag.withDefault("latest")),
    access: Flag.string("access").pipe(Flag.withDefault("public")),
    appVersion: Flag.string("app-version").pipe(Flag.optional),
    provenance: Flag.boolean("provenance").pipe(Flag.withDefault(false)),
    dryRun: Flag.boolean("dry-run").pipe(Flag.withDefault(false)),
    verbose: Flag.boolean("verbose").pipe(Flag.withDefault(false)),
  },
  (config) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const repoRoot = yield* RepoRoot;
      const serverDir = path.join(repoRoot, "apps/server");
      const packageJsonPath = path.join(serverDir, "package.json");

      // Assert build assets exist
      for (const relPath of [
        "dist/bin.mjs",
        "dist/service-launcher.mjs",
        "dist/client/index.html",
      ]) {
        const abs = path.join(serverDir, relPath);
        if (!(yield* fs.exists(abs))) {
          return yield* new ServerCliBuildAssetMissingError({ assetPath: abs });
        }
      }

      yield* Effect.acquireUseRelease(
        // Acquire: resolve publish metadata and read every original before mutation.
        Effect.gen(function* () {
          const version = Option.getOrElse(config.appVersion, () => serverPackageJson.version);
          const workspaceConfig = yield* readWorkspaceConfig();
          const workspaceCatalog = workspaceConfig.catalog ?? {};
          const workspaceOverrides = workspaceConfig.overrides ?? {};
          const pkg: PackageJson = {
            name: serverPackageJson.name,
            repository: serverPackageJson.repository,
            bin: serverPackageJson.bin,
            type: serverPackageJson.type,
            version,
            engines: serverPackageJson.engines,
            files: serverPackageJson.files,
            dependencies: resolveCatalogDependencies(
              serverPackageJson.dependencies,
              workspaceCatalog,
              "apps/server",
            ),
            overrides: resolveCatalogDependencies(
              workspaceOverrides,
              workspaceCatalog,
              "apps/server",
            ),
          };

          return {
            packageJsonString: yield* encodePackageJson(pkg),
            originalPackageJson: yield* fs.readFile(packageJsonPath),
            icons: yield* preparePublishIcons(repoRoot, serverDir, version),
          };
        }),
        // Use: pnpm publish from the workspace root so pnpm-only workspace
        // config, including override selectors, is interpreted correctly.
        (resource) =>
          Effect.gen(function* () {
            yield* fs.writeFileString(packageJsonPath, `${resource.packageJsonString}\n`);
            for (const icon of resource.icons) {
              yield* fs.writeFile(icon.targetPath, icon.publish);
            }
            yield* Effect.log("[cli] Applied package metadata and publish icon overrides");

            const args = createVpPmPublishArgs(config);
            const spawnCommand = yield* resolveSpawnCommand("vp", ["pm", ...args]);

            yield* Effect.log(`[cli] Running: vp pm ${args.join(" ")}`);
            yield* runCommand(
              ChildProcess.make(spawnCommand.command, spawnCommand.args, {
                cwd: repoRoot,
                stdout: config.verbose ? "inherit" : "ignore",
                stderr: "inherit",
                shell: spawnCommand.shell,
              }),
            );
          }),
        // Release: restore every file even if applying overrides or publishing fails.
        (resource) =>
          Effect.gen(function* () {
            yield* fs.writeFile(packageJsonPath, resource.originalPackageJson);
            for (const icon of resource.icons) {
              yield* fs.writeFile(icon.targetPath, icon.original);
            }
            if (config.verbose) yield* Effect.log("[cli] Restored original publish assets");
          }),
      );
    }),
).pipe(Command.withDescription("Publish the server package to npm."));

// ---------------------------------------------------------------------------
// root command
// ---------------------------------------------------------------------------

const cli = Command.make("cli").pipe(
  Command.withDescription("T3 server build & publish CLI."),
  Command.withSubcommands([buildCmd, publishCmd]),
);

Command.run(cli, { version: "0.0.0" }).pipe(
  Effect.scoped,
  Effect.provide([Logger.layer([Logger.consolePretty()]), NodeServices.layer]),
  NodeRuntime.runMain,
);
