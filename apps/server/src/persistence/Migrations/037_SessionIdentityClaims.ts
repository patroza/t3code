import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS session_identity_claims (
      session_id TEXT PRIMARY KEY NOT NULL,
      person_id TEXT NOT NULL,
      username TEXT NOT NULL,
      claimed_at TEXT NOT NULL,
      method TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_session_identity_claims_person
    ON session_identity_claims(person_id)
  `;
});
