import type {
  OrchestrationV2ThreadProjection,
  SessionIdentityClaim,
  SourceRef,
  ThreadId,
} from "@t3tools/contracts";

export type AttributionRepairProjection = {
  readonly thread: Pick<
    OrchestrationV2ThreadProjection["thread"],
    "id" | "creationSource" | "lineage" | "originSource"
  >;
  readonly messages: ReadonlyArray<
    Pick<OrchestrationV2ThreadProjection["messages"][number], "id" | "role">
  >;
};

/** Stored MCP message ids include the authenticated session namespace, not a client label. */
export function hasMcpSessionProvenance(
  projection: AttributionRepairProjection,
  sessionId: string,
): boolean {
  const prefix = `message:mcp:${encodeURIComponent(`client:${sessionId}`)}:`;
  return (
    projection.thread.creationSource === "mcp" &&
    projection.messages.some((message) => message.role === "user" && message.id.startsWith(prefix))
  );
}

/** Validate the whole requested batch before issuing any durable repair events. */
export function planThreadAttributionRepair(input: {
  readonly claim: SessionIdentityClaim;
  readonly projections: ReadonlyMap<ThreadId, AttributionRepairProjection>;
  readonly threadIds: ReadonlyArray<ThreadId>;
}): ReadonlyArray<{ readonly threadId: ThreadId; readonly source: SourceRef }> {
  const source: SourceRef = {
    channel: "bot",
    personId: input.claim.personId,
    username: input.claim.username,
  };
  return [...new Set(input.threadIds)].flatMap((threadId) => {
    const projection = input.projections.get(threadId);
    if (!projection) throw new Error(`Missing thread ${threadId}.`);
    const root = input.projections.get(projection.thread.lineage.rootThreadId);
    if (
      !hasMcpSessionProvenance(projection, input.claim.sessionId) &&
      (!root || !hasMcpSessionProvenance(root, input.claim.sessionId))
    ) {
      throw new Error(`Thread ${threadId} has no recorded launch provenance for this MCP session.`);
    }
    const current = projection.thread.originSource;
    if (current?.personId != null) {
      if (current.personId !== input.claim.personId) {
        throw new Error(`Thread ${threadId} is already attributed to another person.`);
      }
      return [];
    }
    return [{ threadId, source: { ...current, ...source } }];
  });
}
