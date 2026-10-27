// @effect-diagnostics globalDate:off
import type { ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ThreadLink } from "../store/ThreadLinkStore.ts";
import { MAX_ACTIVE_BRIDGES, pickEvictionVictim, type ActiveBridge } from "./BridgeHub.ts";
import {
  rankAndCapRestoreCandidates,
  shellRestoreDecision,
  type ShellRestoreDecision,
} from "./ThreadRestore.ts";

function link(partial: Partial<ThreadLink> & Pick<ThreadLink, "discordThreadId">): ThreadLink {
  return {
    discordThreadId: partial.discordThreadId,
    t3ThreadId: (partial.t3ThreadId ?? `t3-${partial.discordThreadId}`) as ThreadId,
    projectId: (partial.projectId ?? "proj") as ProjectId,
    channelId: partial.channelId ?? "chan",
    guildId: partial.guildId ?? "guild",
    createdAt: partial.createdAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: partial.updatedAt ?? partial.createdAt ?? "2026-01-01T00:00:00.000Z",
    lastActivityAt: partial.lastActivityAt ?? "2026-01-01T00:00:00.000Z",
    status: partial.status ?? "active",
    lastSeenTurnId: partial.lastSeenTurnId ?? null,
    lastFinalizedAssistantId: partial.lastFinalizedAssistantId ?? null,
    lastThreadSnapshotSequence: partial.lastThreadSnapshotSequence ?? null,
    lastDeliveredSequence: partial.lastDeliveredSequence ?? null,
    streamDiscordMessageIds: partial.streamDiscordMessageIds,
  };
}

