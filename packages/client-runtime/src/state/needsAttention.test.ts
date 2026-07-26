import type { OrchestrationThreadShell } from "@t3tools/contracts";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildNeedsAttentionEntries,
  classifyNeedsAttention,
  type NeedsAttentionThreadInput,
} from "./needsAttention.ts";

const environmentId = EnvironmentId.make("environment-1");
const projectId = ProjectId.make("project-1");
const NOW = "2026-06-10T12:00:00.000Z";

function makeThread(
  id: string,
  options: {
    readonly updatedAt?: string;
    readonly hasPendingApprovals?: boolean;
    readonly hasPendingUserInput?: boolean;
    readonly hasActionableProposedPlan?: boolean;
    readonly interactionMode?: "default" | "plan";
    readonly sessionStatus?: OrchestrationThreadShell["session"] extends infer S
      ? S extends { status: infer Status }
        ? Status
        : never
      : never;
    readonly settledOverride?: "settled" | "active" | null;
    readonly settledAt?: string | null;
    readonly archivedAt?: string | null;
  } = {},
): NeedsAttentionThreadInput {
  const updatedAt = options.updatedAt ?? "2026-06-01T00:00:00.000Z";
  return {
    environmentId,
    id: ThreadId.make(id),
    projectId,
    title: `Thread ${id}`,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: options.interactionMode ?? "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt,
    archivedAt: options.archivedAt ?? null,
    settledOverride: options.settledOverride ?? null,
    settledAt: options.settledAt ?? null,
    snoozedUntil: null,
    snoozedAt: null,
    latestUserMessageAt: updatedAt,
    hasPendingApprovals: options.hasPendingApprovals ?? false,
    hasPendingUserInput: options.hasPendingUserInput ?? false,
    hasActionableProposedPlan: options.hasActionableProposedPlan ?? false,
    session:
      options.sessionStatus === undefined
        ? null
        : {
            threadId: ThreadId.make(id),
            status: options.sessionStatus,
            providerName: null,
            runtimeMode: "full-access",
            lastError: null,
            updatedAt,
            activeTurnId: null,
            providerInstanceId: ProviderInstanceId.make("codex"),
          },
  };
}

describe("classifyNeedsAttention", () => {
  it("classifies blocked and working signals", () => {
    expect(classifyNeedsAttention(makeThread("a", { hasPendingApprovals: true }))).toEqual({
      kind: "blocked",
      statusLabel: "Pending Approval",
    });
    expect(classifyNeedsAttention(makeThread("b", { sessionStatus: "running" }))).toEqual({
      kind: "working",
      statusLabel: "Working",
    });
    expect(classifyNeedsAttention(makeThread("idle"))).toBeNull();
  });

  it("treats unseen completion as blocked when idle", () => {
    expect(classifyNeedsAttention(makeThread("done"), { hasUnseenCompletion: true })).toEqual({
      kind: "blocked",
      statusLabel: "Completed",
    });
  });
});

describe("buildNeedsAttentionEntries", () => {
  it("sorts blocked before working and excludes idle", () => {
    const project = { title: "Alpha" };
    const entries = buildNeedsAttentionEntries({
      now: NOW,
      threads: [
        makeThread("idle", { updatedAt: "2026-06-05T00:00:00.000Z" }),
        makeThread("work", {
          sessionStatus: "running",
          updatedAt: "2026-06-04T00:00:00.000Z",
        }),
        makeThread("block", {
          hasPendingUserInput: true,
          updatedAt: "2026-06-03T00:00:00.000Z",
        }),
      ],
      resolveProject: () => project,
    });

    expect(entries.map((entry) => entry.thread.id)).toEqual(["block", "work"]);
    expect(entries[0]?.kind).toBe("blocked");
  });
});
