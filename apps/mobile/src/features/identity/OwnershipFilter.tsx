import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  DEFAULT_OWNERSHIP_RELATION,
  threadMatchesMine,
} from "@t3tools/client-runtime/state/identity";
import { msg, useGT } from "gt-react-native";
import { AsyncResult } from "effect/reactivity";
import { useMemo } from "react";

import type { AppBarMenuItem } from "../../components/ui/AppBar.types";
import { m as resolveCopy } from "../../i18n/messages";
import { identityClaimPersonIdByEnvironmentAtom } from "../../state/identity";
import { mobilePreferencesAtom, saveMobilePreferences } from "../../state/preferences";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  ownershipFilterChipLabel,
  ownershipFilterIsCustom,
  ownershipFilterMenuActions,
  selectOwnershipFilterMenuAction,
} from "../home/thread-list-ownership-filter";
import { ListFilterMenu } from "../layout/workspace/ListFilterMenu";
import {
  DEFAULT_OWNERSHIP_FILTER,
  OWNERSHIP_FILTERS,
  OWNERSHIP_RELATIONS,
  ownershipFilterLabel,
  ownershipRelationLabel,
} from "./ownershipFilterOptions";

/** The persisted Mine/Theirs choice, and whether any environment has an identity claim. */
export function useOwnershipFilter() {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomCommand(saveMobilePreferences);
  const claimPersonIdByEnvironment = useAtomValue(identityClaimPersonIdByEnvironmentAtom);
  const stored = AsyncResult.isSuccess(preferences) ? preferences.value : {};
  const filter = stored.ownershipFilter ?? DEFAULT_OWNERSHIP_FILTER;
  const relation = stored.ownershipRelation ?? DEFAULT_OWNERSHIP_RELATION;
  const enabled = [...claimPersonIdByEnvironment.values()].some((personId) => personId !== null);
  return {
    filter,
    relation,
    enabled,
    claimPersonIdByEnvironment,
    setFilter: (ownershipFilter: typeof filter) => void savePreferences({ ownershipFilter }),
    setRelation: (ownershipRelation: typeof relation) =>
      void savePreferences({ ownershipRelation }),
  };
}

/** Environments without a claim (identity off there) keep every thread. */
export function useOwnershipFilteredThreads<Thread extends EnvironmentThreadShell>(
  threads: ReadonlyArray<Thread>,
): ReadonlyArray<Thread> {
  const { filter, relation, claimPersonIdByEnvironment } = useOwnershipFilter();
  return useMemo(
    () =>
      threads.filter((thread) => {
        const claimPersonId = claimPersonIdByEnvironment.get(thread.environmentId) ?? null;
        if (claimPersonId === null) return true;
        return threadMatchesMine({
          claimPersonId,
          originPersonId: thread.source.originSource?.personId ?? null,
          participantPersonIds: (thread.source.participantSummaries ?? []).map(
            (participant) => participant.personId,
          ),
          mode: filter,
          relation,
        });
      }),
    [claimPersonIdByEnvironment, filter, relation, threads],
  );
}

/** Adds the ownership sections to an app-bar list filter while identity is on. */
export function useOwnershipFilterMenu() {
  const ownership = useOwnershipFilter();
  return <Filter extends { readonly customized: boolean; readonly items: AppBarMenuItem[] }>(
    base: Filter,
  ): Filter => {
    if (!ownership.enabled) return base;
    const items: AppBarMenuItem[] = [
      {
        id: "ownership",
        title: resolveCopy(msg("Ownership")),
        items: OWNERSHIP_FILTERS.map((value) => ({
          id: `ownership:${value}`,
          title: ownershipFilterLabel(value),
          selected: ownership.filter === value,
          onPress: () => ownership.setFilter(value),
        })),
      },
    ];
    if (ownership.filter !== "any") {
      items.push({
        id: "relation",
        title:
          ownership.filter === "theirs"
            ? resolveCopy(msg("Theirs includes"))
            : resolveCopy(msg("Mine includes")),
        items: OWNERSHIP_RELATIONS.map((value) => ({
          id: `relation:${value}`,
          title: ownershipRelationLabel(value),
          selected: ownership.relation === value,
          onPress: () => ownership.setRelation(value),
        })),
      });
    }
    return {
      ...base,
      customized: base.customized || ownershipFilterIsCustom(ownership.filter, ownership.relation),
      items: [...base.items, ...items],
    };
  };
}

/** Mine/Theirs chip beside the environment and project chips. */
export function OwnershipFilterChip() {
  const gt = useGT();
  const ownership = useOwnershipFilter();
  if (!ownership.enabled) return null;
  return (
    <ListFilterMenu
      label={ownershipFilterChipLabel(ownership.filter, ownership.relation)}
      accessibilityLabel={gt("Filter threads by ownership")}
      active={ownershipFilterIsCustom(ownership.filter, ownership.relation)}
      actions={ownershipFilterMenuActions(ownership.filter, ownership.relation)}
      onSelect={(id) =>
        selectOwnershipFilterMenuAction(id, {
          onOwnershipFilterChange: ownership.setFilter,
          onOwnershipRelationChange: ownership.setRelation,
        })
      }
    />
  );
}
