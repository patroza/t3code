import type { EnvironmentId } from "@t3tools/contracts";
import {
  isOwnershipRelation,
  type OwnershipRelation,
} from "@t3tools/client-runtime/state/identity";
import {
  SIDEBAR_OWNERSHIP_FILTERS,
  SIDEBAR_OWNERSHIP_FILTER_LABELS,
  SIDEBAR_OWNERSHIP_RELATIONS,
  SIDEBAR_OWNERSHIP_RELATION_LABELS,
  WEB_THREAD_GROUPING_LABELS,
  isAllEnvironmentsSelected,
  isEnvironmentSelected,
  type SidebarOwnershipFilter,
  type WebThreadGrouping,
} from "../listEnvironmentFilter";
import { Checkbox } from "../ui/checkbox";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

/** List options share the project picker so the sidebar header stays on one row. */
export function SidebarThreadFilters(props: {
  readonly ownershipFilter: SidebarOwnershipFilter;
  readonly ownershipRelation: OwnershipRelation;
  readonly threadGrouping: WebThreadGrouping;
  readonly settledShelfExpanded: boolean;
  readonly environments: ReadonlyArray<{ environmentId: EnvironmentId; label: string }>;
  readonly selectedEnvironmentIds: readonly EnvironmentId[];
  readonly onOwnershipFilterChange: (value: SidebarOwnershipFilter) => void;
  readonly onOwnershipRelationChange: (value: OwnershipRelation) => void;
  readonly onThreadGroupingChange: (value: WebThreadGrouping) => void;
  readonly onSettledShelfExpandedChange: (value: boolean) => void;
  readonly onClearEnvironments: () => void;
  readonly onToggleEnvironment: (value: EnvironmentId) => void;
}) {
  return (
    <div
      className="max-h-60 shrink-0 overflow-y-auto border-b border-border p-2"
      data-testid="sidebar-thread-filters"
    >
      <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2">
        <span className="text-xs text-muted-foreground">Ownership</span>
        <Select
          value={props.ownershipFilter}
          onValueChange={(value) => {
            if (value === "any" || value === "mine" || value === "theirs")
              props.onOwnershipFilterChange(value);
          }}
        >
          <SelectTrigger size="xs" aria-label="Ownership">
            <SelectValue>{SIDEBAR_OWNERSHIP_FILTER_LABELS[props.ownershipFilter]}</SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {SIDEBAR_OWNERSHIP_FILTERS.map((value) => (
              <SelectItem
                key={value}
                value={value}
                data-testid={`sidebar-ownership-filter-${value}`}
              >
                {SIDEBAR_OWNERSHIP_FILTER_LABELS[value]}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        {props.ownershipFilter === "mine" || props.ownershipFilter === "theirs" ? (
          <>
            <span className="text-xs text-muted-foreground">
              {props.ownershipFilter === "mine" ? "Mine includes" : "Theirs includes"}
            </span>
            <Select
              value={props.ownershipRelation}
              onValueChange={(value) => {
                if (isOwnershipRelation(value)) props.onOwnershipRelationChange(value);
              }}
            >
              <SelectTrigger
                size="xs"
                aria-label={props.ownershipFilter === "mine" ? "Mine includes" : "Theirs includes"}
              >
                <SelectValue>
                  {SIDEBAR_OWNERSHIP_RELATION_LABELS[props.ownershipRelation]}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {SIDEBAR_OWNERSHIP_RELATIONS.map((value) => (
                  <SelectItem
                    key={value}
                    value={value}
                    data-testid={`sidebar-ownership-relation-${value}`}
                  >
                    {SIDEBAR_OWNERSHIP_RELATION_LABELS[value]}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </>
        ) : null}
        <span className="text-xs text-muted-foreground">Thread ordering</span>
        <Select
          value={props.threadGrouping}
          onValueChange={(value) => {
            if (value === "project" || value === "recency") props.onThreadGroupingChange(value);
          }}
        >
          <SelectTrigger
            size="xs"
            aria-label="Thread ordering"
            data-testid="sidebar-thread-grouping"
          >
            <SelectValue>{WEB_THREAD_GROUPING_LABELS[props.threadGrouping]}</SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {(["project", "recency"] as const).map((value) => (
              <SelectItem
                key={value}
                value={value}
                data-testid={`sidebar-thread-grouping-${value}`}
              >
                {WEB_THREAD_GROUPING_LABELS[value]}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>
      <label className="mt-2 flex items-center gap-2 text-xs">
        <Checkbox
          checked={props.settledShelfExpanded}
          onCheckedChange={props.onSettledShelfExpandedChange}
          data-testid="sidebar-settled-shelf-expanded"
        />
        Expand settled shelf
      </label>
      {props.environments.length > 1 ? (
        <fieldset className="mt-2 space-y-2">
          <legend className="mb-1 text-xs text-muted-foreground">Environment</legend>
          <label className="flex items-center gap-2 text-xs">
            <Checkbox
              checked={isAllEnvironmentsSelected(props.selectedEnvironmentIds)}
              onCheckedChange={props.onClearEnvironments}
              data-testid="sidebar-environment-filter-all"
            />
            All environments
          </label>
          {props.environments.map((environment) => (
            <label key={environment.environmentId} className="flex items-center gap-2 text-xs">
              <Checkbox
                checked={isEnvironmentSelected(
                  props.selectedEnvironmentIds,
                  environment.environmentId,
                )}
                onCheckedChange={() => props.onToggleEnvironment(environment.environmentId)}
                data-testid={`sidebar-environment-filter-${environment.environmentId}`}
              />
              {environment.label}
            </label>
          ))}
        </fieldset>
      ) : null}
    </div>
  );
}
