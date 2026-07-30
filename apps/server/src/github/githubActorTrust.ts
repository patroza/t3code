/**
 * GitHub actor trust relative to the closed-set identity map.
 *
 * When the map is off, collaborator permission alone gates agent turns
 * (legacy behaviour). When the map is on, the actor must also resolve to a
 * mapped person (github id or login) — so public-repo write access or
 * outside collaborators cannot drive the host unless listed.
 */
import {
  findPersonByGithubId,
  findPersonByGithubLogin,
  type IdentityMapPerson,
} from "@t3tools/shared/identityMap";

export type GitHubActorTrustMode = "full" | "denied";

export type GitHubActorTrustDecision = {
  readonly mode: GitHubActorTrustMode;
  readonly person: IdentityMapPerson | null;
  readonly reason:
    | "identity_map_disabled"
    | "mapped_github_id"
    | "mapped_github_login"
    | "unmapped_github_actor"
    | "missing_github_actor";
};

export function resolvePersonByGitHubActor(
  people: ReadonlyArray<IdentityMapPerson>,
  input: {
    readonly actorId: number | string | null | undefined;
    readonly actorLogin: string | null | undefined;
  },
): {
  readonly person: IdentityMapPerson;
  readonly reason: "mapped_github_id" | "mapped_github_login";
} | null {
  if (input.actorId !== null && input.actorId !== undefined && String(input.actorId).length > 0) {
    const byId = findPersonByGithubId(people, input.actorId);
    if (byId !== null) return { person: byId, reason: "mapped_github_id" };
  }
  const login = input.actorLogin?.trim() ?? "";
  if (login.length > 0) {
    const byLogin = findPersonByGithubLogin(people, login);
    if (byLogin !== null) return { person: byLogin, reason: "mapped_github_login" };
  }
  return null;
}

/**
 * Classify a GitHub mention actor for agent execution.
 *
 * - Map off → full (permission floor still enforced separately)
 * - Map on + id/login in map → full
 * - Map on + unmapped/missing → denied (no agent turn)
 */
export function classifyGitHubActorTrust(input: {
  readonly identityMapEnabled: boolean;
  readonly actorId: number | string | null | undefined;
  readonly actorLogin: string | null | undefined;
  readonly people: ReadonlyArray<IdentityMapPerson>;
}): GitHubActorTrustDecision {
  if (!input.identityMapEnabled) {
    return { mode: "full", person: null, reason: "identity_map_disabled" };
  }
  const login = input.actorLogin?.trim() ?? "";
  const hasId =
    input.actorId !== null && input.actorId !== undefined && String(input.actorId).length > 0;
  if (!hasId && login.length === 0) {
    return { mode: "denied", person: null, reason: "missing_github_actor" };
  }
  const hit = resolvePersonByGitHubActor(input.people, {
    actorId: input.actorId,
    actorLogin: input.actorLogin,
  });
  if (hit === null) {
    return { mode: "denied", person: null, reason: "unmapped_github_actor" };
  }
  return { mode: "full", person: hit.person, reason: hit.reason };
}
