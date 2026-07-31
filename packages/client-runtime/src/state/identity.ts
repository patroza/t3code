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
 * Sub-filter for Mine / Theirs: which attribution signal to use.
 * - `created` — only origin/starter person
 * - `participated` — only participant person ids
 * - `both` (default) — origin or any participant
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
 * - threads where the session claim person appears on origin or participants
 * - threads with **no person attribution** (no identity tags, channel-only
 *   stamps like `{ channel: "desktop" }`, identity-disabled servers, legacy
 *   threads) — treated as "ours" so filters stay useful offline of a map
 *
 * **Mine** with `created` / `participated` only matches that signal (and does
 * not pull in fully unattributed threads).
 *
 * **Theirs** is only threads that have at least one person tag in the active
 * relation set and do not include the claim person.
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

  // Fully unattributed (no origin, no participants) stays under Mine only for
  // the default "both" relation so created/participated refinements stay precise.
  const fullyUnattributed = origin.length === 0 && participants.size === 0;
  if (fullyUnattributed) {
    return input.mode === "mine" && relation === "both";
  }

  const people = new Set<string>();
  if (relation === "created" || relation === "both") {
    if (origin.length > 0) people.add(origin);
  }
  if (relation === "participated" || relation === "both") {
    for (const personId of participants) people.add(personId);
  }

  // Relation-specific empty (e.g. "created" with participants only) is not a match.
  if (people.size === 0) {
    return false;
  }

  const claimId = input.claimPersonId?.trim().toLowerCase() ?? "";
  // Attributed threads need a claim to classify as mine; without a claim they
  // are someone else's tags on a map-enabled env (or another person's work).
  if (claimId.length === 0) {
    return input.mode === "theirs";
  }
  const isMine = people.has(claimId);
  return input.mode === "mine" ? isMine : !isMine;
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
