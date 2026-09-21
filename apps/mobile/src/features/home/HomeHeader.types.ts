import type { EnvironmentId, SidebarThreadSortOrder } from "@t3tools/contracts";
import type { HomeProjectSortOrder } from "./homeThreadList";
import type {
  HomeListFilterMenuEnvironment,
  HomeListFilterMenuProject,
} from "./home-list-filter-menu";
import type { OwnershipFilter, OwnershipRelation } from "./home-list-options";
import type { HomeListMode, HomeThreadGrouping } from "./homeListMode";

export type HomeHeaderEnvironment = HomeListFilterMenuEnvironment;

export interface HomeHeaderProps {
  readonly environments: ReadonlyArray<HomeHeaderEnvironment>;
  readonly projects: ReadonlyArray<HomeListFilterMenuProject>;
  readonly searchQuery: string;
  readonly listMode: HomeListMode;
  readonly threadGrouping: HomeThreadGrouping;
  readonly selectedEnvironmentIds: readonly EnvironmentId[];
  readonly selectedProjectKey: string | null;
  readonly ownershipFilter: OwnershipFilter;
  readonly ownershipRelation: OwnershipRelation;
  /**
   * Hide settled from the main Threads inbox. Recency/none default on;
   * project grouping defaults off at the call site.
   */
  readonly hideSettledThreads: boolean;
  readonly projectSortOrder: HomeProjectSortOrder;
  readonly threadSortOrder: SidebarThreadSortOrder;
  readonly onSearchQueryChange: (query: string) => void;
  readonly onListModeChange: (mode: HomeListMode) => void;
  readonly onThreadGroupingChange: (grouping: HomeThreadGrouping) => void;
  readonly onClearEnvironments: () => void;
  readonly onToggleEnvironment: (environmentId: EnvironmentId) => void;
  readonly onProjectChange: (projectKey: string | null) => void;
  readonly onOwnershipFilterChange: (filter: OwnershipFilter) => void;
  readonly onOwnershipRelationChange: (relation: OwnershipRelation) => void;
  readonly onHideSettledThreadsChange: (hide: boolean) => void;
  readonly onProjectSortOrderChange: (sortOrder: HomeProjectSortOrder) => void;
  readonly onThreadSortOrderChange: (sortOrder: SidebarThreadSortOrder) => void;
  readonly onOpenEnvironments: () => void;
  readonly onOpenSettings: () => void;
  readonly onStartNewTask: () => void;
}
