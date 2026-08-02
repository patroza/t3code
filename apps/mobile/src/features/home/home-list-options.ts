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
  DEFAULT_OWNERSHIP_RELATION,
  type OwnershipRelation,
} from "@t3tools/client-runtime/state/identity";
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
  type Dispatch,
  type SetStateAction,
} from "react";

import { resolveSelectedEnvironmentIds, toggleEnvironmentId } from "./homeEnvironmentFilter";
import {
  DEFAULT_HOME_LIST_MODE,
  DEFAULT_HOME_THREAD_GROUPING,
  type HomeListMode,
  type HomeThreadGrouping,
} from "./homeListMode";
import type { HomeProjectSortOrder } from "./homeThreadList";

export type { OwnershipRelation };
export { DEFAULT_OWNERSHIP_RELATION };

export interface HomeListOptions {
  /**
   * Multi-select environment filter. Empty means all environments.
   * Applies to Threads and Board modes. Persisted on device when
   * the provider is given a storage callback.
   */
  readonly selectedEnvironmentIds: readonly EnvironmentId[];
  readonly ownershipFilter: OwnershipFilter;
  /**
   * Sub-filter for mine/theirs: created, participated, or both (default).
   * Ignored when ownership is "any". Persisted with ownership filter.
   */
  readonly ownershipRelation: OwnershipRelation;
  readonly listMode: HomeListMode;
  /** Organization of the Threads list (ignored on Board). */
  readonly threadGrouping: HomeThreadGrouping;
  readonly projectSortOrder: HomeProjectSortOrder;
  readonly threadSortOrder: SidebarThreadSortOrder;
}

export type OwnershipFilter = "any" | "mine" | "theirs";

export const OWNERSHIP_FILTERS = [
  "any",
  "mine",
  "theirs",
] as const satisfies readonly OwnershipFilter[];

export const OWNERSHIP_FILTER_LABELS: Record<OwnershipFilter, string> = {
  any: "Anyone",
  mine: "Mine",
  theirs: "Theirs",
};

export const OWNERSHIP_RELATIONS = [
  "both",
  "created",
  "participated",
] as const satisfies readonly OwnershipRelation[];

export const OWNERSHIP_RELATION_LABELS: Record<OwnershipRelation, string> = {
  both: "Created or participated",
  created: "Created",
  participated: "Participated",
};

