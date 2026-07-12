import { type OrchestrationThreadActivity, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { presentToolCalls } from "./toolPresentation.ts";

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

describe("presentToolCalls", () => {
  it("collapses lifecycle updates and retains completed command details", () => {
    expect(
      presentToolCalls([
        activity({
          id: "start",
          kind: "tool.updated",
          payload: { itemType: "command_execution", data: { toolCallId: "call-1" } },
        }),
        activity({
          id: "done",
          kind: "tool.completed",
          payload: {
            itemType: "command_execution",
            title: "Ran command",
            data: { toolCallId: "call-1", item: { command: ["vp", "check"] } },
          },
        }),
      ]),
    ).toEqual([
      expect.objectContaining({
        id: "done",
        title: "Ran command",
        status: "completed",
        preview: "vp check",
        detail: "vp check",
      }),
    ]);
  });

  it("preserves MCP input and result JSON for expansion", () => {
    const [tool] = presentToolCalls([
      activity({
        id: "mcp",
        kind: "tool.completed",
        summary: "t3-code · preview_status",
        payload: {
          itemType: "mcp_tool_call",
          data: { item: { tool: "preview_status", arguments: {}, result: "attached" } },
        },
      }),
    ]);
    expect(tool?.detail).toContain('"tool": "preview_status"');
    expect(tool?.status).toBe("completed");
  });

  it("omits non-tool activities", () => {
    expect(presentToolCalls([activity({ id: "message", kind: "message.created" })])).toEqual([]);
  });

  it("collects and deduplicates nested changed file paths", () => {
    const [tool] = presentToolCalls([
      activity({
        id: "files",
        kind: "tool.completed",
        summary: "File change",
        payload: {
          itemType: "file_change",
          data: {
            item: {
              changes: [
                { path: "src/one.ts" },
                { filename: "src/two.ts" },
                { newPath: "src/one.ts" },
              ],
            },
          },
        },
      }),
    ]);
    expect(tool?.changedFiles).toEqual(["src/one.ts", "src/two.ts"]);
    expect(tool?.preview).toBe("2 changed files");
  });

  it("settles orphan tool updates when their turn has completed", () => {
    const orphan = activity({
      id: "orphan-progress",
      kind: "tool.updated",
      turnId: TurnId.make("old-turn"),
      summary: "Tool updated",
    });
    expect(
      presentToolCalls([orphan], {
        latestTurn: { turnId: "newer-turn", completedAt: null },
        session: { status: "running", activeTurnId: "newer-turn" },
      })[0]?.status,
    ).toBe("completed");
    expect(
      presentToolCalls([orphan], {
        latestTurn: { turnId: "old-turn", completedAt: null },
        session: { status: "running", activeTurnId: "old-turn" },
      })[0]?.status,
    ).toBe("running");
  });
});
