import { describe, expect, it } from "vite-plus/test";

import {
  activeTurnWakeNote,
  decorateDiscordThreadTitle,
  formatInProgressChunk,
  formatThreadTitle,
  formatWakeUpTipContent,
  formatWorkingWakeNote,
  idleMessageFields,
  nextWorkingDotCount,
  stripWorkingIndicator,
  truncateTitle,
  turnContinueCustomId,
  turnStopCustomId,
  WAKE_UP_STATUS_LINE,
  wakeUpMessageFields,
  WORKING_WAKE_NOTE_MAX,
  workingMessageFields,
} from "./messages.ts";

describe("formatThreadTitle", () => {
  it("collapses whitespace and uses the provided fallback", () => {
    expect(formatThreadTitle("  review   the   open PR  ", 72, "Discord thread")).toBe(
      "review the open PR",
    );
    expect(formatThreadTitle("   ", 72, "Discord thread")).toBe("Discord thread");
  });

  it("truncates long titles with an ellipsis", () => {
    expect(formatThreadTitle("x".repeat(80), 72)).toHaveLength(72);
    expect(formatThreadTitle("x".repeat(80), 72).endsWith("…")).toBe(true);
  });
});

describe("truncateTitle", () => {
  it("preserves the existing Discord thread-name behavior", () => {
    expect(truncateTitle("short")).toBe("short");
    expect(truncateTitle("x".repeat(120)).length).toBe(100);
  });
});

