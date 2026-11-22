import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { forkMigrationManifest, forkMigrationTable } from "./ForkMigrations.ts";
import { legacyMigrationBackupTable, upstreamMigrationTable } from "./MigrationBootstrap.ts";
import { hasPendingMigrations, migrationManifest, runMigrations } from "./Migrations.ts";

interface LedgerRow {
  readonly migration_id: number;
  readonly name: string;
}

const forkNames = new Set<string>([
  "ProjectionQueuedMessages",
  "SessionIdentityClaims",
  "ProjectionThreadSourceAttribution",
  "RepairProjectionThreadTitleRegeneration",
  "RepairProjectionThreadsPinned",
]);

const freshDatabase = () => Layer.fresh(NodeSqliteClient.layer({ filename: ":memory:" }));

const readLedger = (table: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql<LedgerRow>`
      SELECT migration_id, name FROM ${sql(table)} ORDER BY migration_id
    `;
  });

const tableExists = (table: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows =
      yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${table}`;
    return rows.length > 0;
  });

/** Upstream schema through `throughId`, written as a build without the namespace split left it. */
const legacySharedLedger = (throughId: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: throughId });
    yield* sql`DROP TABLE t3_migration_namespaces`;
    yield* sql`DROP TABLE ${sql(forkMigrationTable)}`;
  });

const createLegacyQueuedMessages = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE projection_queued_messages (message_id TEXT PRIMARY KEY, thread_id TEXT)`;
  yield* sql`CREATE INDEX idx_projection_queued_messages_thread ON projection_queued_messages(thread_id)`;
});

const assertUpstreamLedgerIsUpstreamOnly = Effect.gen(function* () {
  const upstream = yield* readLedger(upstreamMigrationTable);
  assert.deepStrictEqual(
    upstream.map(({ migration_id }) => migration_id),
    migrationManifest.map(([id]) => id),
  );
  assert.ok(upstream.every(({ name }) => !forkNames.has(name)));
});

it("keeps fork migrations out of the upstream manifest", () => {
  const upstreamNames = new Set<string>(migrationManifest.map(([, name]) => name));
  assert.notEqual(upstreamMigrationTable, forkMigrationTable);
  assert.deepStrictEqual(forkMigrationManifest, [
    [2, "SessionIdentityClaims"],
    [3, "ProjectionThreadSourceAttribution"],
  ]);
  for (const [, name] of forkMigrationManifest) assert.ok(!upstreamNames.has(name));
});

it.effect("runs fork migrations 2 and 3 on a fresh database", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations();

    assert.deepStrictEqual(yield* readLedger(forkMigrationTable), [
      { migration_id: 2, name: "SessionIdentityClaims" },
      { migration_id: 3, name: "ProjectionThreadSourceAttribution" },
    ]);
    yield* assertUpstreamLedgerIsUpstreamOnly;
    assert.ok(yield* tableExists("session_identity_claims"));
    const threadColumns = yield* sql<{
      readonly name: string;
    }>`PRAGMA table_info(projection_threads)`;
    assert.ok(threadColumns.some(({ name }) => name === "participant_summaries_json"));
    assert.isFalse(yield* hasPendingMigrations());
  }).pipe(Effect.provide(freshDatabase())),
);

it.effect("runs nothing on an existing fork database whose ledger is at 3", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations();
    // Older fork builds also recorded the dropped queued-messages migration as id 1.
    yield* sql`INSERT INTO ${sql(forkMigrationTable)} (migration_id, name) VALUES (1, 'ProjectionQueuedMessages')`;
    yield* sql`DROP TABLE session_identity_claims`;

    assert.isFalse(yield* hasPendingMigrations());
    yield* runMigrations();

    assert.deepStrictEqual(
      (yield* readLedger(forkMigrationTable)).map(({ migration_id }) => migration_id),
      [1, 2, 3],
    );
    assert.isFalse(yield* tableExists("session_identity_claims"));
  }).pipe(Effect.provide(freshDatabase())),
);

it.effect("adds the fork ledger to a database written by upstream", () =>
  Effect.gen(function* () {
    yield* legacySharedLedger(Math.max(...migrationManifest.map(([id]) => id)));
    assert.isTrue(yield* hasPendingMigrations());

    yield* runMigrations();

    yield* assertUpstreamLedgerIsUpstreamOnly;
    assert.deepStrictEqual(
      (yield* readLedger(forkMigrationTable)).map(({ migration_id }) => migration_id),
      [2, 3],
    );
    assert.isFalse(yield* tableExists(legacyMigrationBackupTable));
  }).pipe(Effect.provide(freshDatabase())),
);

it.effect("moves repaired legacy fork rows out of the upstream ledger", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* legacySharedLedger(36);
    yield* createLegacyQueuedMessages;
    yield* sql`
      INSERT INTO ${sql(upstreamMigrationTable)} (migration_id, name)
      VALUES
        (37, 'ProjectionQueuedMessages'),
        (39, 'RepairProjectionThreadTitleRegeneration'),
        (40, 'RepairProjectionThreadsPinned')
    `;

    yield* runMigrations();

    yield* assertUpstreamLedgerIsUpstreamOnly;
    assert.deepStrictEqual(
      (yield* readLedger(forkMigrationTable)).map(({ migration_id }) => migration_id),
      [1, 2, 3],
    );
    assert.deepStrictEqual((yield* readLedger(legacyMigrationBackupTable)).slice(-3), [
      { migration_id: 37, name: "ProjectionQueuedMessages" },
      { migration_id: 39, name: "RepairProjectionThreadTitleRegeneration" },
      { migration_id: 40, name: "RepairProjectionThreadsPinned" },
    ]);
  }).pipe(Effect.provide(freshDatabase())),
);

it.effect("repairs a mixed ledger whose fork rows collided with upstream ids 35 and 36", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* legacySharedLedger(34);
    yield* createLegacyQueuedMessages;
    yield* sql`
      CREATE TABLE session_identity_claims (
        session_id TEXT PRIMARY KEY NOT NULL,
        person_id TEXT NOT NULL,
        username TEXT NOT NULL,
        claimed_at TEXT NOT NULL,
        method TEXT NOT NULL
      )
    `;
    yield* sql`CREATE INDEX idx_session_identity_claims_person ON session_identity_claims(person_id)`;
    yield* sql`ALTER TABLE projection_thread_messages ADD COLUMN source_json TEXT`;
    yield* sql`ALTER TABLE projection_threads ADD COLUMN origin_source_json TEXT`;
    yield* sql`ALTER TABLE projection_threads ADD COLUMN participant_summaries_json TEXT`;
    yield* sql`
      INSERT INTO ${sql(upstreamMigrationTable)} (migration_id, name)
      VALUES
        (35, 'ProjectionQueuedMessages'),
        (36, 'SessionIdentityClaims'),
        (37, 'ProjectionThreadSourceAttribution'),
        (39, 'RepairProjectionThreadTitleRegeneration')
    `;

    yield* runMigrations();

    yield* assertUpstreamLedgerIsUpstreamOnly;
    assert.deepStrictEqual(
      (yield* readLedger(forkMigrationTable)).map(({ migration_id }) => migration_id),
      [1, 2, 3],
    );
  }).pipe(Effect.provide(freshDatabase())),
);
