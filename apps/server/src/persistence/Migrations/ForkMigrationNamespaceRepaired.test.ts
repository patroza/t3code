import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Migrator from "effect/unstable/sql/Migrator";

import { forkMigrationTable } from "../ForkMigrations.ts";
import { upstreamMigrationTable } from "../MigrationBootstrap.ts";
import { makeMigrationLoader, runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
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
      assert.deepStrictEqual(upstream.slice(-2), [
        { migration_id: 35, name: "ProjectionThreadTitleRegeneration" },
        { migration_id: 36, name: "ProjectionThreadsPinned" },
      ]);
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
