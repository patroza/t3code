// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off tryCatchInEffectGen:off
/**
 * Operator-maintained map from Discord (and optional Jira) identities to GitHub
 * identities used for commit/PR co-authorship.
 *
 * Loaded once at bot startup from T3_IDENTITY_MAP_PATH (same delivery path as
 * project-aliases: staged secrets share). Absent path → empty map (feature off).
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export interface DiscordIdentityRef {
  readonly id: string;
  readonly username?: string | undefined;
}

export interface GitHubIdentityRef {
  /** GitHub login (without @). */
  readonly login: string;
  /** Numeric GitHub user id as a decimal string (preferred for noreply email). */
  readonly id?: string | undefined;
  /**
   * Explicit email for Co-authored-by. When omitted, derived as
   * `{id}+{login}@users.noreply.github.com` when id is present.
   */
  readonly email?: string | undefined;
  /** Optional override for the trailer display name (defaults to person.name). */
  readonly name?: string | undefined;
}

export interface JiraIdentityRef {
  readonly accountId?: string | undefined;
  readonly email?: string | undefined;
  readonly displayName?: string | undefined;
}

export interface PersonIdentity {
  /** Human display name used in Co-authored-by trailers. */
  readonly name: string;
  readonly discord?: DiscordIdentityRef | undefined;
  readonly github?: GitHubIdentityRef | undefined;
  readonly jira?: JiraIdentityRef | undefined;
}

export class IdentityMapLoadError extends Schema.TaggedErrorClass<IdentityMapLoadError>()(
  "IdentityMapLoadError",
  {
    path: Schema.String,
    message: Schema.String,
  },
) {}

const isIdentityMapLoadError = Schema.is(IdentityMapLoadError);

function expandHomePath(value: string): string {
  if (!value) return value;
  if (value === "~") return NodeOS.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return NodePath.join(NodeOS.homedir(), value.slice(2));
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asDiscordSnowflake(value: unknown): string | undefined {
  const raw = asNonEmptyString(value);
  if (raw === undefined) return undefined;
  // Discord snowflakes are decimal digit strings (typically 17–19 digits).
  // Accept any pure digit id so fixtures and short local maps still load.
  if (!/^\d{1,32}$/u.test(raw)) return undefined;
  return raw;
}

function normalizeLogin(value: unknown): string | undefined {
  const raw = asNonEmptyString(value);
  if (raw === undefined) return undefined;
  const login = raw.replace(/^@/u, "").trim();
  if (login.length === 0) return undefined;
  // GitHub login: alphanumeric / hyphen, max 39.
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u.test(login)) return undefined;
  return login;
}

