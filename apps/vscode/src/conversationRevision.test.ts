import { describe, expect, it } from "vite-plus/test";

import { conversationRenderRevision } from "./conversationRevision.ts";

const conversation = {
  draft: false,
  thread: {
    id: "thread-1",
    messages: [{ id: "message-1", text: "Selectable text" }],
    toolCalls: [],
    resolvedUserInputs: [],
    proposedPlans: [],
  },
} as const;

describe("conversationRenderRevision", () => {
  it("stays stable when unrelated view state changes", () => {
    const before = { ...conversation, busy: false, usage: null };
    const after = { ...conversation, busy: true, usage: { primary: 42 } };

    expect(conversationRenderRevision(before)).toBe(conversationRenderRevision(after));
  });

  it("changes when rendered conversation content changes", () => {
    const changed = {
      ...conversation,
      thread: {
        ...conversation.thread,
        messages: [{ id: "message-1", text: "Updated text" }],
      },
    };

    expect(conversationRenderRevision(conversation)).not.toBe(conversationRenderRevision(changed));
  });
});
