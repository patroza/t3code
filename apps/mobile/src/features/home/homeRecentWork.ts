import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { sortThreads } from "@t3tools/client-runtime/state/thread-sort";
import type { EnvironmentId } from "@t3tools/contracts";

import { scopedProjectKey } from "../../lib/scopedEntities";

/** Initial Recent section size; matches web `DEFAULT_SIDEBAR_THREAD_PREVIEW_COUNT`. */
export const HOME_RECENT_WORK_PREVIEW_COUNT = 6;

/**
 * Synthetic group key for Recent show-more / expand state. Not a real project
 * group — kept out of collapsed-project persistence.
 */
export const HOME_RECENT_WORK_GROUP_KEY = "__recent-work__";

export interface HomeRecentWorkEntry {
  readonly thread: EnvironmentThreadShell;
  readonly project: EnvironmentProject;
}

/**
 * Cross-project Recent work entries for the home / sidebar list.
 * Mirrors web sidebar Recent: all visible unarchived threads sorted by
 * latest activity (`updated_at` sort uses latest user message when present).
 */
export function buildHomeRecentWorkEntries(input: {
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly environmentId: EnvironmentId | null;
  /**
   * When set, only threads whose project is in this set are included
   * (project filter on home / sidebar).
   */
  readonly projectRefKeys?: ReadonlySet<string> | null;
  readonly searchQuery: string;
}): ReadonlyArray<HomeRecentWorkEntry> {
  const projectByKey = new Map<string, EnvironmentProject>();
  for (const project of input.projects) {
    if (input.environmentId !== null && project.environmentId !== input.environmentId) {
      continue;
    }
    projectByKey.set(scopedProjectKey(project.environmentId, project.id), project);
  }

  const query = input.searchQuery.trim().toLocaleLowerCase();
  const candidates: EnvironmentThreadShell[] = [];
  for (const thread of input.threads) {
    if (thread.archivedAt !== null) continue;
    if (input.environmentId !== null && thread.environmentId !== input.environmentId) {
      continue;
    }
    const projectKey = scopedProjectKey(thread.environmentId, thread.projectId);
    if (input.projectRefKeys != null && !input.projectRefKeys.has(projectKey)) {
      continue;
    }
    if (!projectByKey.has(projectKey)) {
      continue;
    }
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
