import type {
  OrchestrationV2ShellSnapshot,
  OrchestrationV2ShellStreamItem,
} from "@t3tools/contracts";
import {
  applyShellStreamEvent,
  mergeShellSnapshotProjects,
} from "@t3tools/client-runtime/state/shell";

/**
 * Apply V2 shell stream items like web. Enrichment snapshots contain only newly resolved roots, not threads;
 * replacing the held shell with one drops other projects that later mentions still need.
 */
export function applyIntegrationShellStreamItem(
  shell: OrchestrationV2ShellSnapshot | null,
  item: OrchestrationV2ShellStreamItem,
): OrchestrationV2ShellSnapshot | null {
  if (item.kind === "synchronized") return shell;
  if (item.kind === "snapshot") {
    return mergeShellSnapshotProjects(
      shell,
      item.snapshot,
      item.resolvedRepositoryIdentityRoots === undefined
        ? undefined
        : { resolvedRepositoryIdentityRoots: item.resolvedRepositoryIdentityRoots },
    );
  }
  if (shell === null) return null;
  return applyShellStreamEvent(shell, item);
}
