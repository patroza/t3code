import { describe, expect, it } from "vite-plus/test";

import { hasComposerDraftMessage } from "./composerDraftStore";

const emptyDraft = {
  prompt: "",
  images: [] as const,
  persistedAttachments: [] as const,
  terminalContexts: [] as const,
  elementContexts: [] as const,
  previewAnnotations: [] as const,
  reviewComments: [] as const,
};

describe("hasComposerDraftMessage", () => {
  it("is false for missing or empty drafts", () => {
    expect(hasComposerDraftMessage(null)).toBe(false);
    expect(hasComposerDraftMessage(undefined)).toBe(false);
    expect(hasComposerDraftMessage(emptyDraft)).toBe(false);
    expect(hasComposerDraftMessage({ ...emptyDraft, prompt: "   " })).toBe(false);
  });

  it("is true when prompt or attachments have content", () => {
    expect(hasComposerDraftMessage({ ...emptyDraft, prompt: "hello" })).toBe(true);
    expect(
      hasComposerDraftMessage({
        ...emptyDraft,
        images: [{ id: "1" } as never],
      }),
    ).toBe(true);
    expect(
      hasComposerDraftMessage({
        ...emptyDraft,
        persistedAttachments: [{ id: "1" } as never],
      }),
    ).toBe(true);
    expect(
      hasComposerDraftMessage({
        ...emptyDraft,
        terminalContexts: [{ id: "t1" } as never],
      }),
    ).toBe(true);
  });
});
