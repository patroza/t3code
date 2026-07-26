import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as TestClock from "effect/testing/TestClock";

import { OpenCodeRuntime, OpenCodeRuntimeLive } from "./opencodeRuntime.ts";

it.effect("launches a local OpenCode server with the project cwd and final environment", () => {
  let spawnedCommand: unknown;
  const spawner = ChildProcessSpawner.make((command) => {
    spawnedCommand = command;
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(987_654),
        exitCode: Effect.never,
        isRunning: Effect.succeed(true),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.encodeText(
          Stream.make("opencode server listening on http://127.0.0.1:4310\n"),
        ),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    );
  });
  const runtimeLayer = OpenCodeRuntimeLive.pipe(
    Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
  );

  return Effect.gen(function* () {
    const runtime = yield* OpenCodeRuntime;
    const sessionScope = yield* Scope.make();
    const server = yield* runtime
      .startOpenCodeServerProcess({
        binaryPath: "/project/bin/opencode",
        cwd: "/project/worktree",
        environment: {
          PATH: "/project/bin",
          KEEP: "value",
          OPENCODE_CONFIG_CONTENT: "direnv-must-not-win",
        },
        port: 4310,
      })
      .pipe(Effect.provideService(Scope.Scope, sessionScope));

    expect(server.url).toBe("http://127.0.0.1:4310");
    const command = spawnedCommand as {
      readonly options: {
        readonly cwd?: string;
        readonly env?: NodeJS.ProcessEnv;
        readonly extendEnv?: boolean;
      };
    };
    expect(command.options.cwd).toBe("/project/worktree");
    expect(command.options.extendEnv).toBe(false);
    expect(command.options.env).toEqual({
      PATH: "/project/bin",
      KEEP: "value",
      OPENCODE_CONFIG_CONTENT: "{}",
    });
    const closeFiber = yield* Scope.close(sessionScope, Exit.void).pipe(Effect.forkChild);
    yield* TestClock.adjust("1 second");
    yield* Fiber.join(closeFiber);
  }).pipe(Effect.provide(runtimeLayer));
});
