import { ModelSelection, ProviderInstanceId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  readPersistedProviderActiveTurnId,
  readPersistedProviderCwd,
  readPersistedProviderInteractionMode,
  readPersistedProviderModelSelection,
} from "./ProviderRestartRecovery.ts";

describe("ProviderRestartRecovery", () => {
  it("reads persisted session fields from the runtime payload", () => {
    const modelSelection: ModelSelection = {
      instanceId: ProviderInstanceId.make("codex-work"),
      model: "gpt-5.4",
      options: [{ id: "reasoningEffort", value: "high" }],
    };
    const runtimePayload = {
      cwd: " /tmp/project ",
      modelSelection,
      interactionMode: "plan",
      activeTurnId: TurnId.make("turn-live"),
    };

    expect(readPersistedProviderCwd(runtimePayload)).toBe("/tmp/project");
    expect(readPersistedProviderModelSelection(runtimePayload)).toEqual(modelSelection);
    expect(readPersistedProviderInteractionMode(runtimePayload)).toBe("plan");
    expect(readPersistedProviderActiveTurnId(runtimePayload)).toBe(TurnId.make("turn-live"));
  });

  it("ignores missing or malformed payload fields", () => {
    expect(readPersistedProviderCwd(null)).toBeUndefined();
    expect(readPersistedProviderCwd({ cwd: "   " })).toBeUndefined();
    expect(readPersistedProviderModelSelection({})).toBeUndefined();
    expect(readPersistedProviderInteractionMode({ interactionMode: "nope" })).toBeUndefined();
    expect(readPersistedProviderActiveTurnId({ activeTurnId: null })).toBeUndefined();
  });
});
