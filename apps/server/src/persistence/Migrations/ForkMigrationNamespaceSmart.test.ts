import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Migrator from "effect/unstable/sql/Migrator";

import { forkMigrationTable } from "../ForkMigrations.ts";
import { legacyMigrationBackupTable, upstreamMigrationTable } from "../MigrationBootstrap.ts";
import { makeMigrationLoader, runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import ProjectionQueuedMessages from "./037_ProjectionQueuedMessages.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));
const runLegacyMigrations = Migrator.make({});

layer("smart migration namespace repair", (it) => {
  it.effect("repairs the observed smart mixed migration ledger", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runLegacyMigrations({ loader: makeMigrationLoader(34) });
      yield* ProjectionQueuedMessages;
      yield* sql`
        CREATE TABLE session_identity_claims (
          session_id TEXT PRIMARY KEY NOT NULL,
          person_id TEXT NOT NULL,
          username TEXT NOT NULL,
          claimed_at TEXT NOT NULL,
          method TEXT NOT NULL
        )
      `;
      yield* sql`
        CREATE INDEX idx_session_identity_claims_person
        ON session_identity_claims(person_id)
      `;
      yield* sql`ALTER TABLE projection_thread_messages ADD COLUMN source_json TEXT`;
      yield* sql`ALTER TABLE projection_threads ADD COLUMN origin_source_json TEXT`;
      yield* sql`ALTER TABLE projection_threads ADD COLUMN participant_summaries_json TEXT`;
      yield* sql`ALTER TABLE projection_threads ADD COLUMN title_regeneration_request_id TEXT`;
      yield* sql`ALTER TABLE projection_threads ADD COLUMN title_regeneration_started_at TEXT`;
      yield* sql`ALTER TABLE projection_threads ADD COLUMN pinned_at TEXT`;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES
          (35, 'ProjectionQueuedMessages'),
          (36, 'SessionIdentityClaims'),
          (37, 'ProjectionThreadSourceAttribution'),
          (38, 'ProjectionThreadSourceAttribution'),
          (39, 'RepairProjectionThreadTitleRegeneration'),
          (40, 'ProjectionThreadSourceAttribution'),
          (41, 'ProjectionThreadSourceAttribution')
      `;

      yield* runMigrations();

      const backupTail = yield* sql<LedgerRow>`
        SELECT migration_id, name
        FROM ${sql(legacyMigrationBackupTable)}
        WHERE migration_id >= 35
        ORDER BY migration_id
      `;
      assert.deepStrictEqual(backupTail, [
        { migration_id: 35, name: "ProjectionQueuedMessages" },
        { migration_id: 36, name: "SessionIdentityClaims" },
        { migration_id: 37, name: "ProjectionThreadSourceAttribution" },
        { migration_id: 38, name: "ProjectionThreadSourceAttribution" },
        { migration_id: 39, name: "RepairProjectionThreadTitleRegeneration" },
        { migration_id: 40, name: "ProjectionThreadSourceAttribution" },
        { migration_id: 41, name: "ProjectionThreadSourceAttribution" },
      ]);

      const upstream = yield* sql<LedgerRow>`
        SELECT migration_id, name FROM ${sql(upstreamMigrationTable)} ORDER BY migration_id
      `;
      assert.deepStrictEqual(upstream.slice(-4), [
        { migration_id: 39, name: "ProjectionProjectsDefaultThreadEnvMode" },
        { migration_id: 40, name: "ProjectionProjectFaviconPath" },
        { migration_id: 41, name: "AuthSessionClientConnection" },
        { migration_id: 42, name: "ProjectionThreadLinkedPullRequest" },
      ]);
      const fork = yield* sql<LedgerRow>`
        SELECT migration_id, name FROM ${sql(forkMigrationTable)} ORDER BY migration_id
      `;
      assert.deepStrictEqual(fork, [
        { migration_id: 1, name: "ProjectionQueuedMessages" },
        { migration_id: 2, name: "SessionIdentityClaims" },
        { migration_id: 3, name: "ProjectionThreadSourceAttribution" },
      ]);
    }),
  );
});

interface LedgerRow {
  readonly migration_id: number;
  readonly name: string;
}