describe("decorateDiscordThreadTitle", () => {
  it("composes optional PR + activity columns like the T3 client", () => {
    expect(
      decorateDiscordThreadTitle("Review sidebar PR status", {
        pr: "open",
        activity: "busy",
      }),
    ).toBe("🔀 ⏳ Review sidebar PR status");
    expect(
      decorateDiscordThreadTitle("Review sidebar PR status", {
        pr: "open",
        activity: "wake-required",
        hasFailingChecks: true,
      }),
    ).toBe("❌ ❗ Review sidebar PR status");
    expect(
      decorateDiscordThreadTitle("Review sidebar PR status", {
        pr: "initialized",
        activity: "busy",
      }),
    ).toBe("▫️ ⏳ Review sidebar PR status");
  });

  it("allows either column to be omitted", () => {
    expect(decorateDiscordThreadTitle("Review sidebar PR status", { pr: "open" })).toBe(
      "🔀 Review sidebar PR status",
    );
    expect(decorateDiscordThreadTitle("Review sidebar PR status", { activity: "busy" })).toBe(
      "⏳ Review sidebar PR status",
    );
    expect(
      decorateDiscordThreadTitle("Review sidebar PR status", { activity: "wake-required" }),
    ).toBe("❗ Review sidebar PR status");
    expect(decorateDiscordThreadTitle("Review sidebar PR status", {})).toBe(
      "Review sidebar PR status",
    );
  });

  it("legacy single-slot states still work", () => {
    expect(decorateDiscordThreadTitle("Review sidebar PR status", "wake-required")).toBe(
      "❗ Review sidebar PR status",
    );
    expect(decorateDiscordThreadTitle("Review sidebar PR status", "busy")).toBe(
      "⏳ Review sidebar PR status",
    );
    expect(decorateDiscordThreadTitle("Review sidebar PR status", "initialized")).toBe(
      "▫️ Review sidebar PR status",
    );
    expect(decorateDiscordThreadTitle("Review sidebar PR status", "open")).toBe(
      "🔀 Review sidebar PR status",
    );
    expect(decorateDiscordThreadTitle("Review sidebar PR status", "open", 100, true)).toBe(
      "❌ Review sidebar PR status",
    );
    expect(decorateDiscordThreadTitle("Ship the merge flow", "merged")).toBe(
      "✔️ Ship the merge flow",
    );
    expect(decorateDiscordThreadTitle("Ship the merge flow", "closed")).toBe(
      "✖️ Ship the merge flow",
    );
  });

  it("strips dual and legacy prefixes when redecorating", () => {
    expect(
      decorateDiscordThreadTitle("🔀 ⏳ Review sidebar PR status", {
        pr: "open",
        activity: null,
      }),
    ).toBe("🔀 Review sidebar PR status");
    expect(decorateDiscordThreadTitle("❗ Review sidebar PR status", "open")).toBe(
      "🔀 Review sidebar PR status",
    );
    expect(decorateDiscordThreadTitle("⏳ Review sidebar PR status", "initialized")).toBe(
      "▫️ Review sidebar PR status",
    );
    expect(decorateDiscordThreadTitle("🔀 ⏳ Existing title", { pr: "merged" })).toBe(
      "✔️ Existing title",
    );
  });

  it("removes stale pull request prefixes when the PR closes or changes state", () => {
    expect(decorateDiscordThreadTitle("🍴 Existing title", null)).toBe("Existing title");
    expect(decorateDiscordThreadTitle("· Existing title", null)).toBe("Existing title");
    expect(decorateDiscordThreadTitle("▫️ Existing title", null)).toBe("Existing title");
    expect(decorateDiscordThreadTitle("⏳ Existing title", null)).toBe("Existing title");
    expect(decorateDiscordThreadTitle("🍴 Existing title", "initialized")).toBe(
      "▫️ Existing title",
    );
    expect(decorateDiscordThreadTitle("🍴 Existing title", "merged")).toBe("✔️ Existing title");
    expect(decorateDiscordThreadTitle("✅ Existing title", "closed")).toBe("✖️ Existing title");
    expect(decorateDiscordThreadTitle("❌ Existing title", "open")).toBe("🔀 Existing title");
    expect(decorateDiscordThreadTitle("❌ 🔀 Existing title", "open")).toBe("🔀 Existing title");
  });

  it("never duplicates an existing pull request prefix", () => {
    expect(decorateDiscordThreadTitle("▫️ Existing title", "initialized")).toBe(
      "▫️ Existing title",
    );
    expect(decorateDiscordThreadTitle("⏳ Existing title", "busy")).toBe("⏳ Existing title");
    expect(
      decorateDiscordThreadTitle("🔀 ⏳ Existing title", { pr: "open", activity: "busy" }),
    ).toBe("🔀 ⏳ Existing title");
    expect(decorateDiscordThreadTitle("🔀 Existing title", "open")).toBe("🔀 Existing title");
    expect(decorateDiscordThreadTitle("❌ Existing title", "open", 100, true)).toBe(
      "❌ Existing title",
    );
    // Legacy dual ❌ 🔀 redecorates to single ❌ when checks are still failing.
    expect(decorateDiscordThreadTitle("❌ 🔀 Existing title", "open", 100, true)).toBe(
      "❌ Existing title",
    );
    expect(decorateDiscordThreadTitle("✔️ Existing title", "merged")).toBe("✔️ Existing title");
    expect(decorateDiscordThreadTitle("✖️ Existing title", "closed")).toBe("✖️ Existing title");
  });
});

describe("turn stop controls", () => {
  it("builds the stop custom id", () => {
    expect(turnStopCustomId("thread-123")).toBe("t3_stop:thread-123");
  });

  it("attaches a Stop button to working messages", () => {
    const fields = workingMessageFields("_Working.._", "thread-123");
    expect(fields.content).toBe("_Working.._");
    expect(fields.components).toHaveLength(1);
    expect(fields.components[0]?.components[0]?.custom_id).toBe("t3_stop:thread-123");
  });

  it("clears components for idle messages", () => {
    expect(idleMessageFields("done").components).toEqual([]);
  });
});

describe("wake-up controls", () => {
  it("builds the continue custom id", () => {
    expect(turnContinueCustomId("thread-123")).toBe("t3_continue:thread-123");
  });

  it("formats empty Working tips as bold wake-up status only", () => {
    expect(formatWakeUpTipContent("_Working.._")).toBe(WAKE_UP_STATUS_LINE);
    expect(formatWakeUpTipContent("")).toBe(WAKE_UP_STATUS_LINE);
  });

  it("keeps partial stream prose above the wake-up status", () => {
    expect(formatWakeUpTipContent("partial answer\n\n_Working.._")).toBe(
      `partial answer\n\n${WAKE_UP_STATUS_LINE}`,
    );
  });

  it("attaches a blue Continue button and no Stop", () => {
    const fields = wakeUpMessageFields(WAKE_UP_STATUS_LINE, "thread-123");
    expect(fields.content).toBe(WAKE_UP_STATUS_LINE);
    expect(fields.components).toHaveLength(1);
    const button = fields.components[0]?.components[0];
    expect(button?.custom_id).toBe("t3_continue:thread-123");
    expect(button?.label).toBe("Continue");
    expect(button?.style).toBe(1); // PRIMARY (blue)
  });
});