export function isOwnershipFilter(value: unknown): value is OwnershipFilter {
  return value === "any" || value === "mine" || value === "theirs";
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

/** Default ownership filter: Mine (created or participated, plus unattributed). */
export const DEFAULT_OWNERSHIP_FILTER: OwnershipFilter = "mine";

function defaultHomeListOptions(): HomeListOptions {
  return {
    selectedEnvironmentIds: [],
    ownershipFilter: DEFAULT_OWNERSHIP_FILTER,
    ownershipRelation: DEFAULT_OWNERSHIP_RELATION,
    listMode: DEFAULT_HOME_LIST_MODE,
    threadGrouping: DEFAULT_HOME_THREAD_GROUPING,
    projectSortOrder:
      DEFAULT_SIDEBAR_PROJECT_SORT_ORDER === "manual"
        ? "updated_at"
        : DEFAULT_SIDEBAR_PROJECT_SORT_ORDER,
    threadSortOrder: DEFAULT_SIDEBAR_THREAD_SORT_ORDER,
  };
}

function environmentIdsKey(ids: readonly EnvironmentId[]): string {
  return ids.join("\0");
}

interface HomeListOptionsContextValue {
  readonly options: HomeListOptions;
  readonly setOptions: Dispatch<SetStateAction<HomeListOptions>>;
  readonly projectGroupingMode: SidebarProjectGroupingMode;
}

const HomeListOptionsContext = createContext<HomeListOptionsContextValue | null>(null);

/**
 * Keeps list preferences stable while the app moves between compact and split
 * shells. Optional stored* + store callbacks make filters survive app restarts
 * (device preferences). Ownership is included so Mine/Theirs does not reset
 * on every launch (especially painful on mobile).
 */
export function HomeListOptionsProvider({
  children,
  projectGroupingMode,
  /**
   * `undefined` = storage not loaded yet (do not hydrate).
   * Array (possibly empty) = loaded value to apply once.
   */
  storedEnvironmentIds,
  onStoreEnvironmentIds,
  /**
   * `undefined` = storage not loaded yet (do not hydrate).
   * Valid grouping = apply once when preferences land.
   */
  storedThreadGrouping,
  onStoreThreadGrouping,
  /**
   * `undefined` = storage not loaded yet (do not hydrate).
   */
  storedOwnershipFilter,
  onStoreOwnershipFilter,
  storedOwnershipRelation,
  onStoreOwnershipRelation,
}: PropsWithChildren<{
  readonly projectGroupingMode: SidebarProjectGroupingMode;
  readonly storedEnvironmentIds?: readonly EnvironmentId[];
  readonly onStoreEnvironmentIds?: (ids: readonly EnvironmentId[]) => void;
  readonly storedThreadGrouping?: HomeThreadGrouping;
  readonly onStoreThreadGrouping?: (grouping: HomeThreadGrouping) => void;
  readonly storedOwnershipFilter?: OwnershipFilter;
  readonly onStoreOwnershipFilter?: (filter: OwnershipFilter) => void;
  readonly storedOwnershipRelation?: OwnershipRelation;
  readonly onStoreOwnershipRelation?: (relation: OwnershipRelation) => void;
}>) {
  const [options, setOptions] = useState<HomeListOptions>(defaultHomeListOptions);
  const envFilterHydratedRef = useRef(false);
  const lastPersistedEnvKeyRef = useRef<string | null>(null);
  const threadGroupingHydratedRef = useRef(false);
  const lastPersistedThreadGroupingRef = useRef<HomeThreadGrouping | null>(null);
  const ownershipFilterHydratedRef = useRef(false);
  const lastPersistedOwnershipFilterRef = useRef<OwnershipFilter | null>(null);
  const ownershipRelationHydratedRef = useRef(false);
  const lastPersistedOwnershipRelationRef = useRef<OwnershipRelation | null>(null);

  useEffect(() => {
    if (envFilterHydratedRef.current) return;
    if (storedEnvironmentIds === undefined) return;
    if (storedEnvironmentIds.length > 0) {
      setOptions((current) => ({
        ...current,
        selectedEnvironmentIds: storedEnvironmentIds,
      }));
      lastPersistedEnvKeyRef.current = environmentIdsKey(storedEnvironmentIds);
    } else {
      lastPersistedEnvKeyRef.current = "";
    }
    envFilterHydratedRef.current = true;
  }, [storedEnvironmentIds]);

  useEffect(() => {
    if (!envFilterHydratedRef.current) return;
    if (!onStoreEnvironmentIds) return;
    const key = environmentIdsKey(options.selectedEnvironmentIds);
    if (lastPersistedEnvKeyRef.current === key) return;
    lastPersistedEnvKeyRef.current = key;
    onStoreEnvironmentIds(options.selectedEnvironmentIds);
  }, [onStoreEnvironmentIds, options.selectedEnvironmentIds]);

  useEffect(() => {
    if (threadGroupingHydratedRef.current) return;
    if (storedThreadGrouping === undefined) return;
    setOptions((current) =>
      current.threadGrouping === storedThreadGrouping
        ? current
        : { ...current, threadGrouping: storedThreadGrouping },
    );
    lastPersistedThreadGroupingRef.current = storedThreadGrouping;
    threadGroupingHydratedRef.current = true;
  }, [storedThreadGrouping]);

  useEffect(() => {
    if (!threadGroupingHydratedRef.current) return;
    if (!onStoreThreadGrouping) return;
    if (lastPersistedThreadGroupingRef.current === options.threadGrouping) return;
    lastPersistedThreadGroupingRef.current = options.threadGrouping;
    onStoreThreadGrouping(options.threadGrouping);
  }, [onStoreThreadGrouping, options.threadGrouping]);

  useEffect(() => {
    if (ownershipFilterHydratedRef.current) return;
    if (storedOwnershipFilter === undefined) return;
    setOptions((current) =>
      current.ownershipFilter === storedOwnershipFilter
        ? current
        : { ...current, ownershipFilter: storedOwnershipFilter },
    );
    lastPersistedOwnershipFilterRef.current = storedOwnershipFilter;
    ownershipFilterHydratedRef.current = true;
  }, [storedOwnershipFilter]);

  useEffect(() => {
    if (!ownershipFilterHydratedRef.current) return;
    if (!onStoreOwnershipFilter) return;
    if (lastPersistedOwnershipFilterRef.current === options.ownershipFilter) return;
    lastPersistedOwnershipFilterRef.current = options.ownershipFilter;
    onStoreOwnershipFilter(options.ownershipFilter);
  }, [onStoreOwnershipFilter, options.ownershipFilter]);

  useEffect(() => {
    if (ownershipRelationHydratedRef.current) return;
    if (storedOwnershipRelation === undefined) return;
    setOptions((current) =>
      current.ownershipRelation === storedOwnershipRelation
        ? current
        : { ...current, ownershipRelation: storedOwnershipRelation },
    );
    lastPersistedOwnershipRelationRef.current = storedOwnershipRelation;
    ownershipRelationHydratedRef.current = true;
  }, [storedOwnershipRelation]);

  useEffect(() => {
    if (!ownershipRelationHydratedRef.current) return;
    if (!onStoreOwnershipRelation) return;
    if (lastPersistedOwnershipRelationRef.current === options.ownershipRelation) return;
    lastPersistedOwnershipRelationRef.current = options.ownershipRelation;
    onStoreOwnershipRelation(options.ownershipRelation);
  }, [onStoreOwnershipRelation, options.ownershipRelation]);

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
    options.ownershipFilter !== DEFAULT_OWNERSHIP_FILTER ||
    options.ownershipRelation !== DEFAULT_OWNERSHIP_RELATION ||
    (options.selectedProjectKey !== null && options.selectedProjectKey !== undefined) ||
    options.threadGrouping !== DEFAULT_HOME_THREAD_GROUPING ||
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
  const setOwnershipFilter = useCallback(
    (value: OwnershipFilter) => {
      setOptions((current) => ({ ...current, ownershipFilter: value }));
    },
    [setOptions],
  );
  const setOwnershipRelation = useCallback(
    (value: OwnershipRelation) => {
      setOptions((current) => ({ ...current, ownershipRelation: value }));
    },
    [setOptions],
  );
  const setThreadGrouping = useCallback(
    (value: HomeThreadGrouping) => {
      setOptions((current) => ({ ...current, threadGrouping: value }));
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
    setOwnershipFilter,
    setOwnershipRelation,
    setListMode,
    setThreadGrouping,
    setProjectSortOrder,
    setThreadSortOrder,
  } as const;
}
