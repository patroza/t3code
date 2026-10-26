import type { RepositoryIdentity } from "@t3tools/contracts";

/** Prefer `omegent-link-github:<org>/<repo>` resolved by repository identity.
 * Keep `omegent-link-<shortName>` and legacy `t3-<shortName>` aliases working for existing channels.
 */

const LEGACY_RESERVED_TOPIC_TAG_NAMES = new Set(["ips"]);
const TOPIC_SHORT_NAME_PATTERN = String.raw`[a-z0-9]+(?:-[a-z0-9]+)*`;
// GitHub allows a single character and up to 100. The name must start and end
// with an alphanumeric so `org/` and `repo.` do not match.
const GITHUB_NAME = String.raw`[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?`;
const GITHUB_TOPIC_TAG = new RegExp(
  String.raw`\bomegent-link-github:(${GITHUB_NAME})/(${GITHUB_NAME})(?!/)\b`,
  "giu",
);

export interface GithubRepositoryRef {
  readonly owner: string;
  readonly repo: string;
}

export type TopicProjectBinding =
  | { readonly kind: "github"; readonly repository: GithubRepositoryRef }
  | { readonly kind: "shortName"; readonly shortName: string };

export interface GithubProjectCandidate {
  readonly repositoryIdentity?: RepositoryIdentity | null | undefined;
}

export type GithubProjectMatchRank = "primary" | "origin" | "remote";

const RANK_ORDER: Record<GithubProjectMatchRank, number> = {
  primary: 0,
  origin: 1,
  remote: 2,
};

function githubRepositoryLabel(repository: GithubRepositoryRef): string {
  return `${repository.owner}/${repository.repo}`;
}

export function topicProjectBindingLabel(binding: TopicProjectBinding): string {
  return binding.kind === "github" ? githubRepositoryLabel(binding.repository) : binding.shortName;
}

function firstTopicShortName(topic: string, prefix: "omegent-link" | "t3"): string | null {
  const pattern = new RegExp(String.raw`\b${prefix}-(${TOPIC_SHORT_NAME_PATTERN})\b`, "giu");
  const reserved = prefix === "t3" ? LEGACY_RESERVED_TOPIC_TAG_NAMES : null;
  for (const match of topic.matchAll(pattern)) {
    const shortName = match[1]?.toLowerCase();
    if (shortName === undefined || reserved?.has(shortName) === true) continue;
    // `omegent-link-github:org/repo` is a repository tag. The word boundary
    // before the colon would otherwise read it as the short name "github".
    const end = (match.index ?? 0) + match[0].length;
    if (prefix === "omegent-link" && topic.charAt(end) === ":") continue;
    return shortName;
  }
  return null;
}

/**
 * Legacy project short name from a channel topic.
 * Prefers `omegent-link-<shortName>`. Falls back to `t3-<shortName>`.
 * `omegent-ips` / `t3-ips` are stream opt-ins, not project names.
 * `omegent-link-github:<org>/<repo>` is not a short name.
 */
export function parseTopicShortName(topic: string | null | undefined): string | null {
  if (topic === null || topic === undefined || topic.length === 0) return null;
  return firstTopicShortName(topic, "omegent-link") ?? firstTopicShortName(topic, "t3");
}

/** First `omegent-link-github:<org>/<repo>` tag, lowercased. */
export function parseTopicGithubRepository(
  topic: string | null | undefined,
): GithubRepositoryRef | null {
  if (topic === null || topic === undefined || topic.length === 0) return null;
  const match = GITHUB_TOPIC_TAG.exec(topic);
  GITHUB_TOPIC_TAG.lastIndex = 0;
  const owner = match?.[1]?.toLowerCase();
  const repo = match?.[2]?.toLowerCase();
  if (owner === undefined || repo === undefined) return null;
  return { owner, repo };
}

/**
 * Project binding from a channel topic.
 * A GitHub tag wins when both forms are present, so a channel can add the
 * repository tag before the short name is removed.
 */
export function parseTopicProjectBinding(
  topic: string | null | undefined,
): TopicProjectBinding | null {
  const repository = parseTopicGithubRepository(topic);
  if (repository !== null) return { kind: "github", repository };
  const shortName = parseTopicShortName(topic);
  if (shortName !== null) return { kind: "shortName", shortName };
  return null;
}

export function topicHasProjectBinding(topic: string | null | undefined): boolean {
  return parseTopicProjectBinding(topic) !== null;
}

