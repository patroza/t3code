// @effect-diagnostics preferSchemaOverJson:off
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalConsole:off
/**
 * Closed-set identity map + per-session claims.
 *
 * Map: T3_IDENTITY_MAP_PATH only (explicit). Missing/empty → feature off.
 * Claims: `layerPersisted` (server) stores them in SQLite via
 * SessionIdentityClaimRepository with the Ref as a read-through cache, so they
 * survive a restart. The residual-free `layer` (CLI / tests) is Ref-only.
 *
 * Layer residual is empty so it can sit on the server graph without polluting
 * CLI typecheck (SqlClient / ServerConfig leakage).
 *
 * v1 trust: interactive claim is map membership only (trusted-team ops).
 */
import * as NodeFS from "node:fs";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import {
  AuthSessionId,
  type AuthClientMetadataDeviceType,
  IdentityClaimInput,
  IdentityError,
  IdentitySessionClaimResult,
  IdentitySnapshot,
  IdentityUsername,
  PersonId,
  SessionIdentityClaim,
  type SessionIdentityClaimMethod,
} from "@t3tools/contracts";
import {
  parseIdentityMapDocument,
  resolvePersonByJiraAccountId,
  toIdentityPersonPublic,
  type IdentityMapPerson,
  IdentityMapParseError,
} from "@t3tools/shared/identityMap";
import { parse as parseYamlString } from "yaml";

import {
  SessionIdentityClaimRepository,
  layer as sessionIdentityClaimRepositoryLayer,
} from "../persistence/SessionIdentityClaims.ts";

type ClaimRecord = {
  readonly sessionId: AuthSessionId;
  readonly personId: PersonId;
  readonly username: IdentityUsername;
  readonly claimedAt: string;
  readonly method: SessionIdentityClaimMethod;
};

export class IdentityService extends Context.Service<
  IdentityService,
  {
    readonly getSnapshot: () => Effect.Effect<IdentitySnapshot>;
    /** In-process map people for platform SourceRef resolution (GitHub/Jira/Discord). */
    readonly listMapPeople: () => Effect.Effect<ReadonlyArray<IdentityMapPerson>>;
    readonly getSessionClaim: (
      sessionId: AuthSessionId,
    ) => Effect.Effect<IdentitySessionClaimResult, IdentityError>;
    readonly claim: (
      sessionId: AuthSessionId,
      input: IdentityClaimInput,
    ) => Effect.Effect<{ claim: SessionIdentityClaim }, IdentityError>;
    readonly clearClaim: (
      sessionId: AuthSessionId,
    ) => Effect.Effect<{ cleared: boolean }, IdentityError>;
    /**
     * When the identity map is enabled, interactive sessions must have claimed
     * a person before orchestration operate. Returns the claim, or null when
     * the map is off / the session is an integration bot.
     *
     * Bot sessions (`clientDeviceType: "bot"`) skip the claim gate: Discord/Jira
     * share one long-lived auth session across many human senders, so a single
     * session claim cannot impersonate each actor. Per-turn SourceRef stamping
     * from the platform map is a separate path (not session claim).
     */
    readonly requireOperateClaim: (
      sessionId: AuthSessionId,
      options?: {
        readonly clientDeviceType?: AuthClientMetadataDeviceType;
      },
    ) => Effect.Effect<SessionIdentityClaim | null, IdentityError>;
    /**
     * Resolve a closed-set person from a Jira actor accountId.
     * Returns null when the map is off, accountId is missing, or unmapped.
     */
    readonly resolveByJiraAccountId: (
      accountId: string | null | undefined,
    ) => Effect.Effect<IdentityMapPerson | null>;
    /** True when T3_IDENTITY_MAP_PATH loaded at least one person. */
    readonly isMapEnabled: () => Effect.Effect<boolean>;
  }
>()("t3/identity/IdentityService") {}

function parseMapDocument(path: string, raw: string): ReadonlyArray<IdentityMapPerson> {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];
  let document: unknown;
  if (path.endsWith(".json")) {
    document = JSON.parse(trimmed) as unknown;
  } else {
    try {
      document = JSON.parse(trimmed) as unknown;
    } catch {
      document = parseYamlString(trimmed) as unknown;
    }
  }
  return parseIdentityMapDocument(document);
}

