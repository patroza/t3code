/**
 * Parse closed-set identity map documents (YAML/JSON).
 * Shared by server (and later Discord bot) so ops keep one file format.
 *
 * See docs/architecture/source-and-identity.md
 */
import * as Schema from "effect/Schema";

export type IdentityMapDiscordRef = {
  readonly id: string;
  readonly username?: string | undefined;
};

export type IdentityMapGitHubRef = {
  readonly login: string;
  readonly id?: string | undefined;
  readonly email?: string | undefined;
  readonly name?: string | undefined;
};

export type IdentityMapJiraRef = {
  readonly accountId?: string | undefined;
  readonly email?: string | undefined;
  readonly displayName?: string | undefined;
};

export type IdentityMapPerson = {
  readonly personId: string;
  readonly username: string;
  readonly name?: string | undefined;
  readonly discord?: IdentityMapDiscordRef | undefined;
  readonly github?: IdentityMapGitHubRef | undefined;
  readonly jira?: IdentityMapJiraRef | undefined;
};

export class IdentityMapParseError extends Error {
  readonly _tag = "IdentityMapParseError";
  constructor(
    readonly pathLabel: string,
    message: string,
  ) {
    super(message);
    this.name = "IdentityMapParseError";
  }
}

const HANDLE_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const HANDLE_MAX = 128;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeHandle(value: string, field: string, label: string): string {
  const normalized = value.trim().toLowerCase();
  if (
    normalized.length === 0 ||
    normalized.length > HANDLE_MAX ||
    !HANDLE_PATTERN.test(normalized)
  ) {
    throw new IdentityMapParseError(
      label,
      `${field} must be a non-empty handle (max ${HANDLE_MAX}, pattern ${HANDLE_PATTERN}): got ${JSON.stringify(value)}`,
    );
  }
  return normalized;
}

function asDiscordSnowflake(value: unknown): string | undefined {
  const raw = asNonEmptyString(value);
  if (raw === undefined) return undefined;
  if (!/^\d{1,32}$/u.test(raw)) return undefined;
  return raw;
}

function normalizeLogin(value: unknown): string | undefined {
  const raw = asNonEmptyString(value);
  if (raw === undefined) return undefined;
  const login = raw.replace(/^@/u, "").trim();
  if (login.length === 0) return undefined;
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u.test(login)) return undefined;
  return login;
}

