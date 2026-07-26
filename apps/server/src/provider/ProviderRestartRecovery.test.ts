import { ModelSelection, ProviderInstanceId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  makeProviderRestartRecoveryMarker,
  readPersistedProviderCwd,
  readPersistedProviderInteractionMode,
  readPersistedProviderModelSelection,
  readProviderRestartRecoveryCandidate,
} from "./ProviderRestartRecovery.ts";

describe("ProviderRestartRecovery", () => {
  it("reads typed recovery metadata and persisted restart settings", () => {
    const modelSelection: ModelSelection = {
      instanceId: ProviderInstanceId.make("codex-work"),
      model: "gpt-5.4",
      options: [{ id: "reasoningEffort", value: "high" }],
    };
    const marker = makeProviderRestartRecoveryMarker({
      interruptedProviderTurnId: TurnId.make("turn-interrupted"),
      shutdownAt: "2026-07-22T00:00:00.000Z",
    });
    const runtimePayload = {
      cwd: " /tmp/project ",
      modelSelection,
      interactionMode: "plan",
      restartRecovery: marker,
    };

    expect(
      readProviderRestartRecoveryCandidate({
        runtimePayload,
        status: "stopped",
        lastSeenAt: "2026-07-22T00:00:01.000Z",
      }),
    ).toEqual({ ...marker, source: "marker" });
    expect(readPersistedProviderCwd(runtimePayload)).toBe("/tmp/project");
    expect(readPersistedProviderModelSelection(runtimePayload)).toEqual(modelSelection);
    expect(readPersistedProviderInteractionMode(runtimePayload)).toBe("plan");
  });

  it("recognizes crash-style legacy running rows with an active turn", () => {
    expect(
      readProviderRestartRecoveryCandidate({
        runtimePayload: { activeTurnId: TurnId.make("turn-before-crash") },
        status: "running",
        lastSeenAt: "2026-07-22T00:00:00.000Z",
      }),
    ).toEqual({
      version: 1,
      interruptedProviderTurnId: TurnId.make("turn-before-crash"),
      shutdownAt: "2026-07-22T00:00:00.000Z",
      source: "legacy-active-turn",
    });
  });

  it("does not recover idle, stopped, or malformed legacy rows", () => {
    expect(
      readProviderRestartRecoveryCandidate({
        runtimePayload: { activeTurnId: TurnId.make("turn-ready") },
        status: "stopped",
        lastSeenAt: "2026-07-22T00:00:00.000Z",
      }),
    ).toBeUndefined();
    expect(
      readProviderRestartRecoveryCandidate({
        runtimePayload: { activeTurnId: null },
        status: "running",
        lastSeenAt: "2026-07-22T00:00:00.000Z",
      }),
    ).toBeUndefined();
  });
});
