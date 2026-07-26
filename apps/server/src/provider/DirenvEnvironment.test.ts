import { describe, expect, it, vi } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as ProcessRunner from "../processRunner.ts";
import { DirenvEnvironment, DirenvEnvironmentError, layer } from "./DirenvEnvironment.ts";

const successfulOutput = (
  stdout: string,
  stderr = "",
  code = 0,
): ProcessRunner.ProcessRunOutput => ({
  stdout,
  stderr,
  code: ChildProcessSpawner.ExitCode(code),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
});

function testLayer(run: ProcessRunner.ProcessRunner["Service"]["run"]) {
  return layer.pipe(
    Layer.provide(Layer.succeed(ProcessRunner.ProcessRunner, { run })),
    Layer.provideMerge(NodeServices.layer),
  );
}

const makeDirenvExecutable = Effect.fn("makeDirenvExecutable")(function* (directory: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const binDirectory = path.join(directory, "bin");
  const executable = path.join(binDirectory, "direnv");
  yield* fileSystem.makeDirectory(binDirectory, { recursive: true });
  yield* fileSystem.writeFileString(executable, "#!/bin/sh\nexit 0\n");
  yield* fileSystem.chmod(executable, 0o755);
  return { binDirectory, executable };
});

/** A temp project with an `.envrc` and a fake direnv on PATH. */
const setupDirenvProject = Effect.fn("setupDirenvProject")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-direnv-" });
  const envrcPath = path.join(cwd, ".envrc");
  yield* fileSystem.writeFileString(envrcPath, "export VALUE=next\n");
  const { binDirectory, executable } = yield* makeDirenvExecutable(cwd);
  return { cwd, envrcPath, binDirectory, executable };
});

