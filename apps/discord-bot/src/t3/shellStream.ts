import type {
  OrchestrationV2ShellSnapshot,
  OrchestrationV2ShellStreamItem,
} from "@t3tools/contracts";
import {
  applyShellStreamEvent,
  mergeShellSnapshotProjects,
} from "@t3tools/client-runtime/state/shell";

/**
 * Apply one V2 shell stream item the same way the web client does.
 *
 * Enrichment snapshots list only the workspace roots whose repository
 * identity just resolved, and they carry no threads. Replacing the held
 * shell with that frame drops every other registered project, so a later
 * mention fails with "No T3 project registered" for a project T3 still has.
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
