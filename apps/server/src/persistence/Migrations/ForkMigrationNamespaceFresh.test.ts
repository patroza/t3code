import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { forkMigrationTable } from "../ForkMigrations.ts";
import { upstreamMigrationTable } from "../MigrationBootstrap.ts";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("fork migration namespace on a fresh database", (it) => {
  it.effect("runs equal numeric ids independently", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();

      const upstream = yield* sql<LedgerRow>`
        SELECT migration_id, name FROM ${sql(upstreamMigrationTable)} WHERE migration_id = 1
      `;
      const fork = yield* sql<LedgerRow>`
        SELECT migration_id, name FROM ${sql(forkMigrationTable)} ORDER BY migration_id
      `;
      assert.deepStrictEqual(upstream, [{ migration_id: 1, name: "OrchestrationEvents" }]);
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
