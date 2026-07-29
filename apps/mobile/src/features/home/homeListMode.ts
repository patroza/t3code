/**
 * Home list presentation modes. Shared by compact home and split sidebar.
 * Environment multi-filter applies to every mode.
 *
 * Threads replaces the former Recent + Projects modes with a single list
 * controlled by {@link HomeThreadGrouping}.
 */
export type HomeListMode = "threads" | "board";

export const HOME_LIST_MODES = ["threads", "board"] as const satisfies readonly HomeListMode[];

export const HOME_LIST_MODE_LABELS: Record<HomeListMode, string> = {
  threads: "Threads",
  board: "Board",
};

/** SF Symbol names for header mode buttons (AppSymbol / native bar items). */
export const HOME_LIST_MODE_ICONS: Record<HomeListMode, string> = {
  threads: "list.bullet",
  board: "square.split.2x1",
};

export const HOME_LIST_MODE_TITLES: Record<HomeListMode, string> = {
  threads: "Threads",
  board: "Board",
};

export function isHomeListMode(value: unknown): value is HomeListMode {
  return value === "threads" || value === "board";
}

/** Modes the user can switch to from the current one. */
export function otherHomeListModes(mode: HomeListMode): readonly HomeListMode[] {
  return HOME_LIST_MODES.filter((candidate) => candidate !== mode);
}

export const DEFAULT_HOME_LIST_MODE: HomeListMode = "threads";

/**
 * How the Threads list is organized. Custom user groups are a follow-up.
 */
export type HomeThreadGrouping = "recency" | "project" | "none";

export const HOME_THREAD_GROUPINGS = [
  "recency",
  "project",
  "none",
] as const satisfies readonly HomeThreadGrouping[];

export const HOME_THREAD_GROUPING_LABELS: Record<HomeThreadGrouping, string> = {
  recency: "Group by recency",
  project: "Group by project",
  none: "Group by nothing",
};

export function isHomeThreadGrouping(value: unknown): value is HomeThreadGrouping {
  return value === "recency" || value === "project" || value === "none";
}

export const DEFAULT_HOME_THREAD_GROUPING: HomeThreadGrouping = "project";

export function usesProjectThreadGrouping(grouping: HomeThreadGrouping): boolean {
  return grouping === "project";
}

export function usesFlatThreadGrouping(grouping: HomeThreadGrouping): boolean {
  return grouping === "recency" || grouping === "none";
}
