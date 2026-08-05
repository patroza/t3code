import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Migrator from "effect/unstable/sql/Migrator";

import { forkMigrationTable } from "../ForkMigrations.ts";
import { legacyMigrationBackupTable, upstreamMigrationTable } from "../MigrationBootstrap.ts";
import { makeMigrationLoader, runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));
const runLegacyMigrations = Migrator.make({});

layer("t3vm migration namespace repair", (it) => {
  it.effect("upgrades the observed canonical upstream ledger at migration 32", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runLegacyMigrations({ loader: makeMigrationLoader(32) });

      yield* runMigrations();

      const backup = yield* sql<LedgerRow>`
        SELECT migration_id, name FROM ${sql(legacyMigrationBackupTable)} ORDER BY migration_id
      `;
      assert.equal(backup.at(-1)?.migration_id, 32);

      const upstream = yield* sql<LedgerRow>`
        SELECT migration_id, name FROM ${sql(upstreamMigrationTable)} ORDER BY migration_id
      `;
      assert.deepStrictEqual(upstream.slice(-4), [
        { migration_id: 33, name: "ProjectionThreadsSettled" },
        { migration_id: 34, name: "ProjectionThreadsSnoozed" },
        { migration_id: 35, name: "ProjectionThreadTitleRegeneration" },
        { migration_id: 36, name: "ProjectionThreadsPinned" },
      ]);
      const fork = yield* sql<LedgerRow>`
        SELECT migration_id, name FROM ${sql(forkMigrationTable)} ORDER BY migration_id
      `;
      assert.deepStrictEqual(fork, [{ migration_id: 1, name: "ProjectionQueuedMessages" }]);
    }),
  );
});

interface LedgerRow {
  readonly migration_id: number;
  readonly name: string;
}
