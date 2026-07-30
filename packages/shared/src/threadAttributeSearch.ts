/**
 * Search terms and match helpers for thread attributes beyond title/branch:
 * identity handles (`@user`, `user@channel`, `@channel`), PR numbers (`#123`),
 * and Jira keys (`SA-123`).
 *
 * Pure string helpers for web/mobile command palette and list filters.
 * See docs/architecture/source-and-identity.md
 */

export type ThreadAttributeSourceLike = {
  readonly channel?: string | null | undefined;
  readonly personId?: string | null | undefined;
  readonly username?: string | null | undefined;
  readonly location?:
    | {
        readonly number?: number | null | undefined;
        readonly issueKey?: string | null | undefined;
        readonly kind?: string | null | undefined;
      }
    | null
    | undefined;
};

export type ThreadAttributeParticipantLike = {
  readonly personId?: string | null | undefined;
  readonly username?: string | null | undefined;
  readonly name?: string | null | undefined;
  readonly firstChannel?: string | null | undefined;
};

export type ThreadAttributeSearchInput = {
  readonly title?: string | null | undefined;
  readonly branch?: string | null | undefined;
  readonly originSource?: ThreadAttributeSourceLike | null | undefined;
  readonly participantSummaries?: ReadonlyArray<ThreadAttributeParticipantLike> | null | undefined;
  /** Additional free-form terms (project title, etc.). */
  readonly extraTerms?: ReadonlyArray<string | null | undefined> | null | undefined;
};

/** Jira-style issue keys: PROJ-123, SA-49, … */
const JIRA_KEY_PATTERN = /\b([A-Za-z][A-Za-z0-9]+-\d+)\b/g;
/** Explicit PR markers in free text / branch names. */
const PR_HASH_PATTERN = /#(\d+)\b/g;
const PR_SLUG_PATTERN = /\b(?:pr|pull)[-_/]?(\d+)\b/gi;

function addTerm(into: Set<string>, raw: string | null | undefined): void {
  if (raw === null || raw === undefined) return;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.length === 0) return;
  into.add(trimmed);
}

function addPersonTerms(
  into: Set<string>,
  person: {
    readonly username?: string | null | undefined;
    readonly personId?: string | null | undefined;
    readonly name?: string | null | undefined;
    readonly channel?: string | null | undefined;
  },
): void {
  const username = person.username?.trim().toLowerCase() ?? "";
  const personId = person.personId?.trim().toLowerCase() ?? "";
  const channel = person.channel?.trim().toLowerCase() ?? "";
  const name = person.name?.trim().toLowerCase() ?? "";

  if (username.length > 0) {
    addTerm(into, username);
    addTerm(into, `@${username}`);
    if (channel.length > 0) {
      addTerm(into, `${username}@${channel}`);
    }
  }
  if (personId.length > 0 && personId !== username) {
    addTerm(into, personId);
    addTerm(into, `@${personId}`);
    if (channel.length > 0) {
      addTerm(into, `${personId}@${channel}`);
    }
  }
  if (name.length > 0) {
    addTerm(into, name);
  }
}

function addChannelTerms(into: Set<string>, channel: string | null | undefined): void {
  const normalized = channel?.trim().toLowerCase() ?? "";
  if (normalized.length === 0) return;
  addTerm(into, normalized);
  addTerm(into, `@${normalized}`);
}

function addPrNumber(into: Set<string>, value: number | string): void {
  const digits = String(value).replace(/\D/g, "");
  if (digits.length === 0) return;
  addTerm(into, digits);
  addTerm(into, `#${digits}`);
  addTerm(into, `pr-${digits}`);
  addTerm(into, `pr/${digits}`);
}

function extractFromText(into: Set<string>, text: string | null | undefined): void {
  if (text === null || text === undefined || text.trim().length === 0) return;
  const source = text;

  for (const match of source.matchAll(JIRA_KEY_PATTERN)) {
    const key = match[1];
    if (key !== undefined) addTerm(into, key);
  }
  for (const match of source.matchAll(PR_HASH_PATTERN)) {
    const n = match[1];
    if (n !== undefined) addPrNumber(into, n);
  }
  for (const match of source.matchAll(PR_SLUG_PATTERN)) {
    const n = match[1];
    if (n !== undefined) addPrNumber(into, n);
  }
}

/**
 * Build a deduped, lowercased bag of search terms for a thread.
 * Suitable for command-palette `searchTerms` and list filters.
 */
export function buildThreadAttributeSearchTerms(
  input: ThreadAttributeSearchInput,
): ReadonlyArray<string> {
  const terms = new Set<string>();

  addTerm(terms, input.title);
  addTerm(terms, input.branch);
  if (input.branch !== null && input.branch !== undefined && input.branch.trim().length > 0) {
    addTerm(terms, `#${input.branch.trim()}`);
  }

  extractFromText(terms, input.title);
  extractFromText(terms, input.branch);

  const origin = input.originSource ?? null;
  if (origin !== null) {
    addChannelTerms(terms, origin.channel);
    addPersonTerms(terms, {
      username: origin.username,
      personId: origin.personId,
      channel: origin.channel,
    });
    if (origin.location?.number !== undefined && origin.location.number !== null) {
      addPrNumber(terms, origin.location.number);
    }
    if (origin.location?.issueKey) {
      addTerm(terms, origin.location.issueKey);
    }
  }

  for (const participant of input.participantSummaries ?? []) {
    addPersonTerms(terms, {
      username: participant.username,
      personId: participant.personId,
      name: participant.name,
      channel: participant.firstChannel,
    });
    addChannelTerms(terms, participant.firstChannel);
  }

  for (const extra of input.extraTerms ?? []) {
    addTerm(terms, extra);
    extractFromText(terms, extra);
  }

  return [...terms];
}

/**
 * Whether any search term matches the query (substring, case-insensitive).
 * Query is normalized the same way as terms (trim + lower).
 */
export function threadAttributeSearchMatches(terms: ReadonlyArray<string>, query: string): boolean {
  const normalizedQuery = query.trim().toLowerCase().replace(/\s+/g, " ");
  if (normalizedQuery.length === 0) return true;
  if (terms.length === 0) return false;

  // Direct term substring (covers @user, user@channel, #123, sa-123, title words).
  for (const term of terms) {
    if (term.includes(normalizedQuery) || normalizedQuery.includes(term)) {
      // Prefer: query is a prefix/substring of a term (user typed partial handle).
      if (term.includes(normalizedQuery)) return true;
    }
  }

  // Joined haystack for multi-word title queries.
  const haystack = terms.join(" ");
  if (haystack.includes(normalizedQuery)) return true;

  // `#42` vs bare `42` already both in terms when PR-linked.
  // `@desktop` is stored as both `desktop` and `@desktop`.
  return false;
}

/**
 * Convenience: build terms and match in one call.
 */
export function threadMatchesAttributeQuery(
  input: ThreadAttributeSearchInput,
  query: string,
): boolean {
  const normalizedQuery = query.trim();
  if (normalizedQuery.length === 0) return true;
  return threadAttributeSearchMatches(buildThreadAttributeSearchTerms(input), normalizedQuery);
}
