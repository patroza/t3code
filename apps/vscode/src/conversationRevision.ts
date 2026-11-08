interface ConversationRevisionThread {
  readonly id: string;
  readonly messages: ReadonlyArray<unknown>;
  readonly toolCalls: ReadonlyArray<unknown>;
  readonly resolvedUserInputs: ReadonlyArray<unknown>;
  readonly proposedPlans: ReadonlyArray<unknown>;
}

export function conversationRenderRevision(input: {
  readonly draft: boolean;
  readonly thread: ConversationRevisionThread | null;
}): string {
  return JSON.stringify({
    draft: input.draft,
    thread:
      input.thread === null
        ? null
        : {
            id: input.thread.id,
            messages: input.thread.messages,
            toolCalls: input.thread.toolCalls,
            resolvedUserInputs: input.thread.resolvedUserInputs,
            proposedPlans: input.thread.proposedPlans,
          },
  });
}
