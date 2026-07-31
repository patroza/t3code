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

/** Match a thread as "mine" against the session claim personId. */
export function threadMatchesMine(input: {
  readonly claimPersonId: string | null | undefined;
  readonly originPersonId?: string | null | undefined;
  readonly participantPersonIds?: ReadonlyArray<string> | null | undefined;
  readonly mode: "mine" | "theirs" | "any";
}): boolean {
  if (input.mode === "any") return true;
  const claimId = input.claimPersonId?.trim().toLowerCase() ?? "";
  // No claim for this environment (map off, or user never signed up there):
  // ownership is unclassifiable — hide from both Mine and Theirs. Multi-env
  // clients with primary=smart (no map) previously used a single empty claim
  // and treated every thread as Theirs, which made Mine look broken for t3vm.
  if (claimId.length === 0) return false;
  const people = new Set<string>();
  if (input.originPersonId) people.add(input.originPersonId.trim().toLowerCase());
  for (const id of input.participantPersonIds ?? []) {
    people.add(id.trim().toLowerCase());
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
