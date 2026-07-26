import type { EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/**
 * Multi-select environment filter shared by Recent, Projects, and Board.
 * Empty selection means all environments.
 */
export function matchesEnvironmentFilter(
  environmentId: EnvironmentId,
  selectedEnvironmentIds: readonly EnvironmentId[],
): boolean {
  return selectedEnvironmentIds.length === 0 || selectedEnvironmentIds.includes(environmentId);
}

export function isAllEnvironmentsSelected(
  selectedEnvironmentIds: readonly EnvironmentId[],
): boolean {
  return selectedEnvironmentIds.length === 0;
}

export function isEnvironmentSelected(
  selectedEnvironmentIds: readonly EnvironmentId[],
  environmentId: EnvironmentId,
): boolean {
  return selectedEnvironmentIds.length === 0 || selectedEnvironmentIds.includes(environmentId);
}

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

export function resolveSelectedEnvironmentIds(
  selectedEnvironmentIds: readonly EnvironmentId[],
  availableEnvironmentIds: ReadonlySet<EnvironmentId>,
): readonly EnvironmentId[] {
  if (selectedEnvironmentIds.length === 0) return selectedEnvironmentIds;
  const next = selectedEnvironmentIds.filter((id) => availableEnvironmentIds.has(id));
  return next.length === selectedEnvironmentIds.length ? selectedEnvironmentIds : next;
}

export type WebListMode = "recent" | "projects" | "board";

export const WEB_LIST_MODES = [
  "recent",
  "projects",
  "board",
] as const satisfies readonly WebListMode[];

export const WEB_LIST_MODE_LABELS: Record<WebListMode, string> = {
  recent: "Recent",
  projects: "Projects",
  board: "Board",
};

export function isWebListMode(value: unknown): value is WebListMode {
  return value === "recent" || value === "projects" || value === "board";
}

export const LIST_ENVIRONMENT_FILTER_STORAGE_KEY = "t3code:list:environment-filter:v1";
export const LIST_MODE_STORAGE_KEY = "t3code:list:mode:v1";

/** Persisted env multi-select; empty array means all environments. */
export const ListEnvironmentFilterSchema = Schema.Array(Schema.String);
export type ListEnvironmentFilterStored = typeof ListEnvironmentFilterSchema.Type;
export const EMPTY_LIST_ENVIRONMENT_FILTER: ListEnvironmentFilterStored = [];

export const WebListModeSchema = Schema.Literals(WEB_LIST_MODES);
export const DEFAULT_WEB_LIST_MODE: WebListMode = "projects";
