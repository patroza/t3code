import { ScheduledTaskId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { agentSenderLabel, resolveUserMessagePresentation } from "./userMessage.ts";

describe("agentSenderLabel", () => {
  it("names the thread origin when an agent sent the message", () => {
    expect(
      agentSenderLabel({
        username: "andreasimonecosta",
        actor: { displayName: "Andrea" },
      }),
    ).toBe("Andrea's agent");
    expect(agentSenderLabel({ username: "patroza" })).toBe("patroza's agent");
  });

  it("keeps the generic caption when the thread has no person", () => {
    expect(agentSenderLabel(null)).toBe("Sent by another agent");
    expect(agentSenderLabel({ username: "  ", actor: { displayName: "" } })).toBe(
      "Sent by another agent",
    );
  });
});

describe("resolveUserMessagePresentation", () => {
  const legacyText = "[Triggered by schedule task: Daily audit]\n\nCheck for crashes.\n";

  it("removes attribution from legacy scheduled prompts", () => {
    expect(
      resolveUserMessagePresentation({ role: "user", createdBy: "agent", text: legacyText }),
    ).toEqual({ text: "Check for crashes.\n", isAutomation: true, scheduledTaskId: undefined });
  });

  it("uses task metadata without changing the prompt", () => {
    expect(
      resolveUserMessagePresentation({
        role: "user",
        createdBy: "agent",
        scheduledTaskId: ScheduledTaskId.make("task-1"),
        text: legacyText,
      }),
    ).toEqual({ text: legacyText, isAutomation: true, scheduledTaskId: "task-1" });
  });

  it("preserves user-written and assistant-quoted schedule headers", () => {
    for (const message of [
      { role: "user", createdBy: "user" as const },
      { role: "user" },
      { role: "assistant", createdBy: "agent" as const },
    ]) {
      expect(resolveUserMessagePresentation({ ...message, text: legacyText })).toEqual({
        text: legacyText,
        isAutomation: false,
        scheduledTaskId: undefined,
      });
    }
  });

  it("leaves other agent prompts and embedded headers intact", () => {
    for (const text of [
      "Review this area",
      `Quoted prompt:\n${legacyText}`,
      "[Triggered by schedule task: Daily audit]",
    ]) {
      expect(resolveUserMessagePresentation({ role: "user", createdBy: "agent", text })).toEqual({
        text,
        isAutomation: false,
        scheduledTaskId: undefined,
      });
    }
  });

  it("recovers the triggering automation from older scheduler message ids", () => {
    for (const trigger of ["scheduled", "manual"]) {
      expect(
        resolveUserMessagePresentation({
          id: `scheduled-task-message:task:daily-audit:1788661140000:${trigger}`,
          role: "user",
          createdBy: "user",
          text: legacyText,
        }),
      ).toEqual({
        text: "Check for crashes.\n",
        isAutomation: true,
        scheduledTaskId: "task:daily-audit",
      });
    }
  });
});
