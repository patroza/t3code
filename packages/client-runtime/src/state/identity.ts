/**
 * Per-environment session identity (closed-set claim against the server map).
 */
import {
  WS_METHODS,
  type IdentityClaimInput,
  type IdentitySnapshot,
  type IdentitySessionClaimResult,
  type SessionIdentityClaim,
  type ThreadParticipantSummary,
} from "@t3tools/contracts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { Atom } from "effect/unstable/reactivity";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export function createIdentityEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const snapshot = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "identity-snapshot",
    tag: WS_METHODS.identityGetSnapshot,
    staleTimeMs: 30_000,
    idleTtlMs: 60_000,
  });

  const sessionClaim = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "identity-session-claim",
    tag: WS_METHODS.identityGetSessionClaim,
    staleTimeMs: 5_000,
    idleTtlMs: 60_000,
  });

  const claim = createEnvironmentRpcCommand(runtime, {
    label: "identity-claim",
    tag: WS_METHODS.identityClaim,
  });

  const clearClaim = createEnvironmentRpcCommand(runtime, {
    label: "identity-clear-claim",
    tag: WS_METHODS.identityClearClaim,
  });

  return {
    snapshot,
    sessionClaim,
    claim,
    clearClaim,
  };
}

export type IdentityEnvironmentAtoms = ReturnType<typeof createIdentityEnvironmentAtoms>;

export function identityClaimRequired(
  snapshot: IdentitySnapshot | null | undefined,
  claimResult: IdentitySessionClaimResult | null | undefined,
): boolean {
  if (snapshot === null || snapshot === undefined) return false;
  if (!snapshot.enabled || !snapshot.claimRequired) return false;
  return claimResult?.claim == null;
}

export function filterPeopleForTypeahead(
  people: IdentitySnapshot["people"],
  query: string,
  minChars: number,
): IdentitySnapshot["people"] {
  const q = query.trim().toLowerCase();
  if (q.length < minChars) return [];
  return people.filter((person) => {
    if (person.username.includes(q)) return true;
    if (person.name?.toLowerCase().includes(q)) return true;
    return false;
  });
}

/**
 * Sub-filter for Mine / Theirs. Always a *refinement* of the mode:
 * - `both` (default) — created or participated (widest for that mode)
 * - `created` — starter/origin role only
 * - `participated` — joined without being the starter
 *
 * For a given mode, `both` is always a superset of `created` and of
 * `participated`. Looking only at one field for Theirs used to invert that
 * (Created could show more than Created-or-participated).
 */
export type OwnershipRelation = "created" | "participated" | "both";

export const DEFAULT_OWNERSHIP_RELATION: OwnershipRelation = "both";

export function isOwnershipRelation(value: unknown): value is OwnershipRelation {
  return value === "created" || value === "participated" || value === "both";
}

/**
 * Match a thread for Mine / Theirs ownership filters.
 *
 * **Mine** (relation `both`, default) includes:
 * - threads the claim person started or later joined
 * - threads with **no person attribution** (channel-only stamps, identity off,
 *   legacy) — treated as "ours" so filters stay useful offline of a map
 *
 * **Mine** + `created` / `participated` narrows to that role only (unattributed
 * threads are not included).
 *
 * **Theirs** is attributed threads the claim person is not on. Relation then
 * narrows by how *others* appear: origin set (`created`), non-starter
 * participants (`participated`), or either (`both`).
 */
export function threadMatchesMine(input: {
  readonly claimPersonId: string | null | undefined;
  readonly originPersonId?: string | null | undefined;
  readonly participantPersonIds?: ReadonlyArray<string> | null | undefined;
  readonly mode: "mine" | "theirs" | "any";
  /** Defaults to `both` (created or participated). */
  readonly relation?: OwnershipRelation;
}): boolean {
  if (input.mode === "any") return true;

  const relation = input.relation ?? DEFAULT_OWNERSHIP_RELATION;
  const origin = input.originPersonId?.trim().toLowerCase() ?? "";
  const participants = new Set<string>();
  for (const id of input.participantPersonIds ?? []) {
    const personId = id?.trim().toLowerCase() ?? "";
    if (personId.length > 0) participants.add(personId);
  }

  const fullyUnattributed = origin.length === 0 && participants.size === 0;
  // Unattributed stays under Mine only for the default "both" relation.
  if (fullyUnattributed) {
    return input.mode === "mine" && relation === "both";
  }

  const claimId = input.claimPersonId?.trim().toLowerCase() ?? "";
  const fullPeople = new Set<string>(participants);
  if (origin.length > 0) fullPeople.add(origin);

  // No session claim: attributed work is someone else's.
  if (claimId.length === 0) {
    if (input.mode === "mine") return false;
    return matchesTheirsRelation({ relation, origin, participants });
  }

  const createdByMe = origin.length > 0 && origin === claimId;
  // Joined without starting. Origin counts as created, not participated.
  const participatedByMe = !createdByMe && fullPeople.has(claimId);
  const involved = createdByMe || participatedByMe;

  if (input.mode === "mine") {
    if (relation === "created") return createdByMe;
    if (relation === "participated") return participatedByMe;
    return involved;
  }

  // Theirs: not on the thread at all, then refine by others' roles.
  if (involved) return false;
  return matchesTheirsRelation({ relation, origin, participants });
}

function matchesTheirsRelation(input: {
  readonly relation: OwnershipRelation;
  readonly origin: string;
  readonly participants: ReadonlySet<string>;
}): boolean {
  const othersCreated = input.origin.length > 0;
  // Participant list may restate the origin; any non-empty roster is enough
  // for "someone participated" when we already know the claim is not on it.
  const othersParticipated = input.participants.size > 0;
  if (input.relation === "created") return othersCreated;
  if (input.relation === "participated") return othersParticipated;
  return othersCreated || othersParticipated;
}

/** Whether the claimed person participated after someone else started the thread. */
export function isClaimedNonStarterParticipant(input: {
  readonly claimPersonId: string | null | undefined;
  readonly participants: ReadonlyArray<ThreadParticipantSummary>;
}): boolean {
  const claimId = input.claimPersonId?.trim().toLowerCase() ?? "";
  if (claimId.length === 0) return false;
  return input.participants
    .slice(1)
    .some((participant) => participant.personId.trim().toLowerCase() === claimId);
}

/** Look up the claim person for a thread's environment (multi-env clients). */
export function claimPersonIdForEnvironment(
  claimPersonIdByEnvironment: ReadonlyMap<string, string | null | undefined>,
  environmentId: string,
): string | null {
  const value = claimPersonIdByEnvironment.get(environmentId);
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export type { IdentityClaimInput, IdentitySnapshot, SessionIdentityClaim };
