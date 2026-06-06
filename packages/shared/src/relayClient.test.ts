import { sha256 } from "@noble/hashes/sha2";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  RelayClientInstallError,
  CLOUDFLARED_VERSION,
  makeCloudflaredRelayClient,
  resolveManagedCloudflaredPath,
} from "./relayClient.ts";

const emptyConfigProvider = () => ConfigProvider.fromEnv({ env: {} });

function makeHandle(exitCode = 0) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(100),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

const makeHttpClientLayer = (bytes: Uint8Array) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(bytes.buffer as ArrayBuffer)),
      ),
    ),
  );

const makeSpawnerLayer = (commands: Array<string>) =>
  Layer.mock(ChildProcessSpawner.ChildProcessSpawner, {
    spawn: (command) =>
      Effect.sync(() => {
        commands.push(ChildProcess.isStandardCommand(command) ? command.command : "piped-command");
        return makeHandle();
      }),
  });

describe("RelayClient", () => {
  it.effect("resolves explicit overrides before managed and PATH executables", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-cloudflared-test-",
      });
      const overridePath = `${baseDir}/override-cloudflared`;
      yield* fileSystem.writeFileString(overridePath, "override");
      yield* fileSystem.chmod(overridePath, 0o755);
      const manager = yield* makeCloudflaredRelayClient({
        baseDir,
        platform: "linux",
        arch: "x64",
        configProvider: () =>
          ConfigProvider.fromEnv({
            env: {
              PATH: "",
              T3CODE_CLOUDFLARED_PATH: overridePath,
            },
          }),
      });

      assert.deepStrictEqual(yield* manager.resolve, {
        status: "available",
        executablePath: overridePath,
        source: "override",
        version: CLOUDFLARED_VERSION,
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          makeHttpClientLayer(new Uint8Array()),
          makeSpawnerLayer([]),
        ),
      ),
    ),
  );

  it.effect("downloads, verifies, validates, and atomically installs the managed executable", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-cloudflared-test-",
      });
      const bytes = new TextEncoder().encode("test-cloudflared-binary");
      const manager = yield* makeCloudflaredRelayClient({
        baseDir,
        platform: "linux",
        arch: "x64",
        releaseAsset: {
          url: "https://example.test/cloudflared",
          sha256: Encoding.encodeHex(sha256(bytes)),
          archive: "binary",
        },
        configProvider: emptyConfigProvider,
      });

      const progress: Array<string> = [];
      const installed = yield* manager.installWithProgress((event) =>
        Effect.sync(() => {
          if (event.type === "progress") {
            progress.push(event.stage);
          }
        }),
      );
      const managedPath = resolveManagedCloudflaredPath({
        baseDir,
        platform: "linux",
        arch: "x64",
      });
      assert.deepStrictEqual(installed, {
        status: "available",
        executablePath: managedPath,
        source: "managed",
        version: CLOUDFLARED_VERSION,
      });
      assert.equal(
        new TextDecoder().decode(yield* fileSystem.readFile(managedPath)),
        "test-cloudflared-binary",
      );
      assert.deepStrictEqual(progress, [
        "checking",
        "waiting_for_lock",
        "downloading",
        "verifying",
        "installing",
        "validating",
        "activating",
      ]);
      assert.deepStrictEqual(yield* manager.resolve, installed);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          makeHttpClientLayer(new TextEncoder().encode("test-cloudflared-binary")),
          makeSpawnerLayer([]),
        ),
      ),
    ),
  );

  it.effect("rejects downloads whose checksum does not match the pinned manifest", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-cloudflared-test-",
      });
      const manager = yield* makeCloudflaredRelayClient({
        baseDir,
        platform: "linux",
        arch: "x64",
        releaseAsset: {
          url: "https://example.test/cloudflared",
          sha256: Encoding.encodeHex(sha256(new TextEncoder().encode("expected"))),
          archive: "binary",
        },
        configProvider: emptyConfigProvider,
      });

      const error = yield* manager.install.pipe(Effect.flip);
      assert.ok(error instanceof RelayClientInstallError);
      assert.equal(error.reason, "invalid_checksum");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          makeHttpClientLayer(new TextEncoder().encode("tampered")),
          makeSpawnerLayer([]),
        ),
      ),
    ),
  );

  it.effect("serializes concurrent installs within one runtime", () => {
    const commands: Array<string> = [];
    const bytes = new TextEncoder().encode("test-cloudflared-binary");
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-cloudflared-test-",
      });
      const manager = yield* makeCloudflaredRelayClient({
        baseDir,
        platform: "linux",
        arch: "x64",
        releaseAsset: {
          url: "https://example.test/cloudflared",
          sha256: Encoding.encodeHex(sha256(bytes)),
          archive: "binary",
        },
        configProvider: emptyConfigProvider,
      });

      const [first, second] = yield* Effect.all([manager.install, manager.install], {
        concurrency: "unbounded",
      });
      assert.deepStrictEqual(second, first);
      assert.equal(commands.length, 1);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(NodeServices.layer, makeHttpClientLayer(bytes), makeSpawnerLayer(commands)),
      ),
    );
  });

  it.effect("observes PATH changes after the manager has been constructed", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-cloudflared-test-",
      });
      const binDir = `${baseDir}/bin`;
      const executablePath = `${binDir}/cloudflared`;
      let path = "";
      const manager = yield* makeCloudflaredRelayClient({
        baseDir,
        platform: "linux",
        arch: "x64",
        configProvider: () => ConfigProvider.fromEnv({ env: { PATH: path } }),
      });

      assert.deepStrictEqual(yield* manager.resolve, {
        status: "missing",
        version: CLOUDFLARED_VERSION,
      });

      yield* fileSystem.makeDirectory(binDir);
      yield* fileSystem.writeFileString(executablePath, "cloudflared");
      yield* fileSystem.chmod(executablePath, 0o755);
      path = binDir;

      assert.deepStrictEqual(yield* manager.resolve, {
        status: "available",
        executablePath,
        source: "path",
        version: CLOUDFLARED_VERSION,
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          makeHttpClientLayer(new Uint8Array()),
          makeSpawnerLayer([]),
        ),
      ),
    ),
  );

  it.effect("removes stale install locks before installing", () => {
    const commands: Array<string> = [];
    const bytes = new TextEncoder().encode("test-cloudflared-binary");
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-cloudflared-test-",
      });
      const managedPath = resolveManagedCloudflaredPath({
        baseDir,
        platform: "linux",
        arch: "x64",
      });
      const lockPath = `${managedPath}.lock`;
      yield* fileSystem.makeDirectory(path.dirname(lockPath), { recursive: true });
      yield* fileSystem.writeFileString(lockPath, "stale");
      yield* fileSystem.utimes(lockPath, 0, 0);
      yield* TestClock.adjust(Duration.minutes(6));

      const manager = yield* makeCloudflaredRelayClient({
        baseDir,
        platform: "linux",
        arch: "x64",
        releaseAsset: {
          url: "https://example.test/cloudflared",
          sha256: Encoding.encodeHex(sha256(bytes)),
          archive: "binary",
        },
        configProvider: emptyConfigProvider,
      });

      const installed = yield* manager.install;

      assert.deepStrictEqual(installed, {
        status: "available",
        executablePath: managedPath,
        source: "managed",
        version: CLOUDFLARED_VERSION,
      });
      assert.equal(yield* fileSystem.exists(lockPath), false);
      assert.equal(commands.length, 1);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(NodeServices.layer, makeHttpClientLayer(bytes), makeSpawnerLayer(commands)),
      ),
    );
  });

  it.effect("times out install lock waits with the test clock", () => {
    const bytes = new TextEncoder().encode("test-cloudflared-binary");
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-cloudflared-test-",
      });
      const managedPath = resolveManagedCloudflaredPath({
        baseDir,
        platform: "linux",
        arch: "x64",
      });
      const lockPath = `${managedPath}.lock`;
      yield* fileSystem.makeDirectory(path.dirname(lockPath), { recursive: true });
      yield* fileSystem.writeFileString(lockPath, "locked");

      const manager = yield* makeCloudflaredRelayClient({
        baseDir,
        platform: "linux",
        arch: "x64",
        releaseAsset: {
          url: "https://example.test/cloudflared",
          sha256: Encoding.encodeHex(sha256(bytes)),
          archive: "binary",
        },
        configProvider: emptyConfigProvider,
      });

      const install = yield* manager.install.pipe(Effect.flip, Effect.forkScoped);
      yield* TestClock.adjust(Duration.seconds(10));
      const error = yield* Fiber.join(install);

      assert.ok(error instanceof RelayClientInstallError);
      assert.equal(error.reason, "install_locked");
      assert.equal(yield* fileSystem.exists(lockPath), true);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          makeHttpClientLayer(bytes),
          makeSpawnerLayer([]),
        ),
      ),
    );
  });
});
