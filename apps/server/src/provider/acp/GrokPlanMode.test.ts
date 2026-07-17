import { describe, expect, it } from "vite-plus/test";

import {
  extractGrokPlanMarkdownFromToolWrite,
  interactionModeFromGrokAcpModeId,
  isGrokExitPlanModePermission,
  resolveGrokAcpModeIdForInteractionMode,
  resolveGrokSessionPlanMarkdownPath,
} from "./GrokPlanMode.ts";

describe("GrokPlanMode", () => {
  it("maps Grok ACP mode ids onto app interaction modes", () => {
    expect(interactionModeFromGrokAcpModeId("plan")).toBe("plan");
    expect(interactionModeFromGrokAcpModeId("Architect")).toBe("plan");
    expect(interactionModeFromGrokAcpModeId("default")).toBe("default");
    expect(interactionModeFromGrokAcpModeId("code")).toBe("default");
    expect(interactionModeFromGrokAcpModeId("agent")).toBe("default");
    expect(interactionModeFromGrokAcpModeId("high")).toBeUndefined();
  });

  it("resolves interaction modes back to Grok ACP mode ids", () => {
    expect(resolveGrokAcpModeIdForInteractionMode("plan")).toBe("plan");
    expect(resolveGrokAcpModeIdForInteractionMode("default")).toBe("default");
    expect(resolveGrokAcpModeIdForInteractionMode(undefined)).toBeUndefined();
  });

  it("detects exit_plan_mode permission requests from real Grok payloads", () => {
    expect(
      isGrokExitPlanModePermission({
        sessionId: "s1",
        toolCall: {
          toolCallId: "t1",
          title: "Plan: Exit",
          rawInput: { variant: "ExitPlanMode" },
          _meta: {
            "x.ai/tool": {
              name: "exit_plan_mode",
              kind: "exit_plan",
            },
          },
        },
        options: [],
      }),
    ).toBe(true);

    expect(
      isGrokExitPlanModePermission({
        sessionId: "s1",
        toolCall: {
          toolCallId: "t2",
          title: "run_terminal_command",
          rawInput: { command: "ls" },
        },
        options: [],
      }),
    ).toBe(false);
  });

  it("extracts plan markdown from plan.md write tool payloads", () => {
    const markdown = extractGrokPlanMarkdownFromToolWrite({
      title: "write",
      rawInput: {
        file_path:
          "/home/user/.grok/sessions/%2Ftmp%2Fproject/019f5d24-302d-74f0-917f-56a954f98e49/plan.md",
        content: "# Plan\n\n- step one\n",
      },
    });
    expect(markdown).toBe("# Plan\n\n- step one\n");
  });

  it("builds the on-disk plan.md path for a Grok session", () => {
    expect(
      resolveGrokSessionPlanMarkdownPath({
        homeDir: "/home/user",
        cwd: "/tmp/project",
        sessionId: "session-1",
      }),
    ).toBe("/home/user/.grok/sessions/%2Ftmp%2Fproject/session-1/plan.md");
  });
});
