import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import {
  AuthSessionId,
  IdentityUsername,
  PersonId,
  SessionIdentityClaimMethod,
} from "@t3tools/contracts";

import {
  PersistenceDecodeError,
  PersistenceSqlError,
  type PersistenceErrorCorrelation,
} from "./Errors.ts";

export const SessionIdentityClaimRecord = Schema.Struct({
  sessionId: AuthSessionId,
  personId: PersonId,
  username: IdentityUsername,
  claimedAt: Schema.String,
  method: SessionIdentityClaimMethod,
});
export type SessionIdentityClaimRecord = typeof SessionIdentityClaimRecord.Type;

type ClaimRepoError = PersistenceSqlError | PersistenceDecodeError;

export class SessionIdentityClaimRepository extends Context.Service<
  SessionIdentityClaimRepository,
  {
    readonly getBySessionId: (
      sessionId: AuthSessionId,
    ) => Effect.Effect<Option.Option<SessionIdentityClaimRecord>, ClaimRepoError>;
    readonly upsert: (record: SessionIdentityClaimRecord) => Effect.Effect<void, ClaimRepoError>;
    readonly deleteBySessionId: (
      sessionId: AuthSessionId,
    ) => Effect.Effect<boolean, ClaimRepoError>;
  }
>()("t3/persistence/SessionIdentityClaims/SessionIdentityClaimRepository") {}

const toError =
  (sqlOp: string, decodeOp: string, correlation?: PersistenceErrorCorrelation) =>
  (cause: unknown): ClaimRepoError =>
    Schema.isSchemaError(cause)
      ? PersistenceDecodeError.fromSchemaError(decodeOp, cause, correlation)
      : new PersistenceSqlError({
          operation: sqlOp,
          ...(correlation === undefined ? {} : { correlation }),
          cause,
        });

const ClaimDbRow = Schema.Struct({
  sessionId: AuthSessionId,
  personId: PersonId,
  username: IdentityUsername,
  claimedAt: Schema.String,
  method: SessionIdentityClaimMethod,
});

const decodeClaim = Schema.decodeUnknownEffect(ClaimDbRow);

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const getRow = SqlSchema.findOneOption({
    Request: Schema.Struct({ sessionId: AuthSessionId }),
    Result: Schema.Struct({
      sessionId: Schema.String,
      personId: Schema.Unknown,
      username: Schema.Unknown,
      claimedAt: Schema.Unknown,
      method: Schema.Unknown,
    }),
    execute: ({ sessionId }) =>
      sql`
        SELECT
          session_id AS "sessionId",
          person_id AS "personId",
          username AS "username",
          claimed_at AS "claimedAt",
          method AS "method"
        FROM session_identity_claims
        WHERE session_id = ${sessionId}
      `,
  });

  const upsertRow = SqlSchema.void({
    Request: SessionIdentityClaimRecord,
    execute: (input) =>
      sql`
        INSERT INTO session_identity_claims (
          session_id,
          person_id,
          username,
          claimed_at,
          method
        )
        VALUES (
          ${input.sessionId},
          ${input.personId},
          ${input.username},
          ${input.claimedAt},
          ${input.method}
        )
        ON CONFLICT(session_id) DO UPDATE SET
          person_id = excluded.person_id,
          username = excluded.username,
          claimed_at = excluded.claimed_at,
          method = excluded.method
      `,
  });

  const deleteRow = SqlSchema.void({
    Request: Schema.Struct({ sessionId: AuthSessionId }),
    execute: ({ sessionId }) =>
      sql`
        DELETE FROM session_identity_claims
        WHERE session_id = ${sessionId}
      `,
  });

  return {
    getBySessionId: (sessionId) =>
      getRow({ sessionId }).pipe(
        Effect.mapError(
          toError(
            "SessionIdentityClaimRepository.getBySessionId:query",
            "SessionIdentityClaimRepository.getBySessionId:decode",
            { sessionId },
          ),
        ),
        Effect.flatMap((rowOption) =>
          Option.match(rowOption, {
            onNone: () => Effect.succeed(Option.none()),
            onSome: (row) =>
              decodeClaim(row).pipe(
                Effect.mapError((cause) =>
                  PersistenceDecodeError.fromSchemaError(
                    "SessionIdentityClaimRepository.getBySessionId:decode",
                    cause,
                    { sessionId },
                  ),
                ),
                Effect.map((decoded) => Option.some(decoded)),
              ),
          }),
        ),
      ),
    upsert: (record) =>
      upsertRow(record).pipe(
        Effect.mapError(
          toError(
            "SessionIdentityClaimRepository.upsert:query",
            "SessionIdentityClaimRepository.upsert:encode",
            { sessionId: record.sessionId },
          ),
        ),
      ),
    deleteBySessionId: (sessionId) =>
      deleteRow({ sessionId }).pipe(
        Effect.mapError(
          toError(
            "SessionIdentityClaimRepository.deleteBySessionId:query",
            "SessionIdentityClaimRepository.deleteBySessionId:encode",
            { sessionId },
          ),
        ),
        Effect.as(true),
      ),
  } satisfies SessionIdentityClaimRepository["Service"];
});

export const layer = Layer.effect(SessionIdentityClaimRepository, make);
