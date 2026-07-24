import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as EffectAcpErrors from "effect-acp/errors";

import {
  applyGrokAcpModelSelection,
  buildGrokAcpSpawnInput,
  resolveGrokAcpBaseModelId,
  resolveGrokReasoningEffortFromModelSelection,
  resolveGrokReasoningEffortSelection,
} from "./GrokAcpSupport.ts";

describe("resolveGrokAcpBaseModelId", () => {
  it("normalizes empty and custom Grok model ids", () => {
    expect(resolveGrokAcpBaseModelId(undefined)).toBe("grok-build");
    expect(resolveGrokAcpBaseModelId("   ")).toBe("grok-build");
    expect(resolveGrokAcpBaseModelId("  grok-test-custom-model  ")).toBe("grok-test-custom-model");
  });
});

describe("buildGrokAcpSpawnInput", () => {
  it("passes the T3 Code referrer through Grok OAuth env", () => {
    const spawn = buildGrokAcpSpawnInput({ binaryPath: "/usr/local/bin/grok" }, "/tmp/project", {
      XAI_API_KEY: "secret",
      GROK_OAUTH2_REFERRER: "other-client",
    });

    expect(spawn).toEqual({
      command: "/usr/local/bin/grok",
      args: ["agent", "stdio"],
      cwd: "/tmp/project",
      env: {
        XAI_API_KEY: "secret",
        GROK_OAUTH2_REFERRER: "t3code",
      },
      extendEnv: false,
    });
  });

  it("forwards reasoning effort as a process-level agent flag", () => {
    const spawn = buildGrokAcpSpawnInput({ binaryPath: "grok" }, "/tmp/project", undefined, {
      reasoningEffort: "medium",
    });
    expect(spawn.args).toEqual(["agent", "--reasoning-effort", "medium", "stdio"]);
  });

  it("ignores unknown effort values on spawn", () => {
    const spawn = buildGrokAcpSpawnInput({ binaryPath: "grok" }, "/tmp/project", undefined, {
      reasoningEffort: "turbo",
    });
    expect(spawn.args).toEqual(["agent", "stdio"]);
  });
});

describe("resolveGrokReasoningEffortSelection", () => {
  it("reads reasoningEffort and effort option ids", () => {
    expect(resolveGrokReasoningEffortSelection([{ id: "reasoningEffort", value: "High" }])).toBe(
      "high",
    );
    expect(resolveGrokReasoningEffortSelection([{ id: "effort", value: "low" }])).toBe("low");
    expect(resolveGrokReasoningEffortSelection([{ id: "reasoningEffort", value: "nope" }])).toBe(
      undefined,
    );
  });

  it("reads effort from a model selection", () => {
    expect(
      resolveGrokReasoningEffortFromModelSelection({
        instanceId: "grok" as never,
        model: "grok-4.5",
        options: [{ id: "reasoningEffort", value: "medium" }],
      }),
    ).toBe("medium");
  });
});

describe("applyGrokAcpModelSelection", () => {
  const makeRecordingRuntime = (failure?: EffectAcpErrors.AcpError) => {
    const modelCalls: Array<string> = [];
    const modeCalls: Array<string> = [];
    const runtime = {
      setSessionModel: (modelId: string) =>
        Effect.gen(function* () {
          modelCalls.push(modelId);
          if (failure) return yield* failure;
          return {};
        }),
      setMode: (modeId: string) =>
        Effect.gen(function* () {
          modeCalls.push(modeId);
          if (failure) return yield* failure;
          return {};
        }),
    };
    return { runtime, modelCalls, modeCalls };
  };

  it.effect("calls session/set_model when the requested model differs from current", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyGrokAcpModelSelection({
        runtime,
        currentModelId: "grok-build",
        requestedModelId: "grok-mock-alt",
        mapError: (context) => context.cause.message,
      });
      expect(modelCalls).toEqual(["grok-mock-alt"]);
      expect(result).toBe("grok-mock-alt");
    }),
  );

  it.effect("skips set_model when requested matches current", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyGrokAcpModelSelection({
        runtime,
        currentModelId: "grok-build",
        requestedModelId: "grok-build",
        mapError: (context) => context.cause.message,
      });
      expect(modelCalls).toEqual([]);
      expect(result).toBe("grok-build");
    }),
  );

  it.effect("skips set_model when no model is requested", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyGrokAcpModelSelection({
        runtime,
        currentModelId: "grok-build",
        requestedModelId: undefined,
        mapError: (context) => context.cause.message,
      });
      expect(modelCalls).toEqual([]);
      expect(result).toBe("grok-build");
    }),
  );

  it.effect("applies reasoning effort through session/set_mode", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls, modeCalls } = makeRecordingRuntime();
      const result = yield* applyGrokAcpModelSelection({
        runtime,
        currentModelId: "grok-4.5",
        requestedModelId: "grok-4.5",
        selections: [{ id: "reasoningEffort", value: "medium" }],
        mapError: (context) => context.cause.message,
      });
      expect(modelCalls).toEqual([]);
      expect(modeCalls).toEqual(["medium"]);
      expect(result).toBe("grok-4.5");
    }),
  );

  it.effect("skips effort when applyReasoningEffort is false", () =>
    Effect.gen(function* () {
      const { runtime, modeCalls } = makeRecordingRuntime();
      yield* applyGrokAcpModelSelection({
        runtime,
        currentModelId: "grok-4.5",
        requestedModelId: "grok-4.5",
        selections: [{ id: "reasoningEffort", value: "low" }],
        applyReasoningEffort: false,
        mapError: (context) => context.cause.message,
      });
      expect(modeCalls).toEqual([]);
    }),
  );

  it.effect("propagates session/set_model failures via mapError", () =>
    Effect.gen(function* () {
      const failure = EffectAcpErrors.AcpRequestError.invalidParams("session id not known");
      const { runtime } = makeRecordingRuntime(failure);
      const error = yield* Effect.flip(
        applyGrokAcpModelSelection({
          runtime,
          currentModelId: "grok-build",
          requestedModelId: "grok-mock-alt",
          mapError: (context) => context.cause.message,
        }),
      );
      expect(error).toBe(failure.message);
    }),
  );
});
