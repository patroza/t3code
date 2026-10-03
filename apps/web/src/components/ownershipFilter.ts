/**
 * The Mine / Theirs ownership filter, shared across every thread surface.
 *
 * The selection is a single user-level preference — "whose work am I looking
 * at" — not a per-surface one, so the Sidebar and the Board read and write the
 * same two keys and update together while both are on screen.
 *
 * The values are persisted as bare strings rather than JSON, which predates
 * `useLocalStorage`'s codec. Re-encoding them would silently reset every
 * existing selection back to the default, so this subscribes to the same
 * change channel `useLocalStorage` uses while keeping the raw format.
 *
 * @module ownershipFilter
 */
import {
  DEFAULT_OWNERSHIP_RELATION,
  isOwnershipRelation,
  threadMatchesMine,
  claimPersonIdForEnvironment,
  type OwnershipRelation,
} from "@t3tools/client-runtime/state/identity";
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useSyncExternalStore } from "react";

import {
  dispatchLocalStorageChange,
  LOCAL_STORAGE_CHANGE_EVENT,
  type LocalStorageChangeDetail,
} from "~/hooks/useLocalStorage";
import {
  DEFAULT_SIDEBAR_OWNERSHIP_FILTER,
  parseSidebarOwnershipFilter,
  SIDEBAR_OWNERSHIP_FILTER_STORAGE_KEY,
  SIDEBAR_OWNERSHIP_RELATION_STORAGE_KEY,
  type SidebarOwnershipFilter,
} from "./listEnvironmentFilter";

function readRaw(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeRaw(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // A storage failure must not take the menu down with it; the selection
    // simply does not survive a reload.
  }
  dispatchLocalStorageChange(key);
}

function subscribeToKey(key: string) {
  return (onStoreChange: () => void) => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key === key) onStoreChange();
    };
    const handleLocal = (event: CustomEvent<LocalStorageChangeDetail>) => {
      if (event.detail.key === key) onStoreChange();
    };
    window.addEventListener("storage", handleStorage);
    window.addEventListener(LOCAL_STORAGE_CHANGE_EVENT, handleLocal as EventListener);
    return () => {
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener(LOCAL_STORAGE_CHANGE_EVENT, handleLocal as EventListener);
    };
  };
}

const subscribeToMode = subscribeToKey(SIDEBAR_OWNERSHIP_FILTER_STORAGE_KEY);
const subscribeToRelation = subscribeToKey(SIDEBAR_OWNERSHIP_RELATION_STORAGE_KEY);
const readMode = () => readRaw(SIDEBAR_OWNERSHIP_FILTER_STORAGE_KEY);
const readRelation = () => readRaw(SIDEBAR_OWNERSHIP_RELATION_STORAGE_KEY);
// Server render has no storage; both fall back to the documented defaults.
const readNothing = () => null;

export interface OwnershipFilterState {
  readonly mode: SidebarOwnershipFilter;
  readonly relation: OwnershipRelation;
  readonly setMode: (mode: SidebarOwnershipFilter) => void;
  readonly setRelation: (relation: OwnershipRelation) => void;
}

/** Reads the shared ownership selection and keeps every subscriber in step. */
export function useOwnershipFilter(): OwnershipFilterState {
  const rawMode = useSyncExternalStore(subscribeToMode, readMode, readNothing);
  const rawRelation = useSyncExternalStore(subscribeToRelation, readRelation, readNothing);

  const setMode = useCallback((next: SidebarOwnershipFilter) => {
    writeRaw(SIDEBAR_OWNERSHIP_FILTER_STORAGE_KEY, next);
  }, []);
  const setRelation = useCallback((next: OwnershipRelation) => {
    writeRaw(SIDEBAR_OWNERSHIP_RELATION_STORAGE_KEY, next);
  }, []);

  return {
    mode:
      rawMode === null ? DEFAULT_SIDEBAR_OWNERSHIP_FILTER : parseSidebarOwnershipFilter(rawMode),
    relation: isOwnershipRelation(rawRelation) ? rawRelation : DEFAULT_OWNERSHIP_RELATION,
    setMode,
    setRelation,
  };
}

const EMPTY_CLAIMS: ReadonlyMap<string, string | null | undefined> = new Map();

/** The shape every thread surface already has to hand. */
export interface OwnershipFilterableThread {
  readonly environmentId: EnvironmentId;
  readonly originSource?: { readonly personId?: string | null } | null | undefined;
  readonly participantSummaries?: ReadonlyArray<{ readonly personId: string }> | undefined;
}

/**
 * Builds the ownership predicate once for a list pass.
 *
 * Every surface that lists threads must filter through this rather than
 * re-deriving the call: the Board shipped without it and silently showed
 * everyone's threads while the Sidebar beside it was filtered to Mine.
 */
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
