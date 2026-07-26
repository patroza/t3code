/**
 * Home list presentation modes. Shared by compact home and split sidebar.
 * Environment multi-filter applies to every mode.
 */
export type HomeListMode = "recent" | "projects" | "board";

export const HOME_LIST_MODES = [
  "recent",
  "projects",
  "board",
] as const satisfies readonly HomeListMode[];

export const HOME_LIST_MODE_LABELS: Record<HomeListMode, string> = {
  recent: "Recent",
  projects: "Projects",
  board: "Board",
};

/** SF Symbol names for header mode buttons (AppSymbol / native bar items). */
export const HOME_LIST_MODE_ICONS: Record<HomeListMode, string> = {
  recent: "clock",
  projects: "folder",
  board: "square.split.2x1",
};

export const HOME_LIST_MODE_TITLES: Record<HomeListMode, string> = {
  recent: "Recent",
  projects: "Threads",
  board: "Board",
};

export function isHomeListMode(value: unknown): value is HomeListMode {
  return value === "recent" || value === "projects" || value === "board";
}

/** Modes the user can switch to from the current one (always two). */
export function otherHomeListModes(mode: HomeListMode): readonly HomeListMode[] {
  return HOME_LIST_MODES.filter((candidate) => candidate !== mode);
}

export const DEFAULT_HOME_LIST_MODE: HomeListMode = "projects";