function parsePerson(raw: unknown, indexLabel: string): PersonIdentity {
  if (!isRecord(raw)) {
    throw new Error(`Identity map entry ${indexLabel} must be an object.`);
  }

  const name = asNonEmptyString(raw.name);
  if (name === undefined) {
    throw new Error(`Identity map entry ${indexLabel} is missing a non-empty "name".`);
  }

  // Nested form: { discord: { id }, github: { login, id, email }, jira: {...} }
  // Flat form: { discordId, discordUsername, githubLogin, githubId, githubEmail, jiraAccountId, jiraEmail }
  const discordNested = isRecord(raw.discord) ? raw.discord : undefined;
  const githubNested = isRecord(raw.github) ? raw.github : undefined;
  const jiraNested = isRecord(raw.jira) ? raw.jira : undefined;

  const discordId =
    asDiscordSnowflake(discordNested?.id) ??
    asDiscordSnowflake(raw.discordId) ??
    asDiscordSnowflake(raw.discord_id);
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

  if (discordId === undefined && githubLogin === undefined && jiraAccountId === undefined) {
    throw new Error(
      `Identity map entry ${indexLabel} ("${name}") needs at least one of discord.id, github.login, or jira.accountId.`,
    );
  }

  return {
    name,
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
 * Parse identity map document (JSON object).
 *
 * Accepted shapes:
 * - `{ "people": [ { name, discord, github, jira }, ... ] }`
 * - `{ "people": { "<discordId>": { name, githubLogin, ... }, ... } }`
 * - `{ "<discordId>": { name, githubLogin, ... }, ... }` (top-level map, no people key)
 */
export function parseIdentityMapDocument(document: unknown): ReadonlyArray<PersonIdentity> {
  if (document === null || document === undefined) return [];
  if (!isRecord(document)) {
    throw new Error("Identity map root must be an object.");
  }

  const peopleNode = document.people;
  if (Array.isArray(peopleNode)) {
    return peopleNode.map((entry, index) => parsePerson(entry, `[${index}]`));
  }

  if (isRecord(peopleNode)) {
    return Object.entries(peopleNode).map(([key, value]) => {
      if (!isRecord(value)) {
        throw new Error(`Identity map people["${key}"] must be an object.`);
      }
      // If the key is a snowflake and the object omitted discordId, inject it.
      const withDiscord =
        asDiscordSnowflake(key) !== undefined && asDiscordSnowflake(value.discordId) === undefined
          ? { ...value, discordId: key }
          : value;
      return parsePerson(withDiscord, `people["${key}"]`);
    });
  }

  // Top-level map keyed by discord id (when no people key).
  const reserved = new Set(["version", "schema", "$schema"]);
  const entries = Object.entries(document).filter(([key]) => !reserved.has(key));
  if (entries.length === 0) return [];

  return entries.map(([key, value]) => {
    if (!isRecord(value)) {
      throw new Error(`Identity map["${key}"] must be an object.`);
    }
    const withDiscord =
      asDiscordSnowflake(key) !== undefined && asDiscordSnowflake(value.discordId) === undefined
        ? { ...value, discordId: key }
        : value;
    return parsePerson(withDiscord, `["${key}"]`);
  });
}

/**
 * Minimal YAML → JSON-ish object for the identity map shapes we document.
 * Prefer JSON for complex nesting; this covers the flat keyed form used in ops.
 *
 * Supports:
 * ```yaml
 * people:
 *   "123":
 *     name: Alice
 *     githubLogin: alice
 *     githubId: "99"
 * ```
 * and top-level keyed people without a `people:` wrapper.
 */
export function parseSimpleIdentityYaml(raw: string): unknown {
  const lines = raw.split(/\r?\n/);
  const root: Record<string, Record<string, string>> = {};
  let inPeople = false;
  let currentKey: string | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;

    if (/^people:\s*$/u.test(trimmed)) {
      inPeople = true;
      continue;
    }

    // Nested field under a person key (2+ spaces).
    const fieldMatch = /^(\s{2,})([A-Za-z][A-Za-z0-9_]*)\s*:\s*(.*)$/u.exec(line);
    if (fieldMatch && currentKey !== null) {
      const field = fieldMatch[2]!;
      const value = stripYamlScalar(fieldMatch[3] ?? "");
      root[currentKey] = { ...root[currentKey], [field]: value };
      continue;
    }

    // Person key at indent 0 or under people: (2 spaces): `"id":` or `id:`
    const keyMatch = /^(\s{0,2})(?:"(\d+)"|'(\d+)'|(\d+)|([A-Za-z0-9_-]+))\s*:\s*$/u.exec(line);
    if (keyMatch) {
      const indent = keyMatch[1] ?? "";
      if (inPeople && indent.length === 0) {
        // top-level key after people block ended — treat as new top-level person
      }
      const key = keyMatch[2] ?? keyMatch[3] ?? keyMatch[4] ?? keyMatch[5] ?? null;
      if (key === null || key === "people") continue;
      currentKey = key;
      root[currentKey] = { ...root[currentKey] };
      continue;
    }

    // Inline single-line `key: value` at root (unusual for this schema)
    const inlineMatch = /^([A-Za-z0-9_-]+|"\d+"|'\d+'|\d+)\s*:\s+(.+)$/u.exec(trimmed);
    if (inlineMatch && currentKey === null) {
      continue;
    }
  }

  if (Object.keys(root).length === 0) {
    return { people: [] };
  }
  return { people: root };
}

function stripYamlScalar(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  // Strip inline comments for simple scalars.
  const hash = trimmed.search(/\s+#/u);
  return hash >= 0 ? trimmed.slice(0, hash).trim() : trimmed;
}

export function loadIdentityMapFromFileSync(filePath: string): ReadonlyArray<PersonIdentity> {
  const resolvedPath = NodePath.resolve(expandHomePath(filePath.trim()));
  if (!NodeFS.existsSync(resolvedPath)) {
    throw new IdentityMapLoadError({
      path: resolvedPath,
      message: `Identity map file not found: ${resolvedPath}`,
    });
  }

  const raw = NodeFS.readFileSync(resolvedPath, "utf8");
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];

  let document: unknown;
  try {
    if (resolvedPath.endsWith(".json")) {
      document = JSON.parse(trimmed) as unknown;
    } else {
      // YAML: try JSON-compatible first (JSON is valid YAML subset for our shapes).
      try {
        document = JSON.parse(trimmed) as unknown;
      } catch {
        document = parseSimpleIdentityYaml(trimmed);
      }
    }
  } catch (cause) {
    throw new IdentityMapLoadError({
      path: resolvedPath,
      message: cause instanceof Error ? cause.message : String(cause),
    });
  }

  try {
    return parseIdentityMapDocument(document);
  } catch (cause) {
    throw new IdentityMapLoadError({
      path: resolvedPath,
      message: cause instanceof Error ? cause.message : String(cause),
    });
  }
}

/** Derive the email used in Co-authored-by trailers. */
export function resolveGitHubCoAuthorEmail(github: GitHubIdentityRef): string | null {
  const explicit = github.email?.trim();
  if (explicit !== undefined && explicit.length > 0) return explicit;
  const id = github.id?.trim();
  const login = github.login.trim();
  if (id !== undefined && id.length > 0 && login.length > 0) {
    return `${id}+${login}@users.noreply.github.com`;
  }
  return null;
}

/**
 * Co-author body only: `Name <email>` (no trailer prefix).
 * Prefix with `Co-authored-by: ` when writing git commits (see agent-turn-rules).
 */
export function formatCoAuthoredByBody(person: PersonIdentity): string | null {
  const github = person.github;
  if (github === undefined) return null;
  const email = resolveGitHubCoAuthorEmail(github);
  if (email === null) return null;
  const name = (github.name ?? person.name).trim() || person.name;
  // Git trailers must be a single line; strip newlines from names.
  const safeName = name.replace(/[\r\n]+/gu, " ").trim();
  return `${safeName} <${email}>`;
}

/** Full git trailer `Co-authored-by: Name <email>`, or null when unresolved. */
export function formatCoAuthoredByTrailer(person: PersonIdentity): string | null {
  const body = formatCoAuthoredByBody(person);
  return body === null ? null : `Co-authored-by: ${body}`;
}

export type ResolvedParticipantIdentity = {
  readonly role: "requester" | "thread_starter" | "other";
  readonly discordId: string | null;
  readonly discordUsername: string | null;
  readonly discordDisplayName: string | null;
  readonly person: PersonIdentity | null;
  readonly coAuthoredBy: string | null;
  readonly unmappedReason: string | null;
};

export function resolveParticipantIdentity(input: {
  readonly role: ResolvedParticipantIdentity["role"];
  readonly discordId?: string | null | undefined;
  readonly discordUsername?: string | null | undefined;
  readonly discordDisplayName?: string | null | undefined;
  readonly people: ReadonlyArray<PersonIdentity>;
}): ResolvedParticipantIdentity {
  const discordId = input.discordId?.trim() || null;
  const discordUsername = input.discordUsername?.trim() || null;
  const discordDisplayName = input.discordDisplayName?.trim() || null;

  let person: PersonIdentity | null = null;
  if (discordId !== null) {
    person = input.people.find((p) => p.discord?.id === discordId) ?? null;
  }
  if (person === null && discordUsername !== null) {
    const lowered = discordUsername.toLowerCase();
    person = input.people.find((p) => p.discord?.username?.toLowerCase() === lowered) ?? null;
  }

  if (person === null) {
    return {
      role: input.role,
      discordId,
      discordUsername,
      discordDisplayName,
      person: null,
      coAuthoredBy: null,
      unmappedReason:
        discordId === null && discordUsername === null
          ? "no discord identity on message"
          : "not present in identity map",
    };
  }

  const coAuthoredBy = formatCoAuthoredByTrailer(person);
  return {
    role: input.role,
    discordId,
    discordUsername,
    discordDisplayName,
    person,
    coAuthoredBy,
    unmappedReason:
      coAuthoredBy === null
        ? person.github === undefined
          ? "mapped person has no github.login"
          : "mapped person has no github email/id for Co-authored-by"
        : null,
  };
}

/**
 * Build the agent-facing attribution block for commits/PRs.
 * Bot already resolved the identity map — inject cab bodies only (no lookup, no
 * repeated `Co-authored-by:` prefix). Unmapped participants listed briefly.
 * Returns null when there is nothing useful to inject.
 */
export function formatIdentityAttributionBlock(input: {
  readonly participants: ReadonlyArray<ResolvedParticipantIdentity>;
}): string | null {
  const participants = input.participants;
  if (participants.length === 0) return null;

  const anyMapped = participants.some((p) => p.person !== null);
  // Dedupe by trailer body; starter+req same person → one entry.
  const cabBodies = uniqueStrings(
    participants
      .map((p) => {
        if (p.coAuthoredBy === null) return null;
        return p.coAuthoredBy.replace(/^Co-authored-by:\s*/iu, "").trim();
      })
      .filter((t): t is string => t !== null && t.length > 0),
  );

  // Only surface unmapped / incomplete rows (mapped people are fully covered by cab).
  const unmappedParts: string[] = [];
  const seenUnmapped = new Set<string>();
  for (const p of participants) {
    if (p.coAuthoredBy !== null) continue;
    const role = p.role === "requester" ? "req" : p.role === "thread_starter" ? "starter" : "p";
    const id = p.discordId ?? "?";
    const user = p.discordUsername ?? p.person?.discord?.username ?? "?";
    const key = `${id}@${user}`;
    if (seenUnmapped.has(key)) continue;
    seenUnmapped.add(key);
    const why = p.person === null ? "unmapped" : "no-gh";
    unmappedParts.push(`${role} ${key} ${why}`);
  }

  const lines: string[] = [];
  if (cabBodies.length > 0) {
    // Single line; agent prefixes each with `Co-authored-by: ` when committing.
    lines.push(`cab: ${cabBodies.join(" | ")}`);
  } else if (!anyMapped) {
    lines.push("cab: (none)");
  } else {
    lines.push("cab: (none — missing gh id/email)");
  }
  if (unmappedParts.length > 0) {
    lines.push(`unmapped: ${unmappedParts.join(" | ")}`);
  }

  return lines.join("\n");
}

function uniqueStrings(values: ReadonlyArray<string>): ReadonlyArray<string> {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

export interface IdentityMapStoreService {
  readonly list: () => ReadonlyArray<PersonIdentity>;
  readonly resolveByDiscordId: (discordId: string) => PersonIdentity | null;
  readonly resolveByDiscordUsername: (username: string) => PersonIdentity | null;
  readonly resolveParticipant: (input: {
    readonly role: ResolvedParticipantIdentity["role"];
    readonly discordId?: string | null | undefined;
    readonly discordUsername?: string | null | undefined;
    readonly discordDisplayName?: string | null | undefined;
  }) => ResolvedParticipantIdentity;
}

export class IdentityMapStore extends Context.Service<IdentityMapStore, IdentityMapStoreService>()(
  "@t3tools/discord-bot/identityMap/IdentityMapStore",
) {}

/** How long a loaded identity map stays hot before re-reading the file (no bot restart). */
export const IDENTITY_MAP_CACHE_TTL_MS = 60_000;

function indexesFromPeople(people: ReadonlyArray<PersonIdentity>): {
  readonly people: ReadonlyArray<PersonIdentity>;
  readonly byId: ReadonlyMap<string, PersonIdentity>;
  readonly byUsername: ReadonlyMap<string, PersonIdentity>;
} {
  const byId = new Map<string, PersonIdentity>();
  const byUsername = new Map<string, PersonIdentity>();
  for (const person of people) {
    if (person.discord?.id !== undefined) {
      byId.set(person.discord.id, person);
    }
    if (person.discord?.username !== undefined) {
      byUsername.set(person.discord.username.toLowerCase(), person);
    }
  }
  return { people, byId, byUsername };
}

export const makeIdentityMapStore = (
  people: ReadonlyArray<PersonIdentity>,
): IdentityMapStoreService => {
  const index = indexesFromPeople(people);

  return IdentityMapStore.of({
    list: () => index.people,
    resolveByDiscordId: (discordId) => index.byId.get(discordId.trim()) ?? null,
    resolveByDiscordUsername: (username) =>
      index.byUsername.get(username.trim().toLowerCase()) ?? null,
    resolveParticipant: (input) =>
      resolveParticipantIdentity({
        role: input.role,
        discordId: input.discordId,
        discordUsername: input.discordUsername,
        discordDisplayName: input.discordDisplayName,
        people: index.people,
      }),
  });
};

/**
 * File-backed identity map with a short TTL cache so operators can edit
 * identity-map.yaml without restarting the Discord bot.
 *
 * - Eager-loads once at construction (throws on first failure).
 * - Re-reads the file at most every `ttlMs` (default 60s) on access.
 * - On later load failures, keeps the last good snapshot and waits another TTL.
 */
export function makeRefreshingIdentityMapStore(input: {
  readonly filePath: string;
  readonly ttlMs?: number;
  readonly now?: () => number;
  readonly load?: (path: string) => ReadonlyArray<PersonIdentity>;
  /** Optional hook when a reload succeeds (for tests / diagnostics). */
  readonly onReload?: (people: ReadonlyArray<PersonIdentity>) => void;
}): IdentityMapStoreService {
  const ttlMs = input.ttlMs ?? IDENTITY_MAP_CACHE_TTL_MS;
  // @effect-diagnostics-next-line globalDate:off
  const now = input.now ?? (() => Date.now());
  const load = input.load ?? loadIdentityMapFromFileSync;
  const path = input.filePath.trim();

  let index = indexesFromPeople(load(path));
  let loadedAt = now();
  input.onReload?.(index.people);

  const refreshIfStale = () => {
    const t = now();
    if (t - loadedAt < ttlMs) return;
    try {
      const nextPeople = load(path);
      index = indexesFromPeople(nextPeople);
      loadedAt = t;
      input.onReload?.(index.people);
    } catch {
      // Keep serving the last good map; delay the next retry by a full TTL.
      loadedAt = t;
    }
  };

  return IdentityMapStore.of({
    list: () => {
      refreshIfStale();
      return index.people;
    },
    resolveByDiscordId: (discordId) => {
      refreshIfStale();
      return index.byId.get(discordId.trim()) ?? null;
    },
    resolveByDiscordUsername: (username) => {
      refreshIfStale();
      return index.byUsername.get(username.trim().toLowerCase()) ?? null;
    },
    resolveParticipant: (participant) => {
      refreshIfStale();
      return resolveParticipantIdentity({
        role: participant.role,
        discordId: participant.discordId,
        discordUsername: participant.discordUsername,
        discordDisplayName: participant.discordDisplayName,
        people: index.people,
      });
    },
  });
}

export const layerFromOptionalPath = (filePath: string | undefined) =>
  Layer.effect(
    IdentityMapStore,
    Effect.gen(function* () {
      if (filePath === undefined || filePath.trim().length === 0) {
        yield* Effect.logInfo(
          "T3_IDENTITY_MAP_PATH is unset; Discord→GitHub co-author injection is off until configured.",
        );
        return makeIdentityMapStore([]);
      }
      const resolvedPath = filePath.trim();
      const store = yield* Effect.try({
        try: () => makeRefreshingIdentityMapStore({ filePath: resolvedPath }),
        catch: (cause) => {
          if (isIdentityMapLoadError(cause)) return cause;
          return new IdentityMapLoadError({
            path: resolvedPath,
            message: cause instanceof Error ? cause.message : String(cause),
          });
        },
      });
      const count = store.list().length;
      yield* Effect.logInfo(
        `Loaded ${count} identity map entr${count === 1 ? "y" : "ies"} from ${resolvedPath} (reload TTL ${IDENTITY_MAP_CACHE_TTL_MS / 1000}s)`,
      );
      return store;
    }),
  );
