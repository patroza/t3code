import { describe, expect, it } from "vite-plus/test";

import { buildHomeRecentListEntries } from "./homeRecentList";

function makeProject(id: string, environmentId = "env-1") {
  return {
    environmentId: environmentId as never,
    id: id as never,
    title: id,
    workspaceRoot: `/${id}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeThread(
  id: string,
  projectId: string,
  options: { environmentId?: string; updatedAt?: string; archivedAt?: string | null } = {},
) {
  return {
    environmentId: (options.environmentId ?? "env-1") as never,
    id: id as never,
    projectId: projectId as never,
    title: id,
    status: "idle" as const,
    archivedAt: options.archivedAt ?? null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: options.updatedAt ?? "2026-01-02T00:00:00.000Z",
    latestUserMessageAt: options.updatedAt ?? "2026-01-02T00:00:00.000Z",
    branch: null,
    worktreePath: null,
  };
}

describe("buildHomeRecentListEntries", () => {
  const projects = [makeProject("p1", "env-1"), makeProject("p2", "env-2")];
  const threads = [
    makeThread("t1", "p1", { environmentId: "env-1", updatedAt: "2026-01-03T00:00:00.000Z" }),
    makeThread("t2", "p2", { environmentId: "env-2", updatedAt: "2026-01-04T00:00:00.000Z" }),
    makeThread("t3", "p1", {
      environmentId: "env-1",
      updatedAt: "2026-01-05T00:00:00.000Z",
      archivedAt: "2026-01-05T01:00:00.000Z",
    }),
  ];

  it("returns all unarchived threads sorted by recency when no env filter", () => {
    const entries = buildHomeRecentListEntries({
      projects,
      threads: threads as never,
      selectedEnvironmentIds: [],
      searchQuery: "",
    });
    expect(entries.map((entry) => entry.thread.id)).toEqual(["t2", "t1"]);
  });

  it("filters by multi-select environment ids", () => {
    const entries = buildHomeRecentListEntries({
      projects,
      threads: threads as never,
      selectedEnvironmentIds: ["env-1" as never],
      searchQuery: "",
    });
    expect(entries.map((entry) => entry.thread.id)).toEqual(["t1"]);
  });

  it("supports selecting multiple environments", () => {
    const entries = buildHomeRecentListEntries({
      projects,
      threads: threads as never,
      selectedEnvironmentIds: ["env-1" as never, "env-2" as never],
      searchQuery: "",
    });
    expect(entries.map((entry) => entry.thread.id)).toEqual(["t2", "t1"]);
  });
});
