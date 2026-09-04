import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/unstable/process";
import { assert, describe, it } from "@effect/vitest";

import { GitCommandError } from "@t3tools/contracts";
import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import * as VcsDriver from "./VcsDriver.ts";
import * as VcsProcess from "./VcsProcess.ts";
import { runVcsDriverContractSuite } from "./testing/VcsDriverContractHarness.ts";

const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-git-vcs-contract-",
});
const GitContractLayer = Layer.mergeAll(GitVcsDriver.vcsLayer, GitVcsDriver.layer).pipe(
  Layer.provide(ServerConfigLayer),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

const runGit = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    yield* driver.execute({
      operation: "GitVcsDriver.contract.git",
      cwd,
      args,
      timeoutMs: 10_000,
    });
  });

type GitContractError = GitCommandError | PlatformError.PlatformError;

runVcsDriverContractSuite<GitVcsDriver.GitVcsDriver, GitContractError>({
  name: "Git",
  kind: "git",
  layer: GitContractLayer,
  fixture: {
    createRepo: (cwd) =>
      Effect.gen(function* () {
        yield* runGit(cwd, ["init"]);
        yield* runGit(cwd, ["config", "user.email", "test@test.com"]);
        yield* runGit(cwd, ["config", "user.name", "Test"]);
      }),
    writeFile: (cwd, relativePath, contents) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const absolutePath = path.join(cwd, relativePath);
        yield* fileSystem.makeDirectory(path.dirname(absolutePath), { recursive: true });
        yield* fileSystem.writeFileString(absolutePath, contents);
      }),
    trackFile: (cwd, relativePath) => runGit(cwd, ["add", relativePath]),
    commit: (cwd, message) => runGit(cwd, ["commit", "-m", message]),
    ignorePath: (cwd, pattern) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fileSystem.writeFileString(path.join(cwd, ".gitignore"), `${pattern}\n`);
      }),
  },
});

const withTempDir = <A, E, R>(use: (cwd: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-git-bare-" });
    return yield* use(cwd);
  }).pipe(Effect.scoped, Effect.provide(GitContractLayer));

describe("GitVcsDriver bare repositories", () => {
  it.effect("detects a bare repository instead of reporting no repository", () =>
    withTempDir((cwd) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const driver = yield* VcsDriver.VcsDriver;
        yield* runGit(cwd, ["init", "--bare"]);

        const identity = yield* driver.detectRepository(cwd);

        assert.equal(identity?.kind, "git");
        assert.equal(identity?.bare, true);
        // A bare repository has no toplevel, so the metadata directory is the root.
        assert.equal(identity?.rootPath, path.normalize(cwd));
        assert.isFalse(yield* driver.isInsideWorkTree(cwd));
      }),
    ),
  );

  it.effect("detects a repository whose config marks an existing checkout bare", () =>
    withTempDir((cwd) =>
      Effect.gen(function* () {
        const driver = yield* VcsDriver.VcsDriver;
        yield* runGit(cwd, ["init"]);
        // The shape a repository lands in when `core.bare` is flipped under a
        // populated checkout: every Git route used to fail detection outright.
        yield* runGit(cwd, ["config", "core.bare", "true"]);

        const identity = yield* driver.detectRepository(cwd);

        assert.equal(identity?.kind, "git");
        assert.equal(identity?.bare, true);
      }),
    ),
  );

  it.effect("still reports no repository outside one", () =>
    withTempDir((cwd) =>
      Effect.gen(function* () {
        const driver = yield* VcsDriver.VcsDriver;
        assert.equal(yield* driver.detectRepository(cwd), null);
      }),
    ),
  );

  it.effect("creates a usable worktree from a bare repository", () =>
    withTempDir((root) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const driver = yield* VcsDriver.VcsDriver;
        const gitDriver = yield* GitVcsDriver.GitVcsDriver;

        const source = path.join(root, "source");
        const bare = path.join(root, "bare.git");
        const worktree = path.join(root, "worktree");
        yield* fileSystem.makeDirectory(source, { recursive: true });
        yield* runGit(source, ["init"]);
        yield* runGit(source, ["config", "user.email", "test@test.com"]);
        yield* runGit(source, ["config", "user.name", "Test"]);
        yield* runGit(source, ["commit", "--allow-empty", "-m", "init"]);
        // Explicit branch name: `git init` defaults vary by host config.
        yield* runGit(source, ["branch", "t3-base"]);
        yield* runGit(root, ["clone", "--bare", source, bare]);

        const result = yield* gitDriver.createWorktree({
          cwd: bare,
          refName: "t3-base",
          newRefName: "feature",
          path: worktree,
        });

        assert.equal(result.worktree.path, worktree);
        assert.equal(result.worktree.refName, "feature");
        // The thread's checkout is a real working tree even though its source has none.
        assert.isTrue(yield* driver.isInsideWorkTree(worktree));
        const worktreeIdentity = yield* driver.detectRepository(worktree);
        assert.equal(worktreeIdentity?.bare, false);
      }),
    ),
  );
});

it.effect("GitVcsDriver forwards execute env to the VCS process", () => {
  let observedEnv: NodeJS.ProcessEnv | undefined;
  let observedAppendTruncationMarker: boolean | undefined;
  let observedOutputMode: VcsProcess.VcsProcessInput["outputMode"];

  return Effect.gen(function* () {
    const driver = yield* GitVcsDriver.makeVcsDriverShape();

    yield* driver.execute({
      operation: "GitVcsDriver.test.env",
      cwd: "/repo",
      args: ["status"],
      env: {
        GIT_INDEX_FILE: "/tmp/t3-index",
      },
      appendTruncationMarker: true,
      outputMode: "error",
    });

    assert.deepStrictEqual(observedEnv, {
      GIT_INDEX_FILE: "/tmp/t3-index",
    });
    assert.strictEqual(observedAppendTruncationMarker, true);
    assert.strictEqual(observedOutputMode, "error");
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(VcsProcess.VcsProcess)({
          run: (input) =>
            Effect.sync(() => {
              observedEnv = input.env;
              observedAppendTruncationMarker = input.appendTruncationMarker;
              observedOutputMode = input.outputMode;
              return {
                exitCode: ChildProcessSpawner.ExitCode(0),
                stdout: "",
                stderr: "",
                stdoutTruncated: false,
                stderrTruncated: false,
              };
            }),
        }),
      ),
    ),
  );
});
