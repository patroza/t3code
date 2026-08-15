import { ProviderDriverKind, RuntimeRequestId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpTokenUsageUpdatedEvent,
  makeAcpToolCallEvent,
  normalizeAcpPromptUsage,
  normalizeAcpUsageUpdate,
} from "./AcpCoreRuntimeEvents.ts";

describe("AcpCoreRuntimeEvents", () => {
  it("maps ACP permission requests to canonical runtime events", () => {
    const stamp = { eventId: "event-1" as never, createdAt: "2026-03-27T00:00:00.000Z" };
    const turnId = TurnId.make("turn-1");
    const permissionRequest = {
      kind: "execute" as const,
      detail: "cat package.json",
      toolCall: {
        toolCallId: "tool-1",
        kind: "execute",
        status: "pending" as const,
        command: "cat package.json",
        detail: "cat package.json",
        data: { toolCallId: "tool-1", kind: "execute" },
      },
    };

    expect(
      makeAcpRequestOpenedEvent({
        stamp,
        provider: ProviderDriverKind.make("cursor"),
        threadId: "thread-1" as never,
        turnId,
        requestId: RuntimeRequestId.make("request-1"),
        permissionRequest,
        detail: "cat package.json",
        args: { command: ["cat", "package.json"] },
        source: "acp.jsonrpc",
        method: "session/request_permission",
        rawPayload: { sessionId: "session-1" },
      }),
    ).toMatchObject({
      type: "request.opened",
      payload: {
        requestType: "exec_command_approval",
        detail: "cat package.json",
      },
    });

    expect(
      makeAcpRequestResolvedEvent({
        stamp,
        provider: ProviderDriverKind.make("cursor"),
        threadId: "thread-1" as never,
        turnId,
        requestId: RuntimeRequestId.make("request-1"),
        permissionRequest,
        decision: "accept",
      }),
    ).toMatchObject({
      type: "request.resolved",
      payload: {
        requestType: "exec_command_approval",
        decision: "accept",
      },
    });
  });

  it("maps generic ACP permission kinds to dynamic tool approvals", () => {
    const stamp = { eventId: "event-1" as never, createdAt: "2026-03-27T00:00:00.000Z" };

    for (const kind of ["search", "fetch", "other", "unknown", "future-tool-kind"]) {
      const permissionRequest = { kind };
      const request = {
        stamp,
        provider: ProviderDriverKind.make("cursor"),
        threadId: "thread-1" as never,
        turnId: TurnId.make("turn-1"),
        requestId: RuntimeRequestId.make(`request-${kind}`),
        permissionRequest,
      };

      expect(
        makeAcpRequestOpenedEvent({
          ...request,
          detail: kind,
          args: {},
          source: "acp.jsonrpc",
          method: "session/request_permission",
          rawPayload: { sessionId: "session-1" },
        }),
      ).toMatchObject({
        type: "request.opened",
        payload: { requestType: "dynamic_tool_call" },
      });

      expect(
        makeAcpRequestResolvedEvent({
          ...request,
          decision: "accept",
        }),
      ).toMatchObject({
        type: "request.resolved",
        payload: { requestType: "dynamic_tool_call" },
      });
    }
  });

  it("maps ACP core plan, tool-call, and content updates", () => {
    const stamp = { eventId: "event-1" as never, createdAt: "2026-03-27T00:00:00.000Z" };
    const turnId = TurnId.make("turn-1");

    expect(
      makeAcpPlanUpdatedEvent({
        stamp,
        provider: ProviderDriverKind.make("cursor"),
        threadId: "thread-1" as never,
        turnId,
        payload: {
          plan: [{ step: "Inspect state", status: "inProgress" }],
        },
        source: "acp.cursor.extension",
        method: "cursor/update_todos",
        rawPayload: { todos: [] },
      }),
    ).toMatchObject({
      type: "turn.plan.updated",
      raw: {
        method: "cursor/update_todos",
      },
    });

    expect(
      makeAcpToolCallEvent({
        stamp,
        provider: ProviderDriverKind.make("cursor"),
        threadId: "thread-1" as never,
        turnId,
        toolCall: {
          toolCallId: "tool-1",
          kind: "execute",
          status: "completed",
          title: "Terminal",
          detail: "bun run test",
          data: { command: "bun run test" },
        },
        rawPayload: { sessionId: "session-1" },
      }),
    ).toMatchObject({
      type: "item.completed",
      payload: {
        itemType: "command_execution",
        status: "completed",
      },
    });

    expect(
      makeAcpContentDeltaEvent({
        stamp,
        provider: ProviderDriverKind.make("cursor"),
        threadId: "thread-1" as never,
        turnId,
        itemId: "assistant:session-1:segment:0",
        text: "hello",
        rawPayload: { sessionId: "session-1" },
      }),
    ).toMatchObject({
      type: "content.delta",
      itemId: "assistant:session-1:segment:0",
      payload: {
        delta: "hello",
      },
    });

    expect(
      makeAcpAssistantItemEvent({
        stamp,
        provider: ProviderDriverKind.make("cursor"),
        threadId: "thread-1" as never,
        turnId,
        itemId: "assistant:session-1:segment:0",
        lifecycle: "item.started",
      }),
    ).toMatchObject({
      type: "item.started",
      itemId: "assistant:session-1:segment:0",
      payload: {
        itemType: "assistant_message",
        status: "inProgress",
      },
    });
  });

  it("maps _meta.totalTokens-style usage updates without a window size", () => {
    expect(normalizeAcpUsageUpdate({ used: 139_982 })).toEqual({
      usedTokens: 139_982,
      lastUsedTokens: 139_982,
    });
    expect(normalizeAcpUsageUpdate({ used: 42_000, size: 256_000 })).toEqual({
      usedTokens: 42_000,
      lastUsedTokens: 42_000,
      maxTokens: 256_000,
    });
    expect(normalizeAcpUsageUpdate({ used: 0 })).toBeUndefined();
  });

  it("maps ACP prompt usage to last in/out token fields", () => {
    expect(
      normalizeAcpPromptUsage({
        inputTokens: 1_000,
        outputTokens: 400,
        thoughtTokens: 100,
        cachedReadTokens: 200,
        totalTokens: 1_500,
      }),
    ).toEqual({
      usedTokens: 1_500,
      lastUsedTokens: 1_500,
      inputTokens: 1_000,
      lastInputTokens: 1_000,
      outputTokens: 400,
      lastOutputTokens: 400,
      reasoningOutputTokens: 100,
      lastReasoningOutputTokens: 100,
      cachedInputTokens: 200,
      lastCachedInputTokens: 200,
    });
  });

  it("builds a thread.token-usage.updated runtime event", () => {
    const stamp = { eventId: "event-1" as never, createdAt: "2026-03-27T00:00:00.000Z" };
    expect(
      makeAcpTokenUsageUpdatedEvent({
        stamp,
        provider: ProviderDriverKind.make("grok"),
        threadId: "thread-1" as never,
        turnId: TurnId.make("turn-1"),
        usage: { usedTokens: 139_982, lastUsedTokens: 139_982 },
        method: "session/update",
        rawPayload: { _meta: { totalTokens: 139_982 } },
      }),
    ).toMatchObject({
      type: "thread.token-usage.updated",
      payload: {
        usage: { usedTokens: 139_982, lastUsedTokens: 139_982 },
      },
    });
  });
});
