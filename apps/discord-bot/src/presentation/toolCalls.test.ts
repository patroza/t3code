import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import { TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { countTurnToolCalls } from "./toolCalls.ts";

function activity(
  input: Omit<Partial<OrchestrationThreadActivity>, "id" | "kind"> & {
    readonly id: string;
    readonly kind: string;
  },
): OrchestrationThreadActivity {
  return {
    tone: "tool",
    summary: "Tool call",
    payload: {},
    turnId: null,
    createdAt: "2026-07-10T00:00:00.000Z",
    ...input,
  } as OrchestrationThreadActivity;
}

describe("countTurnToolCalls", () => {
  it("returns 0 when there are no tool activities", () => {
    expect(
      countTurnToolCalls([activity({ id: "m1", kind: "message.created", tone: "info" })], null),
    ).toBe(0);
  });

  it("collapses lifecycle updates for the same toolCallId even when not consecutive", () => {
    expect(
      countTurnToolCalls(
        [
          activity({
            id: "a-start",
            kind: "tool.updated",
            sequence: 1,
            createdAt: "2026-07-10T00:00:01.000Z",
            payload: { itemType: "command_execution", data: { toolCallId: "call-a" } },
          }),
          activity({
            id: "b",
            kind: "tool.completed",
            sequence: 2,
            createdAt: "2026-07-10T00:00:02.000Z",
            payload: { itemType: "command_execution", data: { toolCallId: "call-b" } },
          }),
          activity({
            id: "a-done",
            kind: "tool.completed",
            sequence: 3,
            createdAt: "2026-07-10T00:00:03.000Z",
            payload: {
              itemType: "command_execution",
              title: "Ran command",
              data: { toolCallId: "call-a" },
            },
          }),
        ],
        null,
      ),
    ).toBe(2);
  });

  it("counts distinct tool calls", () => {
    expect(
      countTurnToolCalls(
        [
          activity({
            id: "a",
            kind: "tool.completed",
            sequence: 1,
            payload: { itemType: "dynamic_tool_call", data: { toolCallId: "t1" } },
          }),
          activity({
            id: "b",
            kind: "tool.completed",
            sequence: 2,
            payload: { itemType: "dynamic_tool_call", data: { toolCallId: "t2" } },
          }),
          activity({
            id: "c",
            kind: "tool.updated",
            sequence: 3,
            payload: { itemType: "mcp_tool_call", data: { toolCallId: "t3" } },
          }),
        ],
        null,
      ),
    ).toBe(3);
  });

  it("scopes strictly to the latest turn (ignores null-turn noise)", () => {
    const turnA = TurnId.make("turn-a");
    const turnB = TurnId.make("turn-b");
    expect(
      countTurnToolCalls(
        [
          activity({
            id: "orphan",
            kind: "tool.completed",
            turnId: null,
            sequence: 0,
            payload: { data: { toolCallId: "orphan-1" } },
          }),
          activity({
            id: "old",
            kind: "tool.completed",
            turnId: turnA,
            sequence: 1,
            payload: { data: { toolCallId: "old-1" } },
          }),
          activity({
            id: "new-1",
            kind: "tool.completed",
            turnId: turnB,
            sequence: 2,
            payload: { data: { toolCallId: "new-1" } },
          }),
          activity({
            id: "new-2",
            kind: "tool.updated",
            turnId: turnB,
            sequence: 3,
            payload: { data: { toolCallId: "new-2" } },
          }),
        ],
        turnB,
      ),
    ).toBe(2);
  });

  it("counts only tools after the last settled assistant (latest in-progress segment)", () => {
    const turn = TurnId.make("turn-1");
    expect(
      countTurnToolCalls(
        [
          activity({
            id: "early-1",
            kind: "tool.completed",
            turnId: turn,
            sequence: 10,
            createdAt: "2026-07-10T00:00:10.000Z",
            payload: { data: { toolCallId: "early-1" } },
          }),
          activity({
            id: "early-2",
            kind: "tool.completed",
            turnId: turn,
            sequence: 11,
            createdAt: "2026-07-10T00:00:11.000Z",
            payload: { data: { toolCallId: "early-2" } },
          }),
          // Settled intermediate assistant lands at seq 20
          activity({
            id: "late-1",
            kind: "tool.completed",
            turnId: turn,
            sequence: 30,
            createdAt: "2026-07-10T00:00:30.000Z",
            payload: { data: { toolCallId: "late-1" } },
          }),
          activity({
            id: "late-2",
            kind: "tool.updated",
            turnId: turn,
            sequence: 31,
            createdAt: "2026-07-10T00:00:31.000Z",
            payload: { data: { toolCallId: "late-2" } },
          }),
          activity({
            id: "late-2-done",
            kind: "tool.completed",
            turnId: turn,
            sequence: 32,
            createdAt: "2026-07-10T00:00:32.000Z",
            payload: { data: { toolCallId: "late-2" } },
          }),
        ],
        turn,
        [
          {
            role: "user",
            turnId: turn,
            createdAt: "2026-07-10T00:00:01.000Z",
            sequence: 1,
          },
          {
            role: "assistant",
            turnId: turn,
            streaming: false,
            createdAt: "2026-07-10T00:00:20.000Z",
            sequence: 20,
          },
          {
            role: "assistant",
            turnId: turn,
            streaming: true,
            createdAt: "2026-07-10T00:00:25.000Z",
            sequence: 25,
          },
        ],
      ),
    ).toBe(2);
  });

  it("counts the whole turn when no settled assistant exists yet", () => {
    const turn = TurnId.make("turn-1");
    expect(
      countTurnToolCalls(
        [
          activity({
            id: "t1",
            kind: "tool.completed",
            turnId: turn,
            sequence: 2,
            payload: { data: { toolCallId: "t1" } },
          }),
          activity({
            id: "t2",
            kind: "tool.updated",
            turnId: turn,
            sequence: 3,
            payload: { data: { toolCallId: "t2" } },
          }),
        ],
        turn,
        [{ role: "user", turnId: turn, createdAt: "2026-07-10T00:00:01.000Z", sequence: 1 }],
      ),
    ).toBe(2);
  });

  it("ignores older segments after multiple settled assistants (never whole-turn accumulation)", () => {
    // Regression: completed answers re-synced as Working showed inflated counts like
    // "81 tool calls" by counting every tool before the latest work segment.
    const turn = TurnId.make("turn-1");
    const manyEarly = Array.from({ length: 80 }, (_, index) =>
      activity({
        id: `early-${index}`,
        kind: "tool.completed",
        turnId: turn,
        sequence: index + 1,
        createdAt: `2026-07-10T00:00:${String(index + 1).padStart(2, "0")}.000Z`,
        payload: { data: { toolCallId: `early-${index}` } },
      }),
    );
    expect(
      countTurnToolCalls(
        [
          ...manyEarly,
          activity({
            id: "late-only",
            kind: "tool.updated",
            turnId: turn,
            sequence: 200,
            createdAt: "2026-07-10T00:03:00.000Z",
            payload: { data: { toolCallId: "late-only" } },
          }),
        ],
        turn,
        [
          {
            role: "assistant",
            turnId: turn,
            streaming: false,
            createdAt: "2026-07-10T00:02:00.000Z",
            sequence: 100,
          },
          {
            role: "assistant",
            turnId: turn,
            streaming: true,
            createdAt: "2026-07-10T00:02:30.000Z",
            sequence: 150,
          },
        ],
      ),
    ).toBe(1);
  });
});
