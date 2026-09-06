import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Migrator from "effect/unstable/sql/Migrator";

import { forkMigrationTable } from "../ForkMigrations.ts";
import { legacyMigrationBackupTable, upstreamMigrationTable } from "../MigrationBootstrap.ts";
import { makeMigrationLoader, runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import ProjectionQueuedMessages from "./037_ProjectionQueuedMessages.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));
const runLegacyMigrations = Migrator.make({});

layer("fork migration namespace for a repaired database", (it) => {
  it.effect("converts the already-repaired fork ledger", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runLegacyMigrations({ loader: makeMigrationLoader(36) });
      yield* ProjectionQueuedMessages;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES
          (37, 'ProjectionQueuedMessages'),
          (39, 'RepairProjectionThreadTitleRegeneration'),
          (40, 'RepairProjectionThreadsPinned')
      `;

      yield* runMigrations();

      const upstream = yield* sql<LedgerRow>`
        SELECT migration_id, name FROM ${sql(upstreamMigrationTable)} ORDER BY migration_id
      `;
      const fork = yield* sql<LedgerRow>`
        SELECT migration_id, name FROM ${sql(forkMigrationTable)} ORDER BY migration_id
      `;
      const backup = yield* sql<LedgerRow>`
        SELECT migration_id, name FROM ${sql(legacyMigrationBackupTable)} ORDER BY migration_id
      `;
      assert.deepStrictEqual(upstream.slice(-4), [
        { migration_id: 45, name: "ProjectionProjectsAutoPull" },
        { migration_id: 46, name: "RepairAutomaticSettlementTimestamps" },
        { migration_id: 47, name: "ProjectionProjectIcon" },
        { migration_id: 48, name: "ProjectionThreadBranchPullRequest" },
      ]);
      assert.deepStrictEqual(fork, [
        { migration_id: 1, name: "ProjectionQueuedMessages" },
        { migration_id: 2, name: "SessionIdentityClaims" },
        { migration_id: 3, name: "ProjectionThreadSourceAttribution" },
      ]);
      assert.deepStrictEqual(backup.slice(-3), [
        { migration_id: 37, name: "ProjectionQueuedMessages" },
        { migration_id: 39, name: "RepairProjectionThreadTitleRegeneration" },
        { migration_id: 40, name: "RepairProjectionThreadsPinned" },
      ]);
    }),
  );
});

interface LedgerRow {
  readonly migration_id: number;
  readonly name: string;
}
