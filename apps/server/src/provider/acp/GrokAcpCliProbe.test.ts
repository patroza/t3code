/**
 * Optional integration check against a real `grok agent stdio` install.
 * Enable with: T3_GROK_ACP_PROBE=1 bun run test GrokAcpCliProbe
 *
 * The probe assumes either `XAI_API_KEY` is set in the environment or
 * the user has previously run `grok login`. Without credentials the
 * agent's `authenticate` request will fail and the test will surface
 * the error.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect } from "vite-plus/test";

import type { AcpSessionRuntimeEvent } from "./AcpSessionRuntime.ts";
import { makeGrokAcpRuntime } from "./GrokAcpSupport.ts";

const makeProbeRuntime = Effect.gen(function* () {
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* makeGrokAcpRuntime({
    grokSettings: { binaryPath: "grok" },
    environment: process.env,
    childProcessSpawner,
    cwd: process.cwd(),
    clientInfo: { name: "t3-grok-probe", version: "0.0.0" },
  });
});

describe.runIf(process.env.T3_GROK_ACP_PROBE === "1")("Grok ACP CLI probe", () => {
  it.effect("initialize and authenticate against real grok agent stdio", () =>
    Effect.gen(function* () {
      const runtime = yield* makeProbeRuntime;
      const started = yield* runtime.start();
      expect(started.initializeResult).toBeDefined();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("session/new advertises typed SessionModelState with at least one model", () =>
    Effect.gen(function* () {
      const runtime = yield* makeProbeRuntime;
      const started = yield* runtime.start();
      const result = started.sessionSetupResult;

      expect(typeof started.sessionId).toBe("string");

      // Modern grok-shell advertises models through the typed
      // `SessionModelState` field, not via a `configOptions` entry.
      // If this assertion fails the upstream surface has regressed.
      const models = result.models;
      expect(models).toBeDefined();
      expect(typeof models?.currentModelId).toBe("string");
      expect(models?.availableModels.length ?? 0).toBeGreaterThan(0);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("session/set_model accepts a no-op switch to the current model", () =>
    Effect.gen(function* () {
      const runtime = yield* makeProbeRuntime;
      const started = yield* runtime.start();
      const currentModelId = started.sessionSetupResult.models?.currentModelId?.trim();
      expect(currentModelId).toBeDefined();
      if (!currentModelId) return;

      // No-op switch — selecting the model the session already runs on must
      // succeed against every Grok build that implements `session/set_model`.
      yield* runtime.setSessionModel(currentModelId);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  // A steer on an idle session has no turn to cancel; it must still answer
  // normally, so the adapter can steer without first proving the agent is busy.
  it.live("answers a steering prompt sent to an idle session", () =>
    Effect.gen(function* () {
      const runtime = yield* makeProbeRuntime;
      yield* runtime.start();

      const response = yield* runtime
        .prompt(
          {
            prompt: [{ type: "text", text: "Reply with the single word READY and nothing else." }],
          },
          { steer: true },
        )
        .pipe(Effect.timeout("60 seconds"));

      expect(response.stopReason).toBe("end_turn");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  // Steering contract: a `steer` prompt must reach a busy agent and take over.
  // Grok queues a plain mid-turn prompt behind the whole running turn, so
  // without `_meta.sendNow` (set by `makeXAiPromptCompletionRuntime`) the steer
  // only runs once the original turn has finished — the bug this guards.
  it.live(
    "a steering prompt cancels the running turn and is answered next",
    () =>
      Effect.gen(function* () {
        const runtime = yield* makeProbeRuntime;
        yield* runtime.start();

        const events: Array<AcpSessionRuntimeEvent> = [];
        yield* Stream.runForEach(runtime.getEvents(), (event) =>
          event._tag === "EventStreamBarrier"
            ? Effect.asVoid(Deferred.succeed(event.acknowledge, undefined))
            : Effect.sync(() => {
                events.push(event);
              }),
        ).pipe(Effect.forkChild({ startImmediately: true }));

        const longTurnFiber = yield* runtime
          .prompt({
            prompt: [
              {
                type: "text",
                text: "Without using any tools, write a comprehensive 3000-word essay on the history of programming languages. Do not stop early unless instructed.",
              },
            ],
          })
          .pipe(Effect.forkChild({ startImmediately: true }));

        // Let the essay turn get going before steering into it.
        yield* Effect.sleep("8 seconds");

        const steerFiber = yield* runtime
          .prompt(
            {
              prompt: [
                {
                  type: "text",
                  text: "Stop the essay immediately. Reply with the word STEERED, then an underscore, then the word OK, as one token, and nothing else.",
                },
              ],
            },
            { steer: true },
          )
          .pipe(Effect.forkChild({ startImmediately: true }));

        // The steered-into turn is cancelled by the agent, not by us.
        const interruptedResponse = yield* Fiber.join(longTurnFiber).pipe(
          Effect.timeout("120 seconds"),
        );
        const steerResponse = yield* Fiber.join(steerFiber).pipe(Effect.timeout("120 seconds"));

        // Grok streams the reply in chunks ("STEERED", "_", "OK"), so the
        // deltas have to be concatenated before matching the token.
        const assistantText = () =>
          events.flatMap((event) => (event._tag === "ContentDelta" ? [event.text] : [])).join("");
        let steeredSeen = assistantText().includes("STEERED_OK");
        for (let attempt = 0; attempt < 15 && !steeredSeen; attempt += 1) {
          yield* Effect.sleep("2 seconds");
          steeredSeen = assistantText().includes("STEERED_OK");
        }

        expect(interruptedResponse.stopReason).toBe("cancelled");
        expect(steerResponse.stopReason).toBe("end_turn");
        expect(steeredSeen).toBe(true);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    { timeout: 240_000 },
  );
});
