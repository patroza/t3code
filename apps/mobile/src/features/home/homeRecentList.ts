import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { sortThreads } from "@t3tools/client-runtime/state/thread-sort";
import type { EnvironmentId } from "@t3tools/contracts";

import { scopedProjectKey } from "../../lib/scopedEntities";
import type { PendingNewTask } from "../../state/use-pending-new-tasks";
import { matchesEnvironmentFilter } from "./homeEnvironmentFilter";

export interface HomeRecentListEntry {
  readonly thread: EnvironmentThreadShell;
  readonly project: EnvironmentProject;
}

export interface HomeRecentPendingEntry {
  readonly pendingTask: PendingNewTask;
  readonly projectTitle: string;
}

/**
 * Flat recency list for the Recent home mode: unarchived threads across
 * projects, sorted by latest user activity, with env multi-filter applied.
 */
export function buildHomeRecentListEntries(input: {
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly selectedEnvironmentIds: readonly EnvironmentId[];
  readonly projectRefKeys?: ReadonlySet<string> | null;
  readonly searchQuery: string;
}): ReadonlyArray<HomeRecentListEntry> {
  const projectByKey = new Map<string, EnvironmentProject>();
  for (const project of input.projects) {
    if (!matchesEnvironmentFilter(project.environmentId, input.selectedEnvironmentIds)) {
      continue;
    }
    projectByKey.set(scopedProjectKey(project.environmentId, project.id), project);
  }

  const query = input.searchQuery.trim().toLocaleLowerCase();
  const candidates: EnvironmentThreadShell[] = [];
  for (const thread of input.threads) {
    if (thread.archivedAt !== null) continue;
    if (!matchesEnvironmentFilter(thread.environmentId, input.selectedEnvironmentIds)) {
      continue;
    }
    const projectKey = scopedProjectKey(thread.environmentId, thread.projectId);
    if (input.projectRefKeys != null && !input.projectRefKeys.has(projectKey)) {
      continue;
    }
    if (!projectByKey.has(projectKey)) continue;
    if (query.length > 0 && !thread.title.toLocaleLowerCase().includes(query)) {
      continue;
    }
    candidates.push(thread);
  }

  return sortThreads(candidates, "updated_at").flatMap((thread) => {
    const project = projectByKey.get(scopedProjectKey(thread.environmentId, thread.projectId));
    return project ? [{ thread, project }] : [];
  });
}

export function buildHomeRecentPendingEntries(input: {
  readonly pendingTasks: ReadonlyArray<PendingNewTask>;
  readonly selectedEnvironmentIds: readonly EnvironmentId[];
  readonly projectRefKeys?: ReadonlySet<string> | null;
  readonly searchQuery: string;
}): ReadonlyArray<HomeRecentPendingEntry> {
  const query = input.searchQuery.trim().toLocaleLowerCase();
  const entries: HomeRecentPendingEntry[] = [];
  for (const pendingTask of input.pendingTasks) {
    if (
      !matchesEnvironmentFilter(pendingTask.message.environmentId, input.selectedEnvironmentIds)
    ) {
      continue;
    }
    const projectKey = scopedProjectKey(
      pendingTask.message.environmentId,
      pendingTask.creation.projectId,
    );
    if (input.projectRefKeys != null && !input.projectRefKeys.has(projectKey)) {
      continue;
    }
    const title = pendingTask.creation.projectTitle ?? "Unknown project";
    if (query.length > 0 && !title.toLocaleLowerCase().includes(query)) {
      continue;
    }
    entries.push({ pendingTask, projectTitle: title });
  }
  return entries.sort(
    (left, right) =>
      Date.parse(right.pendingTask.message.createdAt) -
      Date.parse(left.pendingTask.message.createdAt),
  );
}
