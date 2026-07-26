import {
  buildNeedsAttentionEntries,
  classifyNeedsAttention as classifyNeedsAttentionShared,
  type NeedsAttentionKind,
  type NeedsAttentionStatusLabel,
} from "@t3tools/client-runtime/state/needs-attention";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";

import { scopedProjectKey } from "../../lib/scopedEntities";

/** Initial Needs attention size; matches the old Recent preview count. */
export const HOME_NEEDS_ATTENTION_PREVIEW_COUNT = 6;

/**
 * Synthetic group key for Needs attention show-more / expand state. Not a
 * real project group — kept out of collapsed-project persistence.
 */
export const HOME_NEEDS_ATTENTION_GROUP_KEY = "__needs-attention__";

export type HomeNeedsAttentionKind = NeedsAttentionKind;

export interface HomeNeedsAttentionEntry {
  readonly thread: EnvironmentThreadShell;
  readonly project: EnvironmentProject;
  readonly kind: HomeNeedsAttentionKind;
  readonly statusLabel: NeedsAttentionStatusLabel | null;
}

/** @see classifyNeedsAttention in `@t3tools/client-runtime/state/needs-attention` */
export function classifyNeedsAttention(
  thread: Parameters<typeof classifyNeedsAttentionShared>[0],
): ReturnType<typeof classifyNeedsAttentionShared> {
  return classifyNeedsAttentionShared(thread);
}

/**
 * Cross-project Needs attention entries for the classic home / sidebar list.
 * Shared classification with web sidebar.
 */
export function buildHomeNeedsAttentionEntries(input: {
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly environmentId: EnvironmentId | null;
  readonly projectRefKeys?: ReadonlySet<string> | null;
  readonly searchQuery: string;
  readonly settlementEnvironmentIds?: ReadonlySet<EnvironmentId>;
  readonly snoozeEnvironmentIds?: ReadonlySet<EnvironmentId>;
  readonly now?: string;
}): ReadonlyArray<HomeNeedsAttentionEntry> {
  const projectByKey = new Map<string, EnvironmentProject>();
  for (const project of input.projects) {
    if (input.environmentId !== null && project.environmentId !== input.environmentId) {
      continue;
    }
    projectByKey.set(scopedProjectKey(project.environmentId, project.id), project);
  }

  const query = input.searchQuery.trim().toLocaleLowerCase();

  return buildNeedsAttentionEntries({
    threads: input.threads,
    settlementEnvironmentIds: input.settlementEnvironmentIds,
    snoozeEnvironmentIds: input.snoozeEnvironmentIds,
    now: input.now,
    includeThread: (thread) => {
      if (input.environmentId !== null && thread.environmentId !== input.environmentId) {
        return false;
      }
      const projectKey = scopedProjectKey(thread.environmentId, thread.projectId);
      if (input.projectRefKeys != null && !input.projectRefKeys.has(projectKey)) {
        return false;
      }
      if (!projectByKey.has(projectKey)) {
        return false;
      }
      if (query.length > 0 && !thread.title.toLocaleLowerCase().includes(query)) {
        return false;
      }
      return true;
    },
    resolveProject: (thread) =>
      projectByKey.get(scopedProjectKey(thread.environmentId, thread.projectId)) ?? null,
  });
}