function parsePerson(raw: unknown, indexLabel: string, keyHint?: string): IdentityMapPerson {
  if (!isRecord(raw)) {
    throw new IdentityMapParseError(indexLabel, "person entry must be an object");
  }

  const discordNested = isRecord(raw.discord) ? raw.discord : undefined;
  const githubNested = isRecord(raw.github) ? raw.github : undefined;
  const jiraNested = isRecord(raw.jira) ? raw.jira : undefined;

  const usernameRaw =
    asNonEmptyString(raw.username) ??
    asNonEmptyString(raw.userName) ??
    (keyHint !== undefined && !/^\d+$/u.test(keyHint) ? keyHint : undefined);
  if (usernameRaw === undefined) {
    throw new IdentityMapParseError(indexLabel, 'missing required "username"');
  }
  const username = normalizeHandle(usernameRaw, "username", indexLabel);

  const personIdRaw = asNonEmptyString(raw.personId) ?? asNonEmptyString(raw.id) ?? username;
  const personId = normalizeHandle(personIdRaw, "personId", indexLabel);

  const name = asNonEmptyString(raw.name);

  const discordId =
    asDiscordSnowflake(discordNested?.id) ??
    asDiscordSnowflake(raw.discordId) ??
    asDiscordSnowflake(raw.discord_id) ??
    (keyHint !== undefined ? asDiscordSnowflake(keyHint) : undefined);
  const discordUsername =
    asNonEmptyString(discordNested?.username) ??
    asNonEmptyString(raw.discordUsername) ??
    asNonEmptyString(raw.discord_username);

  const githubLogin =
    normalizeLogin(githubNested?.login) ??
    normalizeLogin(raw.githubLogin) ??
    normalizeLogin(raw.github_login) ??
    normalizeLogin(raw.github);
  const githubId =
    asNonEmptyString(githubNested?.id)?.replace(/\D/gu, "") ||
    asNonEmptyString(raw.githubId)?.replace(/\D/gu, "") ||
    asNonEmptyString(raw.github_id)?.replace(/\D/gu, "") ||
    undefined;
  const githubEmail =
    asNonEmptyString(githubNested?.email) ??
    asNonEmptyString(raw.githubEmail) ??
    asNonEmptyString(raw.github_email);
  const githubName =
    asNonEmptyString(githubNested?.name) ??
    asNonEmptyString(raw.githubName) ??
    asNonEmptyString(raw.github_name);

  const jiraAccountId =
    asNonEmptyString(jiraNested?.accountId) ??
    asNonEmptyString(raw.jiraAccountId) ??
    asNonEmptyString(raw.jira_account_id);
  const jiraEmail =
    asNonEmptyString(jiraNested?.email) ??
    asNonEmptyString(raw.jiraEmail) ??
    asNonEmptyString(raw.jira_email);
  const jiraDisplayName =
    asNonEmptyString(jiraNested?.displayName) ??
    asNonEmptyString(raw.jiraDisplayName) ??
    asNonEmptyString(raw.jira_display_name);

  return {
    personId,
    username,
    ...(name !== undefined ? { name } : {}),
    ...(discordId !== undefined
      ? {
          discord: {
            id: discordId,
            ...(discordUsername !== undefined ? { username: discordUsername } : {}),
          },
        }
      : {}),
    ...(githubLogin !== undefined
      ? {
          github: {
            login: githubLogin,
            ...(githubId !== undefined && githubId.length > 0 ? { id: githubId } : {}),
            ...(githubEmail !== undefined ? { email: githubEmail } : {}),
            ...(githubName !== undefined ? { name: githubName } : {}),
          },
        }
      : {}),
    ...(jiraAccountId !== undefined || jiraEmail !== undefined
      ? {
          jira: {
            ...(jiraAccountId !== undefined ? { accountId: jiraAccountId } : {}),
            ...(jiraEmail !== undefined ? { email: jiraEmail } : {}),
            ...(jiraDisplayName !== undefined ? { displayName: jiraDisplayName } : {}),
          },
        }
      : {}),
  };
}

/**
 * Parse identity map document object (already JSON/YAML-parsed).
 */
export function parseIdentityMapDocument(document: unknown): ReadonlyArray<IdentityMapPerson> {
  if (document === null || document === undefined) return [];
  if (!isRecord(document)) {
    throw new IdentityMapParseError("root", "Identity map root must be an object.");
  }

  const peopleNode = document.people;
  let people: ReadonlyArray<IdentityMapPerson>;

  if (Array.isArray(peopleNode)) {
    people = peopleNode.map((entry, index) => parsePerson(entry, `[${index}]`));
  } else if (isRecord(peopleNode)) {
    people = Object.entries(peopleNode).map(([key, value]) =>
      parsePerson(value, `people["${key}"]`, key),
    );
  } else {
    const reserved = new Set(["version", "schema", "$schema"]);
    const entries = Object.entries(document).filter(([key]) => !reserved.has(key));
    if (entries.length === 0) return [];
    people = entries.map(([key, value]) => parsePerson(value, `["${key}"]`, key));
  }

  const usernames = new Set<string>();
  const personIds = new Set<string>();
  for (const person of people) {
    if (usernames.has(person.username)) {
      throw new IdentityMapParseError(person.username, `duplicate username "${person.username}"`);
    }
    if (personIds.has(person.personId)) {
      throw new IdentityMapParseError(person.personId, `duplicate personId "${person.personId}"`);
    }
    usernames.add(person.username);
    personIds.add(person.personId);
  }

  return people;
}

export function toIdentityPersonPublic(person: IdentityMapPerson) {
  return {
    personId: person.personId,
    username: person.username,
    ...(person.name !== undefined ? { name: person.name } : {}),
    links: {
      ...(person.discord?.id !== undefined ? { discordId: person.discord.id } : {}),
      ...(person.discord?.username !== undefined
        ? { discordUsername: person.discord.username }
        : {}),
      ...(person.github?.login !== undefined ? { githubLogin: person.github.login } : {}),
      ...(person.jira?.accountId !== undefined ? { jiraAccountId: person.jira.accountId } : {}),
    },
  };
}

/** Schema re-export helper for tests that want branded contracts after parse. */
export const IdentityMapPersonCount = Schema.Number;