function githubCanonicalKey(repository: GithubRepositoryRef): string {
  return `github.com/${repository.owner}/${repository.repo}`;
}

function sameRepository(left: GithubRepositoryRef, right: GithubRepositoryRef): boolean {
  return left.owner === right.owner && left.repo === right.repo;
}

function refFromCanonicalKey(canonicalKey: string): GithubRepositoryRef | null {
  const match = /^github\.com\/([^/]+)\/([^/]+)$/iu.exec(canonicalKey.trim());
  const owner = match?.[1]?.toLowerCase();
  const repo = match?.[2]?.toLowerCase();
  if (owner === undefined || repo === undefined) return null;
  return { owner, repo };
}

function identityMatchesRepository(
  identity: {
    readonly canonicalKey?: string | undefined;
    readonly provider?: string | undefined;
    readonly owner?: string | undefined;
    readonly name?: string | undefined;
  },
  repository: GithubRepositoryRef,
): boolean {
  const key = identity.canonicalKey?.trim().toLowerCase();
  if (key === githubCanonicalKey(repository)) return true;
  return (
    identity.provider === "github" &&
    identity.owner?.toLowerCase() === repository.owner &&
    identity.name?.toLowerCase() === repository.repo
  );
}

/**
 * How strongly a project is that GitHub repository.
 * Primary identity beats the checkout's own origin (a fork whose upstream is
 * the canonical remote) which beats any other configured remote.
 */
function githubRepositoryMatchRank(
  project: GithubProjectCandidate,
  repository: GithubRepositoryRef,
): GithubProjectMatchRank | null {
  const identity = project.repositoryIdentity;
  if (identity == null) return null;
  if (identityMatchesRepository(identity, repository)) return "primary";
  const originKey = identity.origin?.canonicalKey;
  if (
    originKey !== undefined &&
    identityMatchesRepository({ canonicalKey: originKey }, repository)
  ) {
    return "origin";
  }
  for (const remote of identity.remotes ?? []) {
    if (identityMatchesRepository(remote, repository)) return "remote";
  }
  return null;
}

export function selectProjectForGithubRepository<P extends GithubProjectCandidate>(
  projects: readonly P[],
  repository: GithubRepositoryRef,
):
  | { readonly kind: "match"; readonly project: P; readonly rank: GithubProjectMatchRank }
  | {
      readonly kind: "ambiguous";
      readonly projects: readonly P[];
      readonly rank: GithubProjectMatchRank;
    }
  | { readonly kind: "none" } {
  const ranked = projects.flatMap((project) => {
    const rank = githubRepositoryMatchRank(project, repository);
    return rank === null ? [] : [{ project, rank }];
  });
  const best = ranked.reduce<number | null>(
    (lowest, entry) =>
      lowest === null || RANK_ORDER[entry.rank] < lowest ? RANK_ORDER[entry.rank] : lowest,
    null,
  );
  if (best === null) return { kind: "none" };
  const winners = ranked.filter((entry) => RANK_ORDER[entry.rank] === best);
  const rank = winners[0]!.rank;
  if (winners.length === 1) return { kind: "match", project: winners[0]!.project, rank };
  return { kind: "ambiguous", projects: winners.map((entry) => entry.project), rank };
}

/** Every GitHub repository this identity answers to, primary first. */
export function githubRepositoryRefsOf(
  identity: RepositoryIdentity | null | undefined,
): readonly GithubRepositoryRef[] {
  if (identity == null) return [];
  const refs: GithubRepositoryRef[] = [];
  const push = (ref: GithubRepositoryRef | null) => {
    if (ref === null || refs.some((existing) => sameRepository(existing, ref))) return;
    refs.push(ref);
  };
  push(refFromCanonicalKey(identity.canonicalKey));
  if (identity.provider === "github" && identity.owner && identity.name) {
    push({ owner: identity.owner.toLowerCase(), repo: identity.name.toLowerCase() });
  }
  push(
    identity.origin?.canonicalKey === undefined
      ? null
      : refFromCanonicalKey(identity.origin.canonicalKey),
  );
  for (const remote of identity.remotes ?? []) {
    push(refFromCanonicalKey(remote.canonicalKey));
    if (remote.provider === "github" && remote.owner && remote.name) {
      push({ owner: remote.owner.toLowerCase(), repo: remote.name.toLowerCase() });
    }
  }
  return refs;
}