describe("DirenvEnvironment", () => {
  describe("new worktree approval", () => {
    it.effect("approves the exact .envrc in a newly created worktree", () => {
      const run = vi.fn<ProcessRunner.ProcessRunner["Service"]["run"]>(() =>
        Effect.succeed(successfulOutput("")),
      );
      return Effect.gen(function* () {
        const { cwd, envrcPath, binDirectory, executable } = yield* setupDirenvProject();
        const environment = { PATH: binDirectory, KEEP: "value" };
        const direnvEnvironment = yield* DirenvEnvironment;

        yield* direnvEnvironment.allow({ cwd, environment });

        expect(run).toHaveBeenCalledOnce();
        expect(run.mock.calls[0]?.[0]).toMatchObject({
          command: executable,
          args: ["allow", envrcPath],
          cwd,
          env: environment,
          extendEnv: false,
        });
      }).pipe(Effect.provide(testLayer(run)));
    });

    it.effect("does not approve an ancestor .envrc outside the new worktree", () => {
      const run = vi.fn<ProcessRunner.ProcessRunner["Service"]["run"]>();
      return Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const parent = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-direnv-worktree-parent-",
        });
        const cwd = path.join(parent, "worktree");
        yield* fileSystem.makeDirectory(cwd);
        yield* fileSystem.writeFileString(path.join(parent, ".envrc"), "export VALUE=parent\n");
        const direnvEnvironment = yield* DirenvEnvironment;

        yield* direnvEnvironment.allow({ cwd, environment: { PATH: "/not-used" } });

        expect(run).not.toHaveBeenCalled();
      }).pipe(Effect.provide(testLayer(run)));
    });
  });

  it.effect(
    "returns the environment unchanged without inspecting PATH when no .envrc exists",
    () => {
      const run = vi.fn<ProcessRunner.ProcessRunner["Service"]["run"]>();
      return Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-direnv-none-" });
        const environment = { PATH: "/not-used", KEEP: "value" };
        const resolver = yield* DirenvEnvironment;

        expect(yield* resolver.resolve({ cwd, environment })).toBe(environment);
        expect(run).not.toHaveBeenCalled();
      }).pipe(Effect.provide(testLayer(run)));
    },
  );

  it.effect("discovers a parent-directory .envrc and runs direnv in the requested cwd", () => {
    const run = vi.fn<ProcessRunner.ProcessRunner["Service"]["run"]>(() =>
      Effect.succeed(successfulOutput("{}")),
    );
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-direnv-parent-" });
      const cwd = path.join(root, "nested", "project");
      yield* fileSystem.makeDirectory(cwd, { recursive: true });
      yield* fileSystem.writeFileString(path.join(root, ".envrc"), "export PROJECT=parent\n");
      const { binDirectory, executable } = yield* makeDirenvExecutable(root);
      const environment = { PATH: binDirectory };
      const resolver = yield* DirenvEnvironment;

      expect(yield* resolver.resolve({ cwd, environment })).toEqual(environment);
      expect(run).toHaveBeenCalledOnce();
      expect(run.mock.calls[0]?.[0]).toMatchObject({
        command: executable,
        args: ["export", "json"],
        cwd,
        env: environment,
        extendEnv: false,
      });
    }).pipe(Effect.provide(testLayer(run)));
  });

  it.effect(
    "returns the environment unchanged when .envrc exists but direnv is unavailable",
    () => {
      const run = vi.fn<ProcessRunner.ProcessRunner["Service"]["run"]>();
      return Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-direnv-missing-" });
        yield* fileSystem.writeFileString(path.join(cwd, ".envrc"), "export VALUE=next\n");
        const environment = { PATH: "", KEEP: "value" };
        const resolver = yield* DirenvEnvironment;

        expect(yield* resolver.resolve({ cwd, environment })).toBe(environment);
        expect(run).not.toHaveBeenCalled();
      }).pipe(Effect.provide(testLayer(run)));
    },
  );

  it.effect("applies additions, overrides, and removals from a successful export", () => {
    const run = vi.fn<ProcessRunner.ProcessRunner["Service"]["run"]>(() =>
      Effect.succeed(
        successfulOutput(JSON.stringify({ ADDED: "new", OVERRIDDEN: "direnv", REMOVED: null })),
      ),
    );
    return Effect.gen(function* () {
      const { cwd, binDirectory } = yield* setupDirenvProject();
      const resolver = yield* DirenvEnvironment;

      expect(
        yield* resolver.resolve({
          cwd,
          environment: {
            PATH: binDirectory,
            OVERRIDDEN: "provider-instance",
            REMOVED: "host",
            PRESERVED: "yes",
          },
        }),
      ).toEqual({
        PATH: binDirectory,
        ADDED: "new",
        OVERRIDDEN: "direnv",
        PRESERVED: "yes",
      });
    }).pipe(Effect.provide(testLayer(run)));
  });

  it.effect("returns actionable stderr for a blocked .envrc", () => {
    const run = vi.fn<ProcessRunner.ProcessRunner["Service"]["run"]>(() =>
      Effect.succeed(
        successfulOutput(
          "",
          "secret-environment-value: .envrc is blocked. Run `direnv allow` to approve",
          1,
        ),
      ),
    );
    return Effect.gen(function* () {
      const { cwd, binDirectory } = yield* setupDirenvProject();
      const resolver = yield* DirenvEnvironment;
      const error = yield* resolver
        .resolve({
          cwd,
          environment: { PATH: binDirectory, SECRET: "secret-environment-value" },
        })
        .pipe(Effect.flip);

      expect(error).toBeInstanceOf(DirenvEnvironmentError);
      expect(error.stage).toBe("execution");
      expect(error.message).toContain("direnv allow");
      expect(error.message).not.toContain("secret-environment-value");
    }).pipe(Effect.provide(testLayer(run)));
  });

  it.effect("rejects malformed or structurally invalid output without exposing stdout", () => {
    let stdout = "";
    const run = vi.fn<ProcessRunner.ProcessRunner["Service"]["run"]>(() =>
      Effect.succeed(successfulOutput(stdout)),
    );
    return Effect.gen(function* () {
      const { cwd, binDirectory } = yield* setupDirenvProject();
      const resolver = yield* DirenvEnvironment;

      for (const rawStdout of ["not-json secret-value", '{"SAFE":"value","INVALID":42}']) {
        stdout = rawStdout;
        const error = yield* resolver
          .resolve({ cwd, environment: { PATH: binDirectory } })
          .pipe(Effect.flip);

        expect(error.stage).toBe("invalid-output");
        expect(error.message).not.toContain(rawStdout);
        expect(error.cause).toBeUndefined();
      }
    }).pipe(Effect.provide(testLayer(run)));
  });
});
