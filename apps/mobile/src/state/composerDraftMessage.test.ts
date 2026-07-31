import { describe, expect, it } from "vite-plus/test";

import { hasComposerDraftMessage } from "./use-composer-drafts";

describe("hasComposerDraftMessage", () => {
  it("is false for empty or settings-only drafts", () => {
    expect(hasComposerDraftMessage(undefined)).toBe(false);
    expect(hasComposerDraftMessage({ text: "", attachments: [] })).toBe(false);
    expect(hasComposerDraftMessage({ text: "   ", attachments: [] })).toBe(false);
    expect(
      hasComposerDraftMessage({
        text: "",
        attachments: [],
        modelSelection: { instanceId: "codex", model: "gpt" } as never,
      }),
    ).toBe(false);
  });

  it("is true for text or attachments", () => {
    expect(hasComposerDraftMessage({ text: "hello", attachments: [] })).toBe(true);
    expect(
      hasComposerDraftMessage({
        text: "",
        attachments: [{ id: "a1" } as never],
      }),
    ).toBe(true);
  });
});
