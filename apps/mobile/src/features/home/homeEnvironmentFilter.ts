import type { EnvironmentId } from "@t3tools/contracts";

/**
 * Multi-select environment filter used by Recent, Projects, and Board.
 * Empty selection means "all environments".
 */
export function matchesEnvironmentFilter(
  environmentId: EnvironmentId,
  selectedEnvironmentIds: readonly EnvironmentId[],
): boolean {
  return selectedEnvironmentIds.length === 0 || selectedEnvironmentIds.includes(environmentId);
}

/** True when the filter is unrestricted (show every connected environment). */
export function isAllEnvironmentsSelected(
  selectedEnvironmentIds: readonly EnvironmentId[],
): boolean {
  return selectedEnvironmentIds.length === 0;
}

/** Checkbox state for a single environment row in the filter menu. */
export function isEnvironmentSelected(
  selectedEnvironmentIds: readonly EnvironmentId[],
  environmentId: EnvironmentId,
): boolean {
  return selectedEnvironmentIds.length === 0 || selectedEnvironmentIds.includes(environmentId);
}

/**
 * Toggle one environment in the multi-select set.
 * - From "all" (empty), choosing one env becomes a singleton selection.
 * - Deselecting the last env returns to "all".
 */
export function toggleEnvironmentId(
  selectedEnvironmentIds: readonly EnvironmentId[],
  environmentId: EnvironmentId,
): readonly EnvironmentId[] {
  if (selectedEnvironmentIds.length === 0) {
    return [environmentId];
  }
  if (selectedEnvironmentIds.includes(environmentId)) {
    return selectedEnvironmentIds.filter((id) => id !== environmentId);
  }
  return [...selectedEnvironmentIds, environmentId];
}

/** Keep only ids that still exist among available connections. */
export function resolveSelectedEnvironmentIds(
  selectedEnvironmentIds: readonly EnvironmentId[],
  availableEnvironmentIds: ReadonlySet<EnvironmentId>,
): readonly EnvironmentId[] {
  if (selectedEnvironmentIds.length === 0) return selectedEnvironmentIds;
  const next = selectedEnvironmentIds.filter((id) => availableEnvironmentIds.has(id));
  return next.length === selectedEnvironmentIds.length ? selectedEnvironmentIds : next;
}
