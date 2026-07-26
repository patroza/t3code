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

export function isHomeListMode(value: unknown): value is HomeListMode {
  return value === "recent" || value === "projects" || value === "board";
}

export const DEFAULT_HOME_LIST_MODE: HomeListMode = "projects";