function shell(overrides: {
  latestTurnState?: "running" | "completed" | "interrupted" | null;
  sessionStatus?: "running" | "starting" | "idle" | "error" | "interrupted" | null;
  hasPendingApprovals?: boolean;
  hasPendingUserInput?: boolean;
}): Parameters<typeof shellRestoreDecision>[0] {
  return {
    id: "t1" as ThreadId,
    projectId: "p1" as ProjectId,
    title: "x",
    modelSelection: { instanceId: "codex" as never, model: "gpt" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn:
      overrides.latestTurnState === null || overrides.latestTurnState === undefined
        ? null
        : ({
            turnId: "turn-1",
            state: overrides.latestTurnState,
            requestedAt: "2026-01-01T00:00:00.000Z",
            startedAt: "2026-01-01T00:00:00.000Z",
            completedAt: null,
            assistantMessageId: null,
          } as never),
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archivedAt: null,
    session:
      overrides.sessionStatus === null || overrides.sessionStatus === undefined
        ? null
        : ({
            threadId: "t1",
            status: overrides.sessionStatus,
            providerName: null,
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: "2026-01-01T00:00:00.000Z",
          } as never),
    latestUserMessageAt: null,
    hasPendingApprovals: overrides.hasPendingApprovals ?? false,
    hasPendingUserInput: overrides.hasPendingUserInput ?? false,
    hasActionableProposedPlan: false,
  } as unknown as Parameters<typeof shellRestoreDecision>[0];
}

describe("shellRestoreDecision", () => {
  it("marks missing shell as missing", () => {
    expect(shellRestoreDecision(null)).toEqual({ kind: "missing" } satisfies ShellRestoreDecision);
  });

  it("restores running turns", () => {
    const decision = shellRestoreDecision(shell({ latestTurnState: "running" }));
    expect(decision.kind).toBe("restore");
    if (decision.kind === "restore") {
      expect(decision.reasons).toContain("running");
    }
  });

  it("restores session starting/running", () => {
    expect(shellRestoreDecision(shell({ sessionStatus: "starting" })).kind).toBe("restore");
    expect(shellRestoreDecision(shell({ sessionStatus: "running" })).kind).toBe("restore");
  });

  it("restores interrupted sessions only when a turn still looks unfinished", () => {
    const decision = shellRestoreDecision(
      shell({ sessionStatus: "interrupted", latestTurnState: "running" }),
    );
    expect(decision.kind).toBe("restore");
    if (decision.kind === "restore") {
      expect(decision.reasons).toContain("session-wake-required");
    }
  });

  it("does not restore zombie interrupted sessions with a completed turn", () => {
    expect(
      shellRestoreDecision(shell({ sessionStatus: "interrupted", latestTurnState: "completed" }))
        .kind,
    ).toBe("idle");
  });

  it("restores pending approvals / user input", () => {
    expect(shellRestoreDecision(shell({ hasPendingApprovals: true })).kind).toBe("restore");
    expect(shellRestoreDecision(shell({ hasPendingUserInput: true })).kind).toBe("restore");
  });

  it("restores when open stream ids need catch-up finalize", () => {
    const decision = shellRestoreDecision(shell({ latestTurnState: "completed" }), {
      hasOpenStreamIds: true,
    });
    expect(decision.kind).toBe("restore");
    if (decision.kind === "restore") {
      expect(decision.reasons).toContain("open-stream-ids");
    }
  });

  it("restores when dual-cursor delivery lags orchestration", () => {
    const decision = shellRestoreDecision(shell({ latestTurnState: "completed" }), {
      deliveryBehind: true,
    });
    expect(decision.kind).toBe("restore");
    if (decision.kind === "restore") {
      expect(decision.reasons).toContain("delivery-behind");
    }
  });

  it("skips idle completed threads without open stream ids", () => {
    expect(
      shellRestoreDecision(shell({ latestTurnState: "completed" }), { hasOpenStreamIds: false })
        .kind,
    ).toBe("idle");
  });
});

describe("rankAndCapRestoreCandidates", () => {
  it("keeps urgent candidates ahead of newer idle links", () => {
    const candidates = [
      {
        link: link({ discordThreadId: "idle-new", lastActivityAt: "2026-06-01T00:00:00.000Z" }),
        urgent: false,
      },
      {
        link: link({ discordThreadId: "urgent-old", lastActivityAt: "2026-01-01T00:00:00.000Z" }),
        urgent: true,
      },
      {
        link: link({ discordThreadId: "urgent-new", lastActivityAt: "2026-03-01T00:00:00.000Z" }),
        urgent: true,
      },
      {
        link: link({
          discordThreadId: "tomb",
          lastActivityAt: "2026-07-01T00:00:00.000Z",
          status: "tombstone",
        }),
        urgent: true,
      },
    ];
    const { selected, dropped } = rankAndCapRestoreCandidates(candidates, 2);
    expect(selected.map((entry) => entry.link.discordThreadId)).toEqual([
      "urgent-new",
      "urgent-old",
    ]);
    expect(dropped).toBe(1);
  });

  it("defaults cap to MAX_ACTIVE_BRIDGES", () => {
    expect(MAX_ACTIVE_BRIDGES).toBe(50);
    const many = Array.from({ length: 60 }, (_, index) => ({
      link: link({
        discordThreadId: `d-${index}`,
        lastActivityAt: new Date(Date.UTC(2026, 0, 1 + index)).toISOString(),
      }),
      urgent: index < 5,
    }));
    const { selected, dropped } = rankAndCapRestoreCandidates(many);
    expect(selected).toHaveLength(50);
    expect(selected.slice(0, 5).every((entry) => entry.urgent)).toBe(true);
    expect(dropped).toBe(10);
  });

  it("orders idle candidates by lastActivityAt once urgent slots are satisfied", () => {
    const candidates = [
      {
        link: link({ discordThreadId: "idle-old", lastActivityAt: "2026-01-01T00:00:00.000Z" }),
        urgent: false,
      },
      {
        link: link({ discordThreadId: "idle-new", lastActivityAt: "2026-06-01T00:00:00.000Z" }),
        urgent: false,
      },
      {
        link: link({ discordThreadId: "urgent", lastActivityAt: "2026-02-01T00:00:00.000Z" }),
        urgent: true,
      },
    ];
    const { selected } = rankAndCapRestoreCandidates(candidates, 3);
    expect(selected.map((entry) => entry.link.discordThreadId)).toEqual([
      "urgent",
      "idle-new",
      "idle-old",
    ]);
  });
});

describe("pickEvictionVictim", () => {
  const entry = (
    partial: Partial<ActiveBridge> & Pick<ActiveBridge, "discordChannelId">,
  ): ActiveBridge => ({
    discordChannelId: partial.discordChannelId,
    t3ThreadId: partial.t3ThreadId ?? "t3",
    lastActivityAt: partial.lastActivityAt ?? "2026-01-01T00:00:00.000Z",
    preferred: partial.preferred ?? false,
    mode: partial.mode ?? "rehydrate",
  });

  it("prefers oldest non-preferred bridge", () => {
    const victim = pickEvictionVictim(
      [
        entry({
          discordChannelId: "pref-old",
          preferred: true,
          lastActivityAt: "2026-01-01T00:00:00.000Z",
        }),
        entry({
          discordChannelId: "idle-new",
          preferred: false,
          lastActivityAt: "2026-06-01T00:00:00.000Z",
        }),
        entry({
          discordChannelId: "idle-old",
          preferred: false,
          lastActivityAt: "2026-02-01T00:00:00.000Z",
        }),
      ],
      "incoming",
    );
    expect(victim?.discordChannelId).toBe("idle-old");
  });

  it("falls back to oldest preferred when all are preferred", () => {
    const victim = pickEvictionVictim(
      [
        entry({
          discordChannelId: "a",
          preferred: true,
          lastActivityAt: "2026-03-01T00:00:00.000Z",
        }),
        entry({
          discordChannelId: "b",
          preferred: true,
          lastActivityAt: "2026-01-01T00:00:00.000Z",
        }),
      ],
      "incoming",
    );
    expect(victim?.discordChannelId).toBe("b");
  });

  it("never picks the except channel", () => {
    const victim = pickEvictionVictim(
      [entry({ discordChannelId: "only", preferred: false })],
      "only",
    );
    expect(victim).toBeNull();
  });
});
