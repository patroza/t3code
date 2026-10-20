import { DEFAULT_OWNERSHIP_FILTER, type OwnershipFilter } from "./home-list-filter-options";
export {
  DEFAULT_OWNERSHIP_FILTER,
  isOwnershipFilter,
  OWNERSHIP_FILTERS,
  OWNERSHIP_FILTER_LABELS,
  OWNERSHIP_RELATIONS,
  OWNERSHIP_RELATION_LABELS,
  PROJECT_SORT_OPTIONS,
  THREAD_SORT_OPTIONS,
  type OwnershipFilter,
} from "./home-list-filter-options";
import { useAtomSet } from "@effect/atom-react";
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
  useCallback,
  useMemo,
  createContext,
  createElement,
  useContext,
  useEffect,
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
import type { ThreadListFilters } from "../../persistence/mobile-preferences";
import { updateMobilePreferencesAtom } from "../../state/preferences";
import type { HomeProjectSortOrder } from "./homeThreadList";

export type { OwnershipRelation };
export { DEFAULT_OWNERSHIP_RELATION };

export interface HomeListOptions {
  /**
   * Multi-select environment filter. Empty means all environments.
   * Applies to Threads mode. Persisted on device when
   * the provider is given a storage callback.
   */
  readonly selectedEnvironmentIds: readonly EnvironmentId[];
  readonly selectedProjectKey: string | null;
  readonly ownershipFilter: OwnershipFilter;
  /**
   * Sub-filter for mine/theirs: created, participated, or both (default).
   * Ignored when ownership is "any". Persisted with ownership filter.
   */
  readonly ownershipRelation: OwnershipRelation;
  readonly listMode: HomeListMode;
  /** Organization of the Threads list. */
  readonly threadGrouping: HomeThreadGrouping;
  readonly projectSortOrder: HomeProjectSortOrder;
  readonly threadSortOrder: SidebarThreadSortOrder;
}

export interface ResolvedHomeListOptions extends HomeListOptions {
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly projectGroupingMode: SidebarProjectGroupingMode;
}

export function resolveProjectGroupingMode(
  projectGroupingEnabled: boolean | undefined,
): SidebarProjectGroupingMode {
  return projectGroupingEnabled === false ? "separate" : "repository";
}

function defaultHomeListOptions(filters?: ThreadListFilters): HomeListOptions {
  return {
    selectedEnvironmentIds: filters?.environmentId ? [filters.environmentId] : [],
    selectedProjectKey: filters?.projectKey ?? null,
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

export function HomeListOptionsProvider({
  children,
  projectGroupingMode,
  savedFilters,
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
  readonly savedFilters?: ThreadListFilters | undefined;
  readonly storedEnvironmentIds?: readonly EnvironmentId[];
  readonly onStoreEnvironmentIds?: (ids: readonly EnvironmentId[]) => void;
  readonly storedThreadGrouping?: HomeThreadGrouping;
  readonly onStoreThreadGrouping?: (grouping: HomeThreadGrouping) => void;
  readonly storedOwnershipFilter?: OwnershipFilter;
  readonly onStoreOwnershipFilter?: (filter: OwnershipFilter) => void;
  readonly storedOwnershipRelation?: OwnershipRelation;
  readonly onStoreOwnershipRelation?: (relation: OwnershipRelation) => void;
}>) {
  const [options, setOptions] = useState<HomeListOptions>(() =>
    defaultHomeListOptions(savedFilters),
  );
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const saved = useRef(savedFilters);
  const environmentId =
    options.selectedEnvironmentIds.length === 1 ? options.selectedEnvironmentIds[0]! : null;
  const projectKey = options.selectedProjectKey;
  useEffect(() => {
    if (
      (saved.current?.environmentId ?? null) === environmentId &&
      (saved.current?.projectKey ?? null) === projectKey
    )
      return;
    saved.current = { environmentId, projectKey };
    savePreferences({ threadListFilters: saved.current });
  }, [environmentId, projectKey, savePreferences]);
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
    selectedEnvironmentId: selectedEnvironmentIds.length === 1 ? selectedEnvironmentIds[0]! : null,
    projectGroupingMode: shared?.projectGroupingMode ?? "repository",
  };

  const setSelectedProjectKey = useCallback(
    (value: string | null) => {
      setOptions((current) => ({ ...current, selectedProjectKey: value }));
    },
    [setOptions],
  );
  const setSelectedEnvironmentId = useCallback(
    (value: EnvironmentId | null) => {
      setOptions((current) => ({
        ...current,
        selectedEnvironmentIds: value === null ? [] : [value],
      }));
    },
    [setOptions],
  );
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
    setSelectedProjectKey,
    setSelectedEnvironmentId,
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
