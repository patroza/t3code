import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

/**
 * Multi-select environment filter shared by Threads and Board.
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

/** Main list surface: combined thread list vs Board. */
export type WebListMode = "threads" | "board";

export const WEB_LIST_MODES = ["threads", "board"] as const satisfies readonly WebListMode[];

export const WEB_LIST_MODE_LABELS: Record<WebListMode, string> = {
  threads: "Threads",
  board: "Board",
};

export function isWebListMode(value: unknown): value is WebListMode {
  return value === "threads" || value === "board";
}

/**
 * How the Threads list is organized. Shared by classic sidebar and Sidebar V2
 * (`LIST_THREAD_GROUPING_STORAGE_KEY`) so Recent / project / none stay aligned
 * across the beta toggle.
 *
 * - `recency`: activity order + day buckets on the active list
 * - `project`: classic nests by project; V2 keeps its static creation spine
 * - `none`: activity order, flat (no day headers)
 *
 * Custom user groups are intentionally out of scope for the first cut.
 */
export type WebThreadGrouping = "recency" | "project" | "none";

export const WEB_THREAD_GROUPINGS = [
  "recency",
  "project",
  "none",
] as const satisfies readonly WebThreadGrouping[];

export const WEB_THREAD_GROUPING_LABELS: Record<WebThreadGrouping, string> = {
  recency: "Group by recency",
  project: "Group by project",
  none: "Group by nothing",
};

export function isWebThreadGrouping(value: unknown): value is WebThreadGrouping {
  return value === "recency" || value === "project" || value === "none";
}

export const LIST_ENVIRONMENT_FILTER_STORAGE_KEY = "t3code:list:environment-filter:v1";
/** Persists surface mode. Legacy values `recent` / `projects` decode as `threads`. */
export const LIST_MODE_STORAGE_KEY = "t3code:list:mode:v1";
export const LIST_THREAD_GROUPING_STORAGE_KEY = "t3code:list:thread-grouping:v1";
/** Sidebar Threads project scope; Board keeps its own storage key. */
export const LIST_PROJECT_FILTER_STORAGE_KEY = "t3code:list:project-filter:v1";
export const LIST_PROJECT_FILTER_ALL = "all";
/**
 * Per organization: when true, settled threads leave the main list.
 * Classic recency/none shelves them in a collapsible Settled section (like V2);
 * project groups still omit them from each project’s thread list.
 * Recency/none default to hide (cleaner inbox); project groups default to show.
 */
export const LIST_HIDE_SETTLED_RECENT_STORAGE_KEY = "t3code:list:hide-settled-recent:v1";
export const LIST_HIDE_SETTLED_PROJECTS_STORAGE_KEY = "t3code:list:hide-settled-projects:v1";
export const DEFAULT_HIDE_SETTLED_RECENT = true;
export const DEFAULT_HIDE_SETTLED_PROJECTS = false;

/** Sidebar V2: show Last Hour / Yesterday / … under Settled when multi-bucket. */
export const SIDEBAR_V2_SETTLED_RECENCY_HEADERS_STORAGE_KEY =
  "t3code:sidebar-v2:settled-recency-headers:v1";
export const DEFAULT_SIDEBAR_V2_SETTLED_RECENCY_HEADERS = true;
/** Sidebar V2: settled shelf expanded vs collapsed (persists last toggle). */
export const SIDEBAR_V2_SETTLED_SHELF_EXPANDED_STORAGE_KEY =
  "t3code:sidebar-v2:settled-shelf-expanded:v1";
export const DEFAULT_SIDEBAR_V2_SETTLED_SHELF_EXPANDED = true;

/** Persisted env multi-select; empty array means all environments. */
export const ListEnvironmentFilterSchema = Schema.Array(Schema.String);
export type ListEnvironmentFilterStored = typeof ListEnvironmentFilterSchema.Type;
export const EMPTY_LIST_ENVIRONMENT_FILTER: ListEnvironmentFilterStored = [];

/** Persisted single project key, or null for all projects. */
export const ListProjectFilterSchema = Schema.NullOr(Schema.String);
export type ListProjectFilterStored = typeof ListProjectFilterSchema.Type;

export const ListHideSettledSchema = Schema.Boolean;

/** Accepts legacy `recent` / `projects` and maps them to the combined Threads surface. */
const WebListModeStored = Schema.Literals(["threads", "board", "recent", "projects"]);
export const WebListModeSchema = WebListModeStored.pipe(
  Schema.decodeTo(
    Schema.Literals(["threads", "board"]),
    SchemaTransformation.transformOrFail({
      decode: (value) =>
        Effect.succeed(value === "board" ? ("board" as const) : ("threads" as const)),
      encode: (value) => Effect.succeed(value),
    }),
  ),
);
export const DEFAULT_WEB_LIST_MODE: WebListMode = "threads";

export const WebThreadGroupingSchema = Schema.Literals(["recency", "project", "none"]);
export const DEFAULT_WEB_THREAD_GROUPING: WebThreadGrouping = "project";

/**
 * When the grouping key is unset, map the legacy mode string so users who lived
 * in Recent keep day buckets and Projects users keep project groups.
 */
export function defaultThreadGroupingFromLegacyModeStorage(
  rawModeStorageValue: string | null,
): WebThreadGrouping {
  if (rawModeStorageValue === '"recent"') return "recency";
  if (rawModeStorageValue === '"projects"') return "project";
  return DEFAULT_WEB_THREAD_GROUPING;
}

export function usesProjectThreadGrouping(grouping: WebThreadGrouping): boolean {
  return grouping === "project";
}

export function usesFlatThreadGrouping(grouping: WebThreadGrouping): boolean {
  return grouping === "recency" || grouping === "none";
}
