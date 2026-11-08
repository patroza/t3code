import type { SidebarThreadSortOrder } from "@t3tools/contracts";
import type { OwnershipRelation } from "@t3tools/client-runtime/state/identity";
import type { HomeProjectSortOrder } from "./homeThreadList";

export type { OwnershipRelation } from "@t3tools/client-runtime/state/identity";

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