function loadPeopleFromEnv(): ReadonlyArray<IdentityMapPerson> {
  const configured = process.env.T3_IDENTITY_MAP_PATH?.trim();
  if (configured === undefined || configured.length === 0) {
    return [];
  }
  try {
    if (!NodeFS.existsSync(configured)) {
      console.error(`[identity] T3_IDENTITY_MAP_PATH not found: ${configured}`);
      return [];
    }
    const raw = NodeFS.readFileSync(configured, "utf8");
    if (raw.trim().length === 0) {
      console.error(`[identity] T3_IDENTITY_MAP_PATH is empty: ${configured}`);
      return [];
    }
    const people = parseMapDocument(configured, raw);
    if (people.length === 0) {
      console.error(`[identity] T3_IDENTITY_MAP_PATH has no people: ${configured}`);
    }
    return people;
  } catch (cause) {
    const message =
      cause instanceof IdentityMapParseError
        ? cause.message
        : cause instanceof Error
          ? cause.message
          : String(cause);
    console.error(`[identity] failed to load map at ${configured}: ${message}`);
    return [];
  }
}

function toPublicPeople(people: ReadonlyArray<IdentityMapPerson>) {
  return people.map((person) => {
    const pub = toIdentityPersonPublic(person);
    return {
      personId: PersonId.make(pub.personId),
      username: IdentityUsername.make(pub.username),
      ...(pub.name !== undefined ? { name: pub.name } : {}),
      links: pub.links,
    };
  });
}

type ClaimStore = {
  readonly get: (sessionId: AuthSessionId) => Effect.Effect<ClaimRecord | null>;
  readonly put: (record: ClaimRecord) => Effect.Effect<void>;
  readonly remove: (sessionId: AuthSessionId) => Effect.Effect<boolean>;
};

function makeService(
  people: ReadonlyArray<IdentityMapPerson>,
  store: ClaimStore,
): IdentityService["Service"] {
  const byUsername = new Map(people.map((person) => [person.username, person] as const));
  const byPersonId = new Map(people.map((person) => [person.personId, person] as const));
  const enabled = people.length > 0;

  const toPublicClaim = (record: ClaimRecord): SessionIdentityClaim => ({
    sessionId: record.sessionId,
    personId: record.personId,
    username: record.username,
    claimedAt: record.claimedAt,
    method: record.method,
  });

  return {
    getSnapshot: () =>
      Effect.succeed({
        enabled,
        claimRequired: enabled,
        people: toPublicPeople(people),
      }),

    listMapPeople: () => Effect.succeed(people),

    getSessionClaim: (sessionId) =>
      store.get(sessionId).pipe(
        Effect.map((record) => ({
          claim: record === null ? null : toPublicClaim(record),
        })),
      ),

    claim: (sessionId, input) =>
      Effect.gen(function* () {
        if (!enabled) {
          return yield* new IdentityError({
            code: "identity_map_disabled",
            message: "Identity map is not configured; claims are disabled.",
          });
        }

        const person =
          "personId" in input
            ? (byPersonId.get(input.personId) ?? null)
            : (byUsername.get(input.username) ?? null);
        if (person === null) {
          return yield* new IdentityError({
            code: "identity_unknown_person",
            message: "That identity is not in the server identity map.",
          });
        }

        const method: SessionIdentityClaimMethod =
          ("method" in input && input.method !== undefined ? input.method : undefined) ??
          "typeahead";
        const claimedAt = yield* DateTime.now.pipe(Effect.map((dt) => DateTime.formatIso(dt)));
        const record: ClaimRecord = {
          sessionId,
          personId: PersonId.make(person.personId),
          username: IdentityUsername.make(person.username),
          claimedAt,
          method,
        };
        yield* store.put(record);
        return { claim: toPublicClaim(record) };
      }),

    clearClaim: (sessionId) => store.remove(sessionId).pipe(Effect.map((cleared) => ({ cleared }))),

    requireOperateClaim: (sessionId, options) =>
      Effect.gen(function* () {
        if (!enabled) return null;
        // Integration bots: one auth session, many platform actors — not interactive claim.
        if (options?.clientDeviceType === "bot") {
          return null;
        }
        const existing = yield* store.get(sessionId);
        if (existing === null) {
          return yield* new IdentityError({
            code: "identity_claim_required",
            message:
              "Choose who you are (identity claim) before operating on this environment. Map membership only — trusted-team ops.",
          });
        }
        if (!byPersonId.has(existing.personId) || !byUsername.has(existing.username)) {
          yield* store.remove(sessionId);
          return yield* new IdentityError({
            code: "identity_unknown_person",
            message: "Your identity claim is no longer in the server map. Claim again.",
          });
        }
        return toPublicClaim(existing);
      }),

    resolveByJiraAccountId: (accountId) =>
      Effect.succeed(enabled ? resolvePersonByJiraAccountId(people, accountId) : null),

    isMapEnabled: () => Effect.succeed(enabled),
  };
}

