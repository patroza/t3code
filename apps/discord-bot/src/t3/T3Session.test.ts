import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { shouldPersistThreadModelSelectionForNextTurn } from "./T3Session.ts";

describe("shouldPersistThreadModelSelectionForNextTurn", () => {
  it("returns false when no explicit model selection is provided", () => {
    expect(
      shouldPersistThreadModelSelectionForNextTurn({
        currentModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
      }),
    ).toBe(false);
  });

  it("returns true when the model changes", () => {
    expect(
      shouldPersistThreadModelSelectionForNextTurn({
        currentModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
        nextModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.5",
        },
      }),
    ).toBe(true);
  });

  it("returns false when the model selection is unchanged", () => {
    expect(
      shouldPersistThreadModelSelectionForNextTurn({
        currentModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.5",
        },
        nextModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.5",
        },
      }),
    ).toBe(false);
  });
});