describe("Working heartbeat", () => {
  it("cycles through two, three, and four dots", () => {
    expect(nextWorkingDotCount(2)).toBe(3);
    expect(nextWorkingDotCount(3)).toBe(4);
    expect(nextWorkingDotCount(4)).toBe(2);
  });

  it("renders the selected heartbeat without exceeding the message limit", () => {
    const rendered = formatInProgressChunk("x".repeat(2000), true, 2000, 4);
    expect(rendered).toHaveLength(2000);
    expect(rendered.endsWith("_Working...._")).toBe(true);
  });

  it("appends a tool-call count on the Working indicator when > 0", () => {
    expect(formatInProgressChunk("", true, 2000, 2, 0)).toBe("_Working.._");
    expect(formatInProgressChunk("", true, 2000, 2, 1)).toBe("_Working.. · 1 tool call_");
    expect(formatInProgressChunk("partial", true, 2000, 3, 4)).toBe(
      "partial\n\n_Working... · 4 tool calls_",
    );
  });

  it("strips every heartbeat variant during final cleanup", () => {
    expect(stripWorkingIndicator("answer\n\n_Working.._")).toBe("answer");
    expect(stripWorkingIndicator("answer\n\n_Working..._")).toBe("answer");
    expect(stripWorkingIndicator("answer\n\n_Working...._")).toBe("answer");
    expect(stripWorkingIndicator("answer\n\n_Working.. · 3 tool calls_")).toBe("answer");
    expect(stripWorkingIndicator("answer\n\n_Working... · 1 tool call_")).toBe("answer");
    expect(
      stripWorkingIndicator("answer\n\n_Working.. · #516: checks failed · 3 tool calls_"),
    ).toBe("answer");
    expect(stripWorkingIndicator("answer\n\nWorking.. · #516: checks failed")).toBe("answer");
  });

  it("appends the wake summary to the Working line", () => {
    expect(formatInProgressChunk("", true, 2000, 2, 0, "#516: checks failed")).toBe(
      "_Working.. · #516: checks failed_",
    );
    expect(formatInProgressChunk("partial", true, 2000, 3, 4, "#516: checks failed")).toBe(
      "partial\n\n_Working... · #516: checks failed · 4 tool calls_",
    );
    expect(formatInProgressChunk("", true, 2000, 2, 1, "file_name · `rm -rf`")).toBe(
      "_Working.. · file name - rm -rf · 1 tool call_",
    );
    expect(formatWorkingWakeNote("x".repeat(WORKING_WAKE_NOTE_MAX + 10))?.length).toBe(
      WORKING_WAKE_NOTE_MAX,
    );
  });

  it("uses the active turn's notification, not an older wake or a human follow-up", () => {
    expect(
      activeTurnWakeNote({
        latestTurnId: "run-2",
        messages: [
          {
            role: "user",
            turnId: "run-1",
            notification: { summary: "Background task finished" },
          },
          {
            role: "user",
            turnId: "run-2",
            notification: { summary: "#516: checks failed" },
          },
        ],
      }),
    ).toBe("#516: checks failed");
    expect(
      activeTurnWakeNote({
        latestTurnId: "run-2",
        messages: [{ role: "user", turnId: "run-2" }],
        activities: [
          { kind: "notification", summary: "Background task finished", turnId: "run-2" },
        ],
      }),
    ).toBeNull();
    expect(
      activeTurnWakeNote({
        latestTurnId: "run-3",
        messages: [
          {
            role: "user",
            turnId: "run-3",
            delegatedCompletion: { parentRunId: "run-parent" },
          },
        ],
        activities: [
          {
            kind: "notification",
            summary: 'Delegated task "Review" finished',
            turnId: "run-3",
          },
        ],
      }),
    ).toBe('Delegated task "Review" finished');
  });
});
