/**
 * Closed-set identity map + per-session claims.
 *
 * Map load path: T3_IDENTITY_MAP_PATH, else $stateDir/identity-map.yaml|json if present.
 * Missing/empty map → feature off (no claim gate).
 *
 * v1 trust: interactive claim only checks map membership (trusted-team ops).
 */
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Config from "effect/Config";
import * as Path from "effect/Path";
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

import * as ServerConfig from "../config.ts";
import * as SessionIdentityClaims from "../persistence/SessionIdentityClaims.ts";

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
    /**
     * When map enabled, require a session claim for orchestration:operate paths.
     * No-op when identity feature is off.
     */
    readonly requireOperateClaim: (
      sessionId: AuthSessionId,
    ) => Effect.Effect<SessionIdentityClaim | null, IdentityError>;
  }
>()("t3/identity/IdentityService") {}

const loadPeopleFromPath = Effect.fn("IdentityService.loadPeopleFromPath")(function* (
  path: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const exists = yield* fs.exists(path).pipe(Effect.orElseSucceed(() => false));
  if (!exists) {
    return [] as ReadonlyArray<IdentityMapPerson>;
  }
  const raw = yield* fs.readFileString(path).pipe(
    Effect.mapError(
      (cause) =>
        new IdentityError({
          code: "identity_map_invalid",
          message: `Failed to read identity map at ${path}: ${String(cause)}`,
        }),
    ),
  );
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];

  let document: unknown;
  try {
    if (path.endsWith(".json")) {
      document = JSON.parse(trimmed) as unknown;
    } else {
      try {
        document = JSON.parse(trimmed) as unknown;
      } catch {
        document = parseYamlString(trimmed) as unknown;
      }
    }
  } catch (cause) {
    return yield* Effect.fail(
      new IdentityError({
        code: "identity_map_invalid",
        message: `Failed to parse identity map at ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
    );
  }

  try {
    return parseIdentityMapDocument(document);
  } catch (cause) {
    const message =
      cause instanceof IdentityMapParseError
        ? cause.message
        : cause instanceof Error
          ? cause.message
          : String(cause);
    return yield* Effect.fail(
      new IdentityError({
        code: "identity_map_invalid",
        message: `Invalid identity map at ${path}: ${message}`,
      }),
    );
  }
});

const resolveMapPath = Effect.fn("IdentityService.resolveMapPath")(function* () {
  const configured = yield* Config.string("T3_IDENTITY_MAP_PATH").pipe(Config.option);
  if (Option.isSome(configured) && configured.value.trim().length > 0) {
    return configured.value.trim();
  }
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const pathApi = yield* Path.Path;
  const yamlPath = pathApi.join(stateDir, "identity-map.yaml");
  const jsonPath = pathApi.join(stateDir, "identity-map.json");
  if (yield* fs.exists(yamlPath).pipe(Effect.orElseSucceed(() => false))) return yamlPath;
  if (yield* fs.exists(jsonPath).pipe(Effect.orElseSucceed(() => false))) return jsonPath;
  return null;
});

export const make = Effect.gen(function* () {
  const claims = yield* SessionIdentityClaims.SessionIdentityClaimRepository;
  const mapPath = yield* resolveMapPath;

  let people: ReadonlyArray<IdentityMapPerson> = [];
  if (mapPath !== null) {
    const loaded = yield* loadPeopleFromPath(mapPath).pipe(
      Effect.catchTag("IdentityError", (error) =>
        Effect.logError("Identity map failed to load; identity feature disabled", {
          path: mapPath,
          code: error.code,
          message: error.message,
        }).pipe(Effect.as([] as ReadonlyArray<IdentityMapPerson>)),
      ),
    );
    people = loaded;
    if (people.length > 0) {
      yield* Effect.logInfo("Identity map loaded", {
        path: mapPath,
        people: people.length,
      });
    }
  }

  const byUsername = new Map(people.map((person) => [person.username, person] as const));
  const byPersonId = new Map(people.map((person) => [person.personId, person] as const));
  const enabled = people.length > 0;

  const getSnapshot = (): Effect.Effect<IdentitySnapshot> =>
    Effect.succeed({
      enabled,
      claimRequired: enabled,
      people: people.map(toIdentityPersonPublic),
    });

  const toPublicClaim = (
    record: SessionIdentityClaims.SessionIdentityClaimRecord,
  ): SessionIdentityClaim => ({
    sessionId: record.sessionId,
    personId: record.personId,
    username: record.username,
    claimedAt: record.claimedAt,
    method: record.method,
  });

  const getSessionClaim = (sessionId: AuthSessionId) =>
    claims.getBySessionId(sessionId).pipe(
      Effect.mapError(
        (cause) =>
          new IdentityError({
            code: "identity_map_invalid",
            message: `Failed to load session claim: ${cause.message}`,
          }),
      ),
      Effect.map((option) => ({
        claim: Option.match(option, {
          onNone: () => null,
          onSome: toPublicClaim,
        }),
      })),
    );

  const claim = (sessionId: AuthSessionId, input: IdentityClaimInput) =>
    Effect.gen(function* () {
      if (!enabled) {
        return yield* Effect.fail(
          new IdentityError({
            code: "identity_map_disabled",
            message: "Identity map is not configured; claims are disabled.",
          }),
        );
      }

      const person =
        "personId" in input
          ? (byPersonId.get(input.personId) ?? null)
          : (byUsername.get(input.username) ?? null);
      if (person === null) {
        return yield* Effect.fail(
          new IdentityError({
            code: "identity_unknown_person",
            message: "That identity is not in the server identity map.",
          }),
        );
      }

      const method: SessionIdentityClaimMethod =
        ("method" in input && input.method !== undefined ? input.method : undefined) ?? "typeahead";
      const claimedAt = yield* DateTime.now.pipe(Effect.map((dt) => DateTime.formatIso(dt)));
      const record = {
        sessionId,
        personId: PersonId.make(person.personId),
        username: IdentityUsername.make(person.username),
        claimedAt,
        method,
      };
      yield* claims.upsert(record).pipe(
        Effect.mapError(
          (cause) =>
            new IdentityError({
              code: "identity_map_invalid",
              message: `Failed to persist claim: ${cause.message}`,
            }),
        ),
      );
      return { claim: toPublicClaim(record) };
    });

  const clearClaim = (sessionId: AuthSessionId) =>
    claims.deleteBySessionId(sessionId).pipe(
      Effect.mapError(
        (cause) =>
          new IdentityError({
            code: "identity_map_invalid",
            message: `Failed to clear claim: ${cause.message}`,
          }),
      ),
      Effect.map((cleared) => ({ cleared })),
    );

  const requireOperateClaim = (sessionId: AuthSessionId) =>
    Effect.gen(function* () {
      if (!enabled) return null;
      const { claim: existing } = yield* getSessionClaim(sessionId);
      if (existing === null) {
        return yield* Effect.fail(
          new IdentityError({
            code: "identity_claim_required",
            message:
              "Choose who you are (identity claim) before operating on this environment. Map membership only — trusted-team ops.",
          }),
        );
      }
      return existing;
    });

  return {
    getSnapshot,
    getSessionClaim,
    claim,
    clearClaim,
    requireOperateClaim,
  } satisfies IdentityService["Service"];
});

export const layer = Layer.effect(IdentityService, make).pipe(
  Layer.provideMerge(SessionIdentityClaims.layer),
);

/** Test helper: fixed people, real claim repository still required. */
export const layerWithPeople = (people: ReadonlyArray<IdentityMapPerson>) =>
  Layer.effect(
    IdentityService,
    Effect.gen(function* () {
      const claims = yield* SessionIdentityClaims.SessionIdentityClaimRepository;
      const byUsername = new Map(people.map((person) => [person.username, person] as const));
      const byPersonId = new Map(people.map((person) => [person.personId, person] as const));
      const enabled = people.length > 0;

      const toPublicClaim = (
        record: SessionIdentityClaims.SessionIdentityClaimRecord,
      ): SessionIdentityClaim => ({
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
            people: people.map(toIdentityPersonPublic),
          }),
        getSessionClaim: (sessionId) =>
          claims.getBySessionId(sessionId).pipe(
            Effect.mapError(
              (cause) =>
                new IdentityError({
                  code: "identity_map_invalid",
                  message: cause.message,
                }),
            ),
            Effect.map((option) => ({
              claim: Option.match(option, {
                onNone: () => null,
                onSome: toPublicClaim,
              }),
            })),
          ),
        claim: (sessionId, input) =>
          Effect.gen(function* () {
            if (!enabled) {
              return yield* Effect.fail(
                new IdentityError({
                  code: "identity_map_disabled",
                  message: "disabled",
                }),
              );
            }
            const person =
              "personId" in input
                ? (byPersonId.get(input.personId) ?? null)
                : (byUsername.get(input.username) ?? null);
            if (person === null) {
              return yield* Effect.fail(
                new IdentityError({
                  code: "identity_unknown_person",
                  message: "unknown",
                }),
              );
            }
            const method =
              ("method" in input && input.method !== undefined ? input.method : undefined) ??
              "typeahead";
            const claimedAt = yield* DateTime.now.pipe(Effect.map((dt) => DateTime.formatIso(dt)));
            const record = {
              sessionId,
              personId: PersonId.make(person.personId),
              username: IdentityUsername.make(person.username),
              claimedAt,
              method,
            };
            yield* claims.upsert(record).pipe(
              Effect.mapError(
                (cause) =>
                  new IdentityError({
                    code: "identity_map_invalid",
                    message: cause.message,
                  }),
              ),
            );
            return { claim: toPublicClaim(record) };
          }),
        clearClaim: (sessionId) =>
          claims.deleteBySessionId(sessionId).pipe(
            Effect.mapError(
              (cause) =>
                new IdentityError({
                  code: "identity_map_invalid",
                  message: cause.message,
                }),
            ),
            Effect.map((cleared) => ({ cleared })),
          ),
        requireOperateClaim: (sessionId) =>
          Effect.gen(function* () {
            if (!enabled) return null;
            const option = yield* claims.getBySessionId(sessionId).pipe(
              Effect.mapError(
                (cause) =>
                  new IdentityError({
                    code: "identity_map_invalid",
                    message: cause.message,
                  }),
              ),
            );
            if (Option.isNone(option)) {
              return yield* Effect.fail(
                new IdentityError({
                  code: "identity_claim_required",
                  message: "claim required",
                }),
              );
            }
            return toPublicClaim(option.value);
          }),
      } satisfies IdentityService["Service"];
    }),
  ).pipe(Layer.provideMerge(SessionIdentityClaims.layer));
