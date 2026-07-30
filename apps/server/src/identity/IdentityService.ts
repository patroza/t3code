// @effect-diagnostics preferSchemaOverJson:off
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalConsole:off
/**
 * Closed-set identity map + per-session claims.
 *
 * Map: T3_IDENTITY_MAP_PATH only (explicit). Missing/empty → feature off.
 * Claims: process-local Ref (re-claim after restart). Persistence later.
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
import * as Ref from "effect/Ref";
import {
  AuthSessionId,
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
  toIdentityPersonPublic,
  type IdentityMapPerson,
  IdentityMapParseError,
} from "@t3tools/shared/identityMap";
import { parse as parseYamlString } from "yaml";

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
    readonly requireOperateClaim: (
      sessionId: AuthSessionId,
    ) => Effect.Effect<SessionIdentityClaim | null, IdentityError>;
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

function makeService(
  people: ReadonlyArray<IdentityMapPerson>,
  claimsRef: Ref.Ref<Map<string, ClaimRecord>>,
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

    getSessionClaim: (sessionId) =>
      Ref.get(claimsRef).pipe(
        Effect.map((claims) => {
          const record = claims.get(sessionId);
          return { claim: record === undefined ? null : toPublicClaim(record) };
        }),
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
        yield* Ref.update(claimsRef, (claims) => {
          const next = new Map(claims);
          next.set(sessionId, record);
          return next;
        });
        return { claim: toPublicClaim(record) };
      }),

    clearClaim: (sessionId) =>
      Effect.gen(function* () {
        const claims = yield* Ref.get(claimsRef);
        if (!claims.has(sessionId)) {
          return { cleared: false };
        }
        yield* Ref.update(claimsRef, (map) => {
          const next = new Map(map);
          next.delete(sessionId);
          return next;
        });
        return { cleared: true };
      }),

    requireOperateClaim: (sessionId) =>
      Effect.gen(function* () {
        if (!enabled) return null;
        const claims = yield* Ref.get(claimsRef);
        const existing = claims.get(sessionId);
        if (existing === undefined) {
          return yield* new IdentityError({
            code: "identity_claim_required",
            message:
              "Choose who you are (identity claim) before operating on this environment. Map membership only — trusted-team ops.",
          });
        }
        if (!byPersonId.has(existing.personId) || !byUsername.has(existing.username)) {
          yield* Ref.update(claimsRef, (map) => {
            const next = new Map(map);
            next.delete(sessionId);
            return next;
          });
          return yield* new IdentityError({
            code: "identity_unknown_person",
            message: "Your identity claim is no longer in the server map. Claim again.",
          });
        }
        return toPublicClaim(existing);
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
  return makeService(people, claimsRef);
});

export const layer = Layer.effect(IdentityService, make);

/** Test helper: fixed people list. */
export const layerWithPeople = (people: ReadonlyArray<IdentityMapPerson>) =>
  Layer.effect(
    IdentityService,
    Effect.gen(function* () {
      const claimsRef = yield* Ref.make(new Map<string, ClaimRecord>());
      return makeService(people, claimsRef);
    }),
  );
