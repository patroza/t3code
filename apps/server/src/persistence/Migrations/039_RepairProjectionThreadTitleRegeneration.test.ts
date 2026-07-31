import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import ProjectionQueuedMessages from "./036_ProjectionQueuedMessages.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("039_RepairProjectionThreadTitleRegeneration", (it) => {
  it.effect("repairs a database with the pre-restack migration 35", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 34 });
      yield* ProjectionQueuedMessages;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES
          (35, 'ProjectionQueuedMessages'),
          (36, 'SessionIdentityClaims'),
          (37, 'ProjectionThreadSourceAttribution'),
          (38, 'ProjectionThreadSourceAttribution')
      `;

      yield* runMigrations({ toMigrationInclusive: 39 });

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      const names = new Set(columns.map((column) => column.name));
      assert.ok(names.has("title_regeneration_request_id"));
      assert.ok(names.has("title_regeneration_started_at"));

      const migrations = yield* sql<{
        readonly migration_id: number;
        readonly name: string;
      }>`
        SELECT migration_id, name
        FROM effect_sql_migrations
        WHERE migration_id >= 35
        ORDER BY migration_id
      `;
      assert.deepStrictEqual(migrations, [
        { migration_id: 35, name: "ProjectionQueuedMessages" },
        { migration_id: 36, name: "SessionIdentityClaims" },
        { migration_id: 37, name: "ProjectionThreadSourceAttribution" },
        { migration_id: 38, name: "ProjectionThreadSourceAttribution" },
        { migration_id: 39, name: "RepairProjectionThreadTitleRegeneration" },
      ]);
    }),
  );
});
