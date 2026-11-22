import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  DEFAULT_OWNERSHIP_RELATION,
  claimPersonIdForEnvironment,
  threadMatchesMine,
  type OwnershipRelation,
} from "@t3tools/client-runtime/state/identity";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { useLocalStorage } from "~/hooks/useLocalStorage";
import {
  identityClaimPersonIdByEnvironmentAtom,
  identityEnabledEnvironmentIdsAtom,
} from "../state/identity";

/** Mine + unattributed by default, so the inbox focuses on work you started or joined. */
export type SidebarOwnershipFilter = "any" | "mine" | "mine-only" | "theirs";
export const SIDEBAR_OWNERSHIP_FILTERS = ["any", "mine", "mine-only", "theirs"] as const;
export const SIDEBAR_OWNERSHIP_RELATIONS = ["both", "created", "participated"] as const;
const DEFAULT_SIDEBAR_OWNERSHIP_FILTER: SidebarOwnershipFilter = "mine";

const SIDEBAR_OWNERSHIP_FILTER_STORAGE_KEY = "t3.sidebar.ownershipFilter";
const SIDEBAR_OWNERSHIP_RELATION_STORAGE_KEY = "t3.sidebar.ownershipRelation";
const OwnershipFilterSchema = Schema.Literals(SIDEBAR_OWNERSHIP_FILTERS);
const OwnershipRelationSchema = Schema.Literals(SIDEBAR_OWNERSHIP_RELATIONS);

export interface OwnershipFilterState {
  readonly mode: SidebarOwnershipFilter;
  readonly relation: OwnershipRelation;
  readonly setMode: (mode: SidebarOwnershipFilter) => void;
  readonly setRelation: (relation: OwnershipRelation) => void;
}

/** Reads the shared ownership selection and keeps every subscriber in step. */
export function useOwnershipFilter(): OwnershipFilterState {
  const [mode, setMode] = useLocalStorage(
    SIDEBAR_OWNERSHIP_FILTER_STORAGE_KEY,
    DEFAULT_SIDEBAR_OWNERSHIP_FILTER,
    OwnershipFilterSchema,
  );
  const [relation, setRelation] = useLocalStorage(
    SIDEBAR_OWNERSHIP_RELATION_STORAGE_KEY,
    DEFAULT_OWNERSHIP_RELATION,
    OwnershipRelationSchema,
  );
  return { mode, relation, setMode, setRelation };
}

const EMPTY_CLAIMS: ReadonlyMap<string, string | null | undefined> = new Map();

/** The shape every thread surface already has to hand. */
export interface OwnershipFilterableThread {
  readonly environmentId: EnvironmentId;
  readonly originSource?: { readonly personId?: string | null } | null | undefined;
  readonly participantSummaries?: ReadonlyArray<{ readonly personId: string }> | undefined;
}

/** Builds the ownership predicate once for a list pass. */
export function buildOwnershipPredicate(input: {
  readonly claimPersonIdByEnvironment: ReadonlyMap<string, string | null | undefined> | undefined;
  readonly mode: SidebarOwnershipFilter;
  readonly relation: OwnershipRelation;
}): (thread: OwnershipFilterableThread) => boolean {
  const claims = input.claimPersonIdByEnvironment ?? EMPTY_CLAIMS;
  return (thread) =>
    threadMatchesMine({
      claimPersonId: claimPersonIdForEnvironment(claims, thread.environmentId),
      originPersonId: thread.originSource?.personId ?? null,
      participantPersonIds: (thread.participantSummaries ?? []).map(
        (participant) => participant.personId,
      ),
      mode: input.mode,
      relation: input.relation,
    });
}

/**
 * Sidebar hook: threads from environments with an identity map follow the ownership
 * selection; environments without one are listed as before.
 */
export function useOwnedThreads(
  threads: ReadonlyArray<EnvironmentThreadShell>,
): ReadonlyArray<EnvironmentThreadShell> {
  const { mode, relation } = useOwnershipFilter();
  const claimPersonIdByEnvironment = useAtomValue(identityClaimPersonIdByEnvironmentAtom);
  const enabled = useAtomValue(identityEnabledEnvironmentIdsAtom);
  if (enabled.size === 0 || mode === "any") return threads;
  const owned = buildOwnershipPredicate({ claimPersonIdByEnvironment, mode, relation });
  return threads.filter(
    (thread) =>
      !enabled.has(thread.environmentId) ||
      owned({
        environmentId: thread.environmentId,
        originSource: thread.source.originSource,
        participantSummaries: thread.source.participantSummaries,
      }),
  );
}
