import type { OwnershipRelation } from "@t3tools/client-runtime/state/identity";
import { msg } from "gt-react-native";

import { m as resolveCopy } from "../../i18n/messages";

export type { OwnershipRelation } from "@t3tools/client-runtime/state/identity";

export type OwnershipFilter = "any" | "mine" | "mine-only" | "theirs";

export const OWNERSHIP_FILTERS = [
  "any",
  "mine",
  "mine-only",
  "theirs",
] as const satisfies readonly OwnershipFilter[];

export const OWNERSHIP_RELATIONS = [
  "both",
  "created",
  "participated",
] as const satisfies readonly OwnershipRelation[];

/** Default ownership filter: Mine (created or participated, plus unattributed). */
export const DEFAULT_OWNERSHIP_FILTER: OwnershipFilter = "mine";

export function ownershipFilterLabel(filter: OwnershipFilter): string {
  switch (filter) {
    case "any":
      return resolveCopy(msg("Anyone"));
    case "mine":
      return resolveCopy(msg("Mine + unattributed"));
    case "mine-only":
      return resolveCopy(msg("Only mine"));
    case "theirs":
      return resolveCopy(msg("Theirs"));
  }
}

export function ownershipRelationLabel(relation: OwnershipRelation): string {
  switch (relation) {
    case "both":
      return resolveCopy(msg("Created or participated"));
    case "created":
      return resolveCopy(msg("Created"));
    case "participated":
      return resolveCopy(msg("Participated"));
  }
}

export function isOwnershipFilter(value: unknown): value is OwnershipFilter {
  return value === "any" || value === "mine" || value === "mine-only" || value === "theirs";
}

/** Device-local Mine/Theirs choice, persisted with the other mobile preferences. */
export interface OwnershipPreferences {
  readonly ownershipFilter?: OwnershipFilter;
  readonly ownershipRelation?: OwnershipRelation;
}

export function sanitizeOwnershipPreferences(parsed: OwnershipPreferences): OwnershipPreferences {
  return {
    ...(isOwnershipFilter(parsed.ownershipFilter)
      ? { ownershipFilter: parsed.ownershipFilter }
      : {}),
    ...(OWNERSHIP_RELATIONS.includes(parsed.ownershipRelation as OwnershipRelation)
      ? { ownershipRelation: parsed.ownershipRelation }
      : {}),
  };
}
