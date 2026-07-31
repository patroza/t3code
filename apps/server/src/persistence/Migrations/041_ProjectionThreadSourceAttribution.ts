import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Source attribution denormalized onto projected messages and thread shells.
 * JSON columns stay optional for legacy rows (NULL = absent).
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const messageColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_thread_messages)
  `;
  if (!messageColumns.some((column) => column.name === "source_json")) {
    yield* sql`
      ALTER TABLE projection_thread_messages
      ADD COLUMN source_json TEXT
    `;
  }

  const threadColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  if (!threadColumns.some((column) => column.name === "origin_source_json")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN origin_source_json TEXT
    `;
  }
  if (!threadColumns.some((column) => column.name === "participant_summaries_json")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN participant_summaries_json TEXT
    `;
  }
});
