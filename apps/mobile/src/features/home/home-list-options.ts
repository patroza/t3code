import type {
  EnvironmentId,
  SidebarProjectGroupingMode,
  SidebarThreadSortOrder,
} from "@t3tools/contracts";
import {
  DEFAULT_SIDEBAR_PROJECT_SORT_ORDER,
  DEFAULT_SIDEBAR_THREAD_SORT_ORDER,
} from "@t3tools/contracts";
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useMemo,
  useState,
  type PropsWithChildren,
  type Dispatch,
  type SetStateAction,
} from "react";

import { resolveSelectedEnvironmentIds, toggleEnvironmentId } from "./homeEnvironmentFilter";
import { DEFAULT_HOME_LIST_MODE, type HomeListMode } from "./homeListMode";
import type { HomeProjectSortOrder } from "./homeThreadList";

export interface HomeListOptions {
  /**
   * Multi-select environment filter. Empty means all environments.
   * Applies to Recent, Projects, and Board modes.
   */
  readonly selectedEnvironmentIds: readonly EnvironmentId[];
  readonly listMode: HomeListMode;
  readonly projectSortOrder: HomeProjectSortOrder;
  readonly threadSortOrder: SidebarThreadSortOrder;
}

export interface ResolvedHomeListOptions extends HomeListOptions {
  readonly projectGroupingMode: SidebarProjectGroupingMode;
}

export function resolveProjectGroupingMode(
  projectGroupingEnabled: boolean | undefined,
): SidebarProjectGroupingMode {
  return projectGroupingEnabled === false ? "separate" : "repository";
}

export const PROJECT_SORT_OPTIONS: ReadonlyArray<{
  readonly value: HomeProjectSortOrder;
  readonly label: string;
}> = [
  { value: "updated_at", label: "Last user message" },
  { value: "created_at", label: "Created at" },
];

export const THREAD_SORT_OPTIONS: ReadonlyArray<{
  readonly value: SidebarThreadSortOrder;
  readonly label: string;
}> = [
  { value: "updated_at", label: "Last user message" },
  { value: "created_at", label: "Created at" },
];

function defaultHomeListOptions(): HomeListOptions {
  return {
    selectedEnvironmentIds: [],
    listMode: DEFAULT_HOME_LIST_MODE,
    projectSortOrder:
      DEFAULT_SIDEBAR_PROJECT_SORT_ORDER === "manual"
        ? "updated_at"
        : DEFAULT_SIDEBAR_PROJECT_SORT_ORDER,
    threadSortOrder: DEFAULT_SIDEBAR_THREAD_SORT_ORDER,
  };
}

interface HomeListOptionsContextValue {
  readonly options: HomeListOptions;
  readonly setOptions: Dispatch<SetStateAction<HomeListOptions>>;
  readonly projectGroupingMode: SidebarProjectGroupingMode;
}

const HomeListOptionsContext = createContext<HomeListOptionsContextValue | null>(null);

/** Keeps list preferences stable while the app moves between compact and split shells. */
export function HomeListOptionsProvider({
  children,
  projectGroupingMode,
}: PropsWithChildren<{ readonly projectGroupingMode: SidebarProjectGroupingMode }>) {
  const [options, setOptions] = useState<HomeListOptions>(defaultHomeListOptions);
  const value = useMemo(
    () => ({ options, setOptions, projectGroupingMode }),
    [options, projectGroupingMode],
  );
  return createElement(HomeListOptionsContext, { value }, children);
}

export function hasCustomHomeListOptions(
  options: HomeListOptions & {
    readonly selectedProjectKey?: string | null;
  },
): boolean {
  const defaultProjectSortOrder =
    DEFAULT_SIDEBAR_PROJECT_SORT_ORDER === "manual"
      ? "updated_at"
      : DEFAULT_SIDEBAR_PROJECT_SORT_ORDER;
  return (
    options.selectedEnvironmentIds.length > 0 ||
    (options.selectedProjectKey !== null && options.selectedProjectKey !== undefined) ||
    options.projectSortOrder !== defaultProjectSortOrder ||
    options.threadSortOrder !== DEFAULT_SIDEBAR_THREAD_SORT_ORDER
  );
}

export function useHomeListOptions(availableEnvironmentIds: ReadonlySet<EnvironmentId>) {
  const shared = useContext(HomeListOptionsContext);
  const [localOptions, setLocalOptions] = useState<HomeListOptions>(defaultHomeListOptions);
  const options = shared?.options ?? localOptions;
  const setOptions = shared?.setOptions ?? setLocalOptions;
  const selectedEnvironmentIds = resolveSelectedEnvironmentIds(
    options.selectedEnvironmentIds,
    availableEnvironmentIds,
  );
  const availableOptions =
    selectedEnvironmentIds === options.selectedEnvironmentIds
      ? options
      : { ...options, selectedEnvironmentIds };
  const resolvedOptions: ResolvedHomeListOptions = {
    ...availableOptions,
    projectGroupingMode: shared?.projectGroupingMode ?? "repository",
  };

  const setSelectedEnvironmentIds = useCallback(
    (value: readonly EnvironmentId[]) => {
      setOptions((current) => ({ ...current, selectedEnvironmentIds: value }));
    },
    [setOptions],
  );
  const toggleSelectedEnvironmentId = useCallback(
    (environmentId: EnvironmentId) => {
      setOptions((current) => ({
        ...current,
        selectedEnvironmentIds: toggleEnvironmentId(current.selectedEnvironmentIds, environmentId),
      }));
    },
    [setOptions],
  );
  const clearSelectedEnvironments = useCallback(() => {
    setOptions((current) => ({ ...current, selectedEnvironmentIds: [] }));
  }, [setOptions]);
  const setListMode = useCallback(
    (value: HomeListMode) => {
      setOptions((current) => ({ ...current, listMode: value }));
    },
    [setOptions],
  );
  const setProjectSortOrder = useCallback(
    (value: HomeProjectSortOrder) => {
      setOptions((current) => ({ ...current, projectSortOrder: value }));
    },
    [setOptions],
  );
  const setThreadSortOrder = useCallback(
    (value: SidebarThreadSortOrder) => {
      setOptions((current) => ({ ...current, threadSortOrder: value }));
    },
    [setOptions],
  );
  return {
    options: resolvedOptions,
    setSelectedEnvironmentIds,
    toggleSelectedEnvironmentId,
    clearSelectedEnvironments,
    setListMode,
    setProjectSortOrder,
    setThreadSortOrder,
  } as const;
}
