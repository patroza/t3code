import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { scopedProjectKey } from "../../lib/scopedEntities";
import { buildHomeNeedsAttentionEntries, classifyNeedsAttention } from "./homeNeedsAttention";

const environmentId = EnvironmentId.make("environment-1");

function makeProject(id: string, title: string): EnvironmentProject {
  return {
    environmentId,
    id: ProjectId.make(id),
    title,
    workspaceRoot: `/workspaces/${id}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
  };
}

function makeThread(
  id: string,
  projectId: ProjectId,
  options: {
    readonly updatedAt?: string;
    readonly title?: string;
    readonly archivedAt?: string | null;
    readonly hasPendingApprovals?: boolean;
    readonly hasPendingUserInput?: boolean;
    readonly hasActionableProposedPlan?: boolean;
    readonly interactionMode?: "default" | "plan";
    readonly sessionStatus?: "running" | "starting" | "ready" | "error" | null;
    readonly settledAt?: string | null;
    readonly settledOverride?: "settled" | "active" | null;
  } = {},
): EnvironmentThreadShell {
  return {
    environmentId,
    id: ThreadId.make(id),
    projectId,
    title: options.title ?? `Thread ${id}`,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: options.interactionMode ?? "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: options.updatedAt ?? "2026-06-01T00:00:00.000Z",
    archivedAt: options.archivedAt ?? null,
    settledOverride: options.settledOverride ?? null,
    settledAt: options.settledAt ?? null,
    session:
      options.sessionStatus == null
        ? null
        : {
            threadId: ThreadId.make(id),
            status: options.sessionStatus,
            providerName: null,
            runtimeMode: "full-access",
            lastError: null,
            updatedAt: options.updatedAt ?? "2026-06-01T00:00:00.000Z",
            activeTurnId: null,
            providerInstanceId: ProviderInstanceId.make("codex"),
          },
    latestUserMessageAt: options.updatedAt ?? null,
    hasPendingApprovals: options.hasPendingApprovals ?? false,
    hasPendingUserInput: options.hasPendingUserInput ?? false,
    hasActionableProposedPlan: options.hasActionableProposedPlan ?? false,
  };
}

describe("classifyNeedsAttention", () => {
  it("ranks blocked-on-you signals as blocked", () => {
    expect(
      classifyNeedsAttention(makeThread("a", ProjectId.make("p"), { hasPendingApprovals: true })),
    ).toEqual({
      kind: "blocked",
      statusLabel: "Pending Approval",
    });
    expect(
      classifyNeedsAttention(makeThread("b", ProjectId.make("p"), { hasPendingUserInput: true })),
    ).toEqual({ kind: "blocked", statusLabel: "Awaiting Input" });
    expect(
      classifyNeedsAttention(
        makeThread("c", ProjectId.make("p"), {
          interactionMode: "plan",
          hasActionableProposedPlan: true,
        }),
      ),
    ).toEqual({ kind: "blocked", statusLabel: "Plan Ready" });
  });

  it("classifies running sessions as working", () => {
    expect(
      classifyNeedsAttention(makeThread("w", ProjectId.make("p"), { sessionStatus: "running" })),
    ).toEqual({ kind: "working", statusLabel: "Working" });
  });

  it("ignores idle threads with no attention signal", () => {
    expect(classifyNeedsAttention(makeThread("idle", ProjectId.make("p")))).toBeNull();
    expect(
      classifyNeedsAttention(makeThread("ready", ProjectId.make("p"), { sessionStatus: "ready" })),
    ).toBeNull();
  });
});

describe("buildHomeNeedsAttentionEntries", () => {
  const alpha = makeProject("alpha", "Alpha");
  const beta = makeProject("beta", "Beta");

  it("includes working and blocked threads, excludes idle and settled", () => {
    const entries = buildHomeNeedsAttentionEntries({
      projects: [alpha, beta],
      threads: [
        makeThread("idle", alpha.id, { updatedAt: "2026-06-05T00:00:00.000Z" }),
        makeThread("working", beta.id, {
          sessionStatus: "running",
          updatedAt: "2026-06-04T00:00:00.000Z",
        }),
        makeThread("blocked", alpha.id, {
          hasPendingApprovals: true,
          updatedAt: "2026-06-03T00:00:00.000Z",
        }),
        makeThread("idle-settled", alpha.id, {
          sessionStatus: "ready",
          settledOverride: "settled",
          settledAt: "2026-06-06T12:00:00.000Z",
          updatedAt: "2026-06-06T00:00:00.000Z",
        }),
        makeThread("archived", alpha.id, {
          hasPendingApprovals: true,
          archivedAt: "2026-06-07T00:00:00.000Z",
        }),
      ],
      environmentId: null,
      searchQuery: "",
    });

    expect(entries.map((entry) => entry.thread.id)).toEqual(["blocked", "working"]);
    expect(entries[0]?.kind).toBe("blocked");
    expect(entries[1]?.kind).toBe("working");
    expect(entries[0]?.project.title).toBe("Alpha");
  });

  it("sorts blocked before working, then by activity", () => {
    const entries = buildHomeNeedsAttentionEntries({
      projects: [alpha],
      threads: [
        makeThread("work-old", alpha.id, {
          sessionStatus: "running",
          updatedAt: "2026-06-01T00:00:00.000Z",
        }),
        makeThread("work-new", alpha.id, {
          sessionStatus: "running",
          updatedAt: "2026-06-05T00:00:00.000Z",
        }),
        makeThread("block-old", alpha.id, {
          hasPendingUserInput: true,
          updatedAt: "2026-06-02T00:00:00.000Z",
        }),
        makeThread("block-new", alpha.id, {
          hasPendingApprovals: true,
          updatedAt: "2026-06-04T00:00:00.000Z",
        }),
      ],
      environmentId: null,
      searchQuery: "",
    });

    expect(entries.map((entry) => entry.thread.id)).toEqual([
      "block-new",
      "block-old",
      "work-new",
      "work-old",
    ]);
  });

  it("respects project filter and search", () => {
    const entries = buildHomeNeedsAttentionEntries({
      projects: [alpha, beta],
      threads: [
        makeThread("alpha-hit", alpha.id, {
          hasPendingApprovals: true,
          title: "Fix approval flow",
        }),
        makeThread("beta-miss", beta.id, {
          hasPendingApprovals: true,
          title: "Fix approval flow",
        }),
        makeThread("alpha-other", alpha.id, {
          sessionStatus: "running",
          title: "Unrelated work",
        }),
      ],
      environmentId: null,
      projectRefKeys: new Set([scopedProjectKey(environmentId, alpha.id)]),
      searchQuery: "approval",
    });

    expect(entries.map((entry) => entry.thread.id)).toEqual(["alpha-hit"]);
  });
});
