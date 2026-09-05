import { assert, it, describe } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as VcsProcess from "./VcsProcess.ts";
import * as VcsProjectConfig from "./VcsProjectConfig.ts";
import * as VcsDriverRegistry from "./VcsDriverRegistry.ts";

const processOutput = (stdout: string): VcsProcess.VcsProcessOutput => ({
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

const normalizeGitArgs = (args: ReadonlyArray<string>): ReadonlyArray<string> =>
  args[0] === "-C" && args.length >= 2 ? args.slice(2) : args;

describe("VcsDriverRegistry", () => {
  it.effect("routes directly by VCS driver kind for non-repository workflows", () => {
    const layer = Layer.effect(VcsDriverRegistry.VcsDriverRegistry, VcsDriverRegistry.make).pipe(
      Layer.provide(NodeServices.layer),
      Layer.provide(
        Layer.mock(VcsProjectConfig.VcsProjectConfig)({
          resolveKind: (input) => Effect.succeed(input.requestedKind ?? "auto"),
        }),
      ),
      Layer.provide(
        Layer.mock(VcsProcess.VcsProcess)({
          run: () => Effect.succeed(processOutput("")),
        }),
      ),
    );

    return Effect.gen(function* () {
      const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
      const driver = yield* registry.get("git");

      assert.strictEqual(driver.capabilities.kind, "git");
    }).pipe(Effect.provide(layer));
  });

  it.effect("caches repository detection for repeated resolves in the same cwd and kind", () => {
    const calls: VcsProcess.VcsProcessInput[] = [];
    const layer = Layer.effect(VcsDriverRegistry.VcsDriverRegistry, VcsDriverRegistry.make).pipe(
      Layer.provide(NodeServices.layer),
      Layer.provide(
        Layer.mock(VcsProjectConfig.VcsProjectConfig)({
          resolveKind: (input) => Effect.succeed(input.requestedKind ?? "auto"),
        }),
      ),
      Layer.provide(
        Layer.mock(VcsProcess.VcsProcess)({
          run: (input) =>
            Effect.sync(() => {
              calls.push(input);
              const normalizedArgs =
                input.args[0] === "-C" && input.args.length >= 2 ? input.args.slice(2) : input.args;
              const command = normalizedArgs.join(" ");
              if (command === "rev-parse --is-bare-repository --is-inside-work-tree") {
                return processOutput("false\ntrue\n");
              }
              if (command === "rev-parse --show-toplevel") {
                return processOutput("/repo\n");
              }
              if (command === "rev-parse --git-common-dir") {
                return processOutput("/repo/.git\n");
              }
              return processOutput("");
            }),
        }),
      ),
    );

    return Effect.gen(function* () {
      const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
      const first = yield* registry.resolve({ cwd: "/repo", requestedKind: "git" });
      const second = yield* registry.resolve({ cwd: "/repo", requestedKind: "git" });

      assert.equal(first.repository.rootPath, "/repo");
      assert.equal(second.repository.rootPath, "/repo");
      assert.deepStrictEqual(
        calls.map((call) => normalizeGitArgs(call.args).join(" ")),
        [
          "rev-parse --is-bare-repository --is-inside-work-tree",
          "rev-parse --git-common-dir",
          "rev-parse --show-toplevel",
        ],
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("detects a repository created after a negative lookup", () => {
    let probeChecks = 0;
    const layer = Layer.effect(VcsDriverRegistry.VcsDriverRegistry, VcsDriverRegistry.make).pipe(
      Layer.provide(NodeServices.layer),
      Layer.provide(
        Layer.mock(VcsProjectConfig.VcsProjectConfig)({
          resolveKind: (input) => Effect.succeed(input.requestedKind ?? "auto"),
        }),
      ),
      Layer.provide(
        Layer.mock(VcsProcess.VcsProcess)({
          run: (input) =>
            Effect.sync(() => {
              const command = normalizeGitArgs(input.args).join(" ");
              if (command === "rev-parse --is-bare-repository --is-inside-work-tree") {
                probeChecks += 1;
                return probeChecks === 1
                  ? {
                      ...processOutput(""),
                      exitCode: ChildProcessSpawner.ExitCode(128),
                      stderr: "fatal: not a git repository",
                    }
                  : processOutput("false\ntrue\n");
              }
              if (command === "rev-parse --show-toplevel") {
                return processOutput("/repo\n");
              }
              if (command === "rev-parse --git-common-dir") {
                return processOutput("/repo/.git\n");
              }
              return processOutput("");
            }),
        }),
      ),
    );

    return Effect.gen(function* () {
      const registry = yield* VcsDriverRegistry.VcsDriverRegistry;

      assert.equal(yield* registry.detect({ cwd: "/repo" }), null);
      // Negative detects are TTL-cached (15s); advance so a later repo creation is noticed.
      yield* TestClock.adjust("16 seconds");
      assert.equal((yield* registry.detect({ cwd: "/repo" }))?.repository.rootPath, "/repo");
      assert.equal(probeChecks, 2);
    }).pipe(Effect.provide(Layer.mergeAll(layer, TestClock.layer())));
  });

  it.effect("fresh detect sees a repository created during a negative cache TTL", () => {
    let probeChecks = 0;
    const layer = Layer.effect(VcsDriverRegistry.VcsDriverRegistry, VcsDriverRegistry.make).pipe(
      Layer.provide(NodeServices.layer),
      Layer.provide(
        Layer.mock(VcsProjectConfig.VcsProjectConfig)({
          resolveKind: (input) => Effect.succeed(input.requestedKind ?? "auto"),
        }),
      ),
      Layer.provide(
        Layer.mock(VcsProcess.VcsProcess)({
          run: (input) =>
            Effect.sync(() => {
              const command = normalizeGitArgs(input.args).join(" ");
              if (command === "rev-parse --is-bare-repository --is-inside-work-tree") {
                probeChecks += 1;
                return probeChecks === 1
                  ? {
                      ...processOutput(""),
                      exitCode: ChildProcessSpawner.ExitCode(128),
                      stderr: "fatal: not a git repository",
                    }
                  : processOutput("false\ntrue\n");
              }
              if (command === "rev-parse --show-toplevel") {
                return processOutput("/repo\n");
              }
              if (command === "rev-parse --git-common-dir") {
                return processOutput("/repo/.git\n");
              }
              return processOutput("");
            }),
        }),
      ),
    );

    return Effect.gen(function* () {
      const registry = yield* VcsDriverRegistry.VcsDriverRegistry;

      assert.equal(yield* registry.detect({ cwd: "/repo" }), null);
      assert.equal(
        (yield* registry.detect({ cwd: "/repo", fresh: true }))?.repository.rootPath,
        "/repo",
      );
      // One probe per detect: the combined rev-parse keeps negative detection
      // to a single git call.
      assert.equal(probeChecks, 2);
    }).pipe(Effect.provide(Layer.mergeAll(layer, TestClock.layer())));
  });
});
