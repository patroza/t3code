import type { MenuAction } from "@react-native-menu/menu";
import {
  DEFAULT_OWNERSHIP_RELATION,
  isOwnershipRelation,
  type OwnershipRelation,
} from "@t3tools/client-runtime/state/identity";

import {
  DEFAULT_OWNERSHIP_FILTER,
  isOwnershipFilter,
  OWNERSHIP_FILTER_LABELS,
  OWNERSHIP_FILTERS,
  OWNERSHIP_RELATION_LABELS,
  OWNERSHIP_RELATIONS,
  type OwnershipFilter,
} from "./home-list-filter-options";

/** Chip text for the ownership entry beside environment and project filters. */
export function ownershipFilterChipLabel(
  filter: OwnershipFilter,
  relation: OwnershipRelation,
): string {
  if ((filter === "mine" || filter === "theirs") && relation !== DEFAULT_OWNERSHIP_RELATION) {
    return `${OWNERSHIP_FILTER_LABELS[filter]} · ${OWNERSHIP_RELATION_LABELS[relation]}`;
  }
  return OWNERSHIP_FILTER_LABELS[filter];
}

/** True when ownership differs from the persisted default (Mine, created or participated). */
export function ownershipFilterIsCustom(
  filter: OwnershipFilter,
  relation: OwnershipRelation,
): boolean {
  return filter !== DEFAULT_OWNERSHIP_FILTER || relation !== DEFAULT_OWNERSHIP_RELATION;
}

/** Ownership and Mine/Theirs-includes choices for the list filter chip. */
export function ownershipFilterMenuActions(
  filter: OwnershipFilter,
  relation: OwnershipRelation,
): MenuAction[] {
  const actions: MenuAction[] = [
    {
      id: "ownership",
      title: "Ownership",
      subactions: OWNERSHIP_FILTERS.map((value) => ({
        id: `ownership:${value}`,
        title: OWNERSHIP_FILTER_LABELS[value],
        state: filter === value ? "on" : "off",
      })),
    },
  ];
  if (filter === "mine" || filter === "theirs") {
    actions.push({
      id: "relation",
      title: filter === "mine" ? "Mine includes" : "Theirs includes",
      subactions: OWNERSHIP_RELATIONS.map((value) => ({
        id: `relation:${value}`,
        title: OWNERSHIP_RELATION_LABELS[value],
        state: relation === value ? "on" : "off",
      })),
    });
  }
  return actions;
}

export function selectOwnershipFilterMenuAction(
  id: string,
  handlers: {
    readonly onOwnershipFilterChange: (value: OwnershipFilter) => void;
    readonly onOwnershipRelationChange: (value: OwnershipRelation) => void;
  },
): void {
  if (id.startsWith("ownership:")) {
    const value = id.slice("ownership:".length);
    if (isOwnershipFilter(value)) handlers.onOwnershipFilterChange(value);
    return;
  }
  if (id.startsWith("relation:")) {
    const value = id.slice("relation:".length);
    if (isOwnershipRelation(value)) handlers.onOwnershipRelationChange(value);
  }
}
