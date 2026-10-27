// @effect-diagnostics preferSchemaOverJson:off
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalConsole:off
// T3_IDENTITY_MAP_PATH enables map membership claims; bad reloads retain the last good map.
// Server claims persist in SQLite; CLI/test claims stay in memory.
// Interactive claims establish membership only, assuming trusted-team operation.
import * as NodeFS from "node:fs";
import * as Clock from "effect/Clock";
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
    // Enabled maps require interactive sessions to claim a member before operating.
    // Bot sessions bypass session claims: their per-turn SourceRef identifies each human sender.
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

/** Read the on-disk map without constructing the service (projection backfill). */
export function readIdentityMapPeopleFromEnv(): ReadonlyArray<IdentityMapPerson> {
  return loadPeopleFromEnv();
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

/** How long a loaded map is served before the file is re-checked. */
export const IDENTITY_MAP_RELOAD_TTL_MS = 60_000;

type MapSnapshot = {
  readonly people: ReadonlyArray<IdentityMapPerson>;
  readonly byUsername: ReadonlyMap<string, IdentityMapPerson>;
  readonly byPersonId: ReadonlyMap<string, IdentityMapPerson>;
  readonly enabled: boolean;
  /**
   * False while we are serving a stale snapshot because the last re-read failed
   * (missing, truncated, or unparseable file). Callers must not take destructive
   * action — notably evicting persisted claims — off an unhealthy snapshot.
   */
  readonly healthy: boolean;
};

type IdentityMapSource = { readonly current: Effect.Effect<MapSnapshot> };

function toSnapshot(people: ReadonlyArray<IdentityMapPerson>, healthy: boolean): MapSnapshot {
  return {
    people,
    byUsername: new Map(people.map((person) => [person.username, person] as const)),
    byPersonId: new Map(people.map((person) => [person.personId, person] as const)),
    enabled: people.length > 0,
    healthy,
  };
}

/** Cheap change detector: avoids re-parsing an untouched file every TTL. */
function fingerprintFromEnv(): string | null {
  const configured = process.env.T3_IDENTITY_MAP_PATH?.trim();
  if (configured === undefined || configured.length === 0) return null;
  try {
    const stat = NodeFS.statSync(configured);
    return `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return null;
  }
}

// Poll the map on a TTL because virtiofs inotify propagation is unreliable.
// Failed or empty reloads retain the enabled map and last good snapshot, marked unhealthy.
// Only removing T3_IDENTITY_MAP_PATH at startup disables the gate.
function makeFileSource(options?: { readonly ttlMs?: number }): IdentityMapSource {
  const ttlMs = options?.ttlMs ?? IDENTITY_MAP_RELOAD_TTL_MS;

  let snapshot = toSnapshot(loadPeopleFromEnv(), true);
  let fingerprint = fingerprintFromEnv();
  let checkedAt: number | null = null;
  let degraded = false;

  const current = Effect.gen(function* () {
    const at = yield* Clock.currentTimeMillis;
    if (checkedAt === null) {
      checkedAt = at;
      return snapshot;
    }
    if (at - checkedAt < ttlMs) return snapshot;
    checkedAt = at;

    const nextFingerprint = fingerprintFromEnv();
    if (nextFingerprint !== null && nextFingerprint === fingerprint) return snapshot;

    const people = loadPeopleFromEnv();
    if (people.length === 0 && snapshot.enabled) {
      if (!degraded) {
        yield* Effect.logError(
          "Identity map re-read produced no people; keeping the previous map and retrying",
        );
        degraded = true;
      }
      snapshot = { ...snapshot, healthy: false };
      return snapshot;
    }

    const changed = people.length !== snapshot.people.length || !snapshot.healthy;
    fingerprint = nextFingerprint;
    degraded = false;
    snapshot = toSnapshot(people, true);
    if (changed) {
      yield* Effect.logInfo("Identity map reloaded", { people: people.length });
    }
    return snapshot;
  });

  return { current };
}

function staticSource(people: ReadonlyArray<IdentityMapPerson>): IdentityMapSource {
  return { current: Effect.succeed(toSnapshot(people, true)) };
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

function makeService(source: IdentityMapSource, store: ClaimStore): IdentityService["Service"] {
  const toPublicClaim = (record: ClaimRecord): SessionIdentityClaim => ({
    sessionId: record.sessionId,
    personId: record.personId,
    username: record.username,
    claimedAt: record.claimedAt,
    method: record.method,
  });

  return {
    getSnapshot: () =>
      source.current.pipe(
        Effect.map((snapshot) => ({
          enabled: snapshot.enabled,
          claimRequired: snapshot.enabled,
          people: toPublicPeople(snapshot.people),
        })),
      ),

    listMapPeople: () => source.current.pipe(Effect.map((snapshot) => snapshot.people)),

    getSessionClaim: (sessionId) =>
      store.get(sessionId).pipe(
        Effect.map((record) => ({
          claim: record === null ? null : toPublicClaim(record),
        })),
      ),

    claim: Effect.fn("IdentityService.claim")(function* (sessionId, input) {
      const snapshot = yield* source.current;
      if (!snapshot.enabled) {
        return yield* new IdentityError({
          code: "identity_map_disabled",
          message: "Identity map is not configured; claims are disabled.",
        });
      }

      const person =
        "personId" in input
          ? (snapshot.byPersonId.get(input.personId) ?? null)
          : (snapshot.byUsername.get(input.username) ?? null);
      if (person === null) {
        return yield* new IdentityError({
          code: "identity_unknown_person",
          message: "That identity is not in the server identity map.",
        });
      }

      const method: SessionIdentityClaimMethod =
        ("method" in input && input.method !== undefined ? input.method : undefined) ?? "typeahead";
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

    requireOperateClaim: Effect.fn("IdentityService.requireOperateClaim")(
      function* (sessionId, options) {
        const snapshot = yield* source.current;
        if (!snapshot.enabled) return null;
        // Integration bots: one auth session, many platform actors — not interactive claim.
        if (options?.clientDeviceType === "bot") {
          return null;
        }
        const existing = yield* store.get(sessionId);
        if (existing === null) {
          return yield* new IdentityError({
            code: "identity_claim_required",
            message:
              "Choose who you are (identity claim) before operating on this environment. Map membership only. Trusted-team operations.",
          });
        }
        if (
          !snapshot.byPersonId.has(existing.personId) ||
          !snapshot.byUsername.has(existing.username)
        ) {
          // Retain persisted claims across partial map writes; every operation rechecks membership,
          // so an absent member is refused without irreversibly deleting a valid claim.
          return yield* new IdentityError({
            code: "identity_unknown_person",
            message: "Your identity claim is no longer in the server map. Claim again.",
          });
        }
        return toPublicClaim(existing);
      },
    ),

    resolveByJiraAccountId: (accountId) =>
      source.current.pipe(
        Effect.map((snapshot) =>
          snapshot.enabled ? resolvePersonByJiraAccountId(snapshot.people, accountId) : null,
        ),
      ),

    isMapEnabled: () => source.current.pipe(Effect.map((snapshot) => snapshot.enabled)),
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
  const source = makeFileSource();
  const people = (yield* source.current).people;
  if (people.length > 0) {
    yield* Effect.logInfo("Identity map loaded", {
      path: process.env.T3_IDENTITY_MAP_PATH ?? "",
      people: people.length,
      reloadTtlMs: IDENTITY_MAP_RELOAD_TTL_MS,
    });
  }
  return makeService(source, makeMemoryStore(claimsRef));
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
    const source = makeFileSource();
    const people = (yield* source.current).people;
    if (people.length > 0) {
      yield* Effect.logInfo("Identity map loaded", {
        path: process.env.T3_IDENTITY_MAP_PATH ?? "",
        people: people.length,
        reloadTtlMs: IDENTITY_MAP_RELOAD_TTL_MS,
      });
    }

    const store: ClaimStore = {
      get: Effect.fn("IdentityService.store.get")(function* (sessionId) {
        const cached = yield* memory.get(sessionId);
        if (cached !== null) return cached;
        const row = yield* repository
          .getBySessionId(sessionId)
          .pipe(Effect.orElseSucceed(() => Option.none()));
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
      put: Effect.fn("IdentityService.store.put")(function* (record) {
        yield* memory.put(record);
        yield* repository.upsert(record).pipe(Effect.ignore);
      }),
      remove: Effect.fn("IdentityService.store.remove")(function* (sessionId) {
        const cleared = yield* memory.remove(sessionId);
        yield* repository.deleteBySessionId(sessionId).pipe(Effect.ignore);
        return cleared;
      }),
    };

    return makeService(source, store);
  }),
).pipe(Layer.provide(sessionIdentityClaimRepositoryLayer));

/** Test helper: fixed people list. */
export const layerWithPeople = (people: ReadonlyArray<IdentityMapPerson>) =>
  Layer.effect(
    IdentityService,
    Effect.gen(function* () {
      const claimsRef = yield* Ref.make(new Map<string, ClaimRecord>());
      return makeService(staticSource(people), makeMemoryStore(claimsRef));
    }),
  );

/** Test seam: file-backed source with an injectable clock and TTL. */
export const makeFileSourceForTest = makeFileSource;
