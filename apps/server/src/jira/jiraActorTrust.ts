/**
 * Jira actor trust relative to the closed-set identity map.
 *
 * When the map is off, all actors keep full agent turns (legacy behaviour).
 * When the map is on, only people with a mapped Jira accountId may run the
 * agent; everyone else may only append context to an already-linked thread.
 */
import {
  normalizeJiraAccountId,
  resolvePersonByJiraAccountId,
  type IdentityMapPerson,
} from "@t3tools/shared/identityMap";

export type JiraActorTrustMode = "full" | "context-only";

export type JiraActorTrustDecision = {
  readonly mode: JiraActorTrustMode;
  /** Mapped person when trusted; null when map is off or actor is unmapped. */
  readonly person: IdentityMapPerson | null;
  readonly reason:
    | "identity_map_disabled"
    | "mapped_jira_account"
    | "unmapped_jira_account"
    | "missing_jira_account_id";
};

export { normalizeJiraAccountId, resolvePersonByJiraAccountId };

/**
 * Classify a Jira mention actor for agent execution.
 *
 * - Map off → full (backward compatible)
 * - Map on + accountId in map → full
 * - Map on + missing/unmapped accountId → context-only
 */
export function classifyJiraActorTrust(input: {
  readonly identityMapEnabled: boolean;
  readonly actorAccountId: string | null | undefined;
  readonly people: ReadonlyArray<IdentityMapPerson>;
}): JiraActorTrustDecision {
  if (!input.identityMapEnabled) {
    return { mode: "full", person: null, reason: "identity_map_disabled" };
  }
  const normalized = normalizeJiraAccountId(input.actorAccountId);
  if (normalized === null) {
    return { mode: "context-only", person: null, reason: "missing_jira_account_id" };
  }
  const person = resolvePersonByJiraAccountId(input.people, input.actorAccountId);
  if (person === null) {
    return { mode: "context-only", person: null, reason: "unmapped_jira_account" };
  }
  return { mode: "full", person, reason: "mapped_jira_account" };
}
