import { msg } from "gt-react-native";
import { m as resolveCopy } from "../../i18n/messages";
import type { MenuAction } from "@react-native-menu/menu";
import {
  DEFAULT_OWNERSHIP_RELATION,
  isOwnershipRelation,
  type OwnershipRelation,
} from "@t3tools/client-runtime/state/identity";

import {
  DEFAULT_OWNERSHIP_FILTER,
  isOwnershipFilter,
  OWNERSHIP_FILTERS,
  OWNERSHIP_RELATIONS,
  ownershipFilterLabel,
  ownershipRelationLabel,
  type OwnershipFilter,
} from "../identity/ownershipFilterOptions";

/** Chip text for the ownership entry beside environment and project filters. */
export function ownershipFilterChipLabel(
  filter: OwnershipFilter,
  relation: OwnershipRelation,
): string {
  if (
    (filter === "mine" || filter === "mine-only" || filter === "theirs") &&
    relation !== DEFAULT_OWNERSHIP_RELATION
  ) {
    return `${ownershipFilterLabel(filter)} · ${ownershipRelationLabel(relation)}`;
  }
  return ownershipFilterLabel(filter);
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
      title: resolveCopy(msg("Ownership")),
      subactions: OWNERSHIP_FILTERS.map((value) => ({
        id: `ownership:${value}`,
        title: ownershipFilterLabel(value),
        state: filter === value ? "on" : "off",
      })),
    },
  ];
  if (filter === "mine" || filter === "mine-only" || filter === "theirs") {
    actions.push({
      id: "relation",
      title:
        filter !== "theirs"
          ? resolveCopy(msg("Mine includes"))
          : resolveCopy(msg("Theirs includes")),
      subactions: OWNERSHIP_RELATIONS.map((value) => ({
        id: `relation:${value}`,
        title: ownershipRelationLabel(value),
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
