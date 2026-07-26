import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { scopedProjectKey } from "../../lib/scopedEntities";
import { buildHomeRecentWorkEntries } from "./homeRecentWork";

const environmentId = EnvironmentId.make("environment-1");
const otherEnvironmentId = EnvironmentId.make("environment-2");

function makeProject(
  id: string,
  title: string,
  env: EnvironmentId = environmentId,
): EnvironmentProject {
  return {
    environmentId: env,
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
    readonly env?: EnvironmentId;
    readonly updatedAt?: string;
    readonly latestUserMessageAt?: string | null;
    readonly archivedAt?: string | null;
    readonly title?: string;
  } = {},
): EnvironmentThreadShell {
  return {
    environmentId: options.env ?? environmentId,
    id: ThreadId.make(id),
    projectId,
    title: options.title ?? `Thread ${id}`,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: options.updatedAt ?? "2026-06-01T00:00:00.000Z",
    archivedAt: options.archivedAt ?? null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: options.latestUserMessageAt ?? null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}

describe("buildHomeRecentWorkEntries", () => {
  const alpha = makeProject("alpha", "Alpha");
  const beta = makeProject("beta", "Beta");

  it("sorts threads by latest activity across projects", () => {
    const entries = buildHomeRecentWorkEntries({
      projects: [alpha, beta],
      threads: [
        makeThread("old", alpha.id, {
          updatedAt: "2026-06-01T10:00:00.000Z",
          latestUserMessageAt: "2026-06-01T10:00:00.000Z",
        }),
        makeThread("new", beta.id, {
          updatedAt: "2026-06-02T10:00:00.000Z",
          latestUserMessageAt: "2026-06-02T10:00:00.000Z",
        }),
        makeThread("mid", alpha.id, {
          updatedAt: "2026-06-01T18:00:00.000Z",
          latestUserMessageAt: "2026-06-01T18:00:00.000Z",
        }),
      ],
      environmentId: null,
      searchQuery: "",
    });

    expect(entries.map((entry) => entry.thread.id)).toEqual(["new", "mid", "old"]);
    expect(entries[0]?.project.title).toBe("Beta");
  });

  it("skips archived threads and threads without a known project", () => {
    const entries = buildHomeRecentWorkEntries({
      projects: [alpha],
      threads: [
        makeThread("live", alpha.id, { updatedAt: "2026-06-02T00:00:00.000Z" }),
        makeThread("archived", alpha.id, {
          updatedAt: "2026-06-03T00:00:00.000Z",
          archivedAt: "2026-06-03T00:00:00.000Z",
        }),
        makeThread("orphan", ProjectId.make("missing"), {
          updatedAt: "2026-06-04T00:00:00.000Z",
        }),
      ],
      environmentId: null,
      searchQuery: "",
    });

    expect(entries.map((entry) => entry.thread.id)).toEqual(["live"]);
  });

  it("filters by environment, project refs, and search query", () => {
    const remoteAlpha = makeProject("alpha", "Alpha Remote", otherEnvironmentId);
    const entries = buildHomeRecentWorkEntries({
      projects: [alpha, remoteAlpha, beta],
      threads: [
        makeThread("local-alpha", alpha.id, {
          title: "Fix mobile Recent",
          updatedAt: "2026-06-05T00:00:00.000Z",
        }),
        makeThread("remote-alpha", remoteAlpha.id, {
          env: otherEnvironmentId,
          title: "Fix mobile Recent remote",
          updatedAt: "2026-06-06T00:00:00.000Z",
        }),
        makeThread("local-beta", beta.id, {
          title: "Unrelated work",
          updatedAt: "2026-06-07T00:00:00.000Z",
        }),
      ],
      environmentId,
      projectRefKeys: new Set([scopedProjectKey(environmentId, alpha.id)]),
      searchQuery: "recent",
    });

    expect(entries.map((entry) => entry.thread.id)).toEqual(["local-alpha"]);
  });
});