function makeMemoryStore(claimsRef: Ref.Ref<Map<string, ClaimRecord>>): ClaimStore {
  return {
    get: (sessionId) =>
      Ref.get(claimsRef).pipe(Effect.map((claims) => claims.get(sessionId) ?? null)),
    put: (record) =>
      Ref.update(claimsRef, (claims) => {
        const next = new Map(claims);
        next.set(record.sessionId, record);
        return next;
      }),
    remove: (sessionId) =>
      Ref.modify(claimsRef, (claims) => {
        const had = claims.has(sessionId);
        if (!had) return [false, claims] as const;
        const next = new Map(claims);
        next.delete(sessionId);
        return [true, next] as const;
      }),
  };
}

export const make: Effect.Effect<IdentityService["Service"]> = Effect.gen(function* () {
  const claimsRef = yield* Ref.make(new Map<string, ClaimRecord>());
  const people = loadPeopleFromEnv();
  if (people.length > 0) {
    yield* Effect.logInfo("Identity map loaded", {
      path: process.env.T3_IDENTITY_MAP_PATH ?? "",
      people: people.length,
    });
  }
  return makeService(people, makeMemoryStore(claimsRef));
});

/** Residual-free in-memory layer (CLI / tests without SQL). */
export const layer = Layer.effect(IdentityService, make);

/**
 * Server layer: SQLite-backed claims with an in-memory cache.
 * Requires SessionIdentityClaimRepository (SqlClient residual).
 */
export const layerPersisted = Layer.effect(
  IdentityService,
  Effect.gen(function* () {
    const claimsRef = yield* Ref.make(new Map<string, ClaimRecord>());
    const memory = makeMemoryStore(claimsRef);
    const repository = yield* SessionIdentityClaimRepository;
    const people = loadPeopleFromEnv();
    if (people.length > 0) {
      yield* Effect.logInfo("Identity map loaded", {
        path: process.env.T3_IDENTITY_MAP_PATH ?? "",
        people: people.length,
      });
    }

    const store: ClaimStore = {
      get: (sessionId) =>
        Effect.gen(function* () {
          const cached = yield* memory.get(sessionId);
          if (cached !== null) return cached;
          const row = yield* repository
            .getBySessionId(sessionId)
            .pipe(Effect.catch(() => Effect.succeed(Option.none())));
          if (Option.isNone(row)) return null;
          const record: ClaimRecord = {
            sessionId: row.value.sessionId,
            personId: row.value.personId,
            username: row.value.username,
            claimedAt: row.value.claimedAt,
            method: row.value.method,
          };
          yield* memory.put(record);
          return record;
        }),
      put: (record) =>
        Effect.gen(function* () {
          yield* memory.put(record);
          yield* repository.upsert(record).pipe(Effect.catch(() => Effect.void));
        }),
      remove: (sessionId) =>
        Effect.gen(function* () {
          const cleared = yield* memory.remove(sessionId);
          yield* repository.deleteBySessionId(sessionId).pipe(Effect.catch(() => Effect.void));
          return cleared;
        }),
    };

    return makeService(people, store);
  }),
).pipe(Layer.provide(sessionIdentityClaimRepositoryLayer));

/** Test helper: fixed people list. */
export const layerWithPeople = (people: ReadonlyArray<IdentityMapPerson>) =>
  Layer.effect(
    IdentityService,
    Effect.gen(function* () {
      const claimsRef = yield* Ref.make(new Map<string, ClaimRecord>());
      return makeService(people, makeMemoryStore(claimsRef));
    }),
  );
