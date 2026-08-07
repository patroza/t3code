import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { MigrationError } from "effect/unstable/sql/Migrator";

import { forkMigrationTable } from "./ForkMigrations.ts";
import Migration0035 from "./Migrations/035_ProjectionThreadTitleRegeneration.ts";
import Migration0036 from "./Migrations/036_ProjectionThreadsPinned.ts";
import Migration0037 from "./Migrations/037_ProjectionTurnsKeysetIndex.ts";

export const upstreamMigrationTable = "effect_sql_migrations";
export const legacyMigrationBackupTable = "effect_sql_migrations_backup_v1";

const namespaceTable = "t3_migration_namespaces";
const namespaceVersion = 1;

const upstreamNames = new Map<number, string>([
  [1, "OrchestrationEvents"],
  [2, "OrchestrationCommandReceipts"],
  [3, "CheckpointDiffBlobs"],
  [4, "ProviderSessionRuntime"],
  [5, "Projections"],
  [6, "ProjectionThreadSessionRuntimeModeColumns"],
  [7, "ProjectionThreadMessageAttachments"],
  [8, "ProjectionThreadActivitySequence"],
  [9, "ProviderSessionRuntimeMode"],
  [10, "ProjectionThreadsRuntimeMode"],
  [11, "OrchestrationThreadCreatedRuntimeMode"],
  [12, "ProjectionThreadsInteractionMode"],
  [13, "ProjectionThreadProposedPlans"],
  [14, "ProjectionThreadProposedPlanImplementation"],
  [15, "ProjectionTurnsSourceProposedPlan"],
  [16, "CanonicalizeModelSelections"],
  [17, "ProjectionThreadsArchivedAt"],
  [18, "ProjectionThreadsArchivedAtIndex"],
  [19, "ProjectionSnapshotLookupIndexes"],
  [20, "AuthAccessManagement"],
  [21, "AuthSessionClientMetadata"],
  [22, "AuthSessionLastConnectedAt"],
  [23, "ProjectionThreadShellSummary"],
  [24, "BackfillProjectionThreadShellSummary"],
  [25, "CleanupInvalidProjectionPendingApprovals"],
  [26, "CanonicalizeModelSelectionOptions"],
  [27, "ProviderSessionRuntimeInstanceId"],
  [28, "ProjectionThreadSessionInstanceId"],
  [29, "ProjectionThreadDetailOrderingIndexes"],
  [30, "ProjectionThreadShellArchiveIndexes"],
  [31, "AuthAuthorizationScopes"],
  [32, "AuthPairingProofKeyThumbprint"],
  [33, "ProjectionThreadsSettled"],
  [34, "ProjectionThreadsSnoozed"],
  [35, "ProjectionThreadTitleRegeneration"],
  [36, "ProjectionThreadsPinned"],
  [37, "ProjectionTurnsKeysetIndex"],
]);

const knownForkNames = new Map([
  ["ProjectionQueuedMessages", 1],
  ["SessionIdentityClaims", 2],
  ["ProjectionThreadSourceAttribution", 3],
]);

const knownRepairNames = new Set([
  "RepairProjectionThreadTitleRegeneration",
  "RepairProjectionThreadsPinned",
]);

interface LedgerRow {
  readonly migration_id: number;
  readonly name: string;
}

const failBadState = (message: string) =>
  Effect.fail(new MigrationError({ kind: "BadState", message }));

const createLedger = (sql: SqlClient.SqlClient, table: string) =>
  sql`CREATE TABLE IF NOT EXISTS ${sql(table)} (
    migration_id integer PRIMARY KEY NOT NULL,
    created_at datetime NOT NULL DEFAULT current_timestamp,
    name VARCHAR(255) NOT NULL
  )`;

const tableExists = Effect.fn("MigrationBootstrap.tableExists")(function* (table: string) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly present: number }>`
    SELECT 1 AS present
    FROM sqlite_master
    WHERE type = 'table' AND name = ${table}
    LIMIT 1
  `;
  return rows.length > 0;
});

const indexExists = Effect.fn("MigrationBootstrap.indexExists")(function* (index: string) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly present: number }>`
    SELECT 1 AS present
    FROM sqlite_master
    WHERE type = 'index' AND name = ${index}
    LIMIT 1
  `;
  return rows.length > 0;
});

const verifyIdentitySchema = Effect.fn("MigrationBootstrap.verifyIdentitySchema")(function* () {
  if (
    !(yield* tableExists("session_identity_claims")) ||
    !(yield* indexExists("idx_session_identity_claims_person"))
  ) {
    return yield* failBadState(
      "Legacy migration ledger records SessionIdentityClaims, but its table or index is missing",
    );
  }
});

const verifySourceAttributionSchema = Effect.fn("MigrationBootstrap.verifySourceAttributionSchema")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    const messageColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_thread_messages)
  `;
    const threadColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
    const messageNames = new Set(messageColumns.map(({ name }) => name));
    const threadNames = new Set(threadColumns.map(({ name }) => name));
    if (
      !messageNames.has("source_json") ||
      !threadNames.has("origin_source_json") ||
      !threadNames.has("participant_summaries_json")
    ) {
      return yield* failBadState(
        "Legacy migration ledger records ProjectionThreadSourceAttribution, but its columns are missing",
      );
    }
  },
);

const bootstrapLegacyLedger = Effect.fn("MigrationBootstrap.bootstrapLegacyLedger")(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* createLedger(sql, forkMigrationTable);

  if (!(yield* tableExists(upstreamMigrationTable))) {
    yield* createLedger(sql, upstreamMigrationTable);
    return;
  }

  const legacyRows = yield* sql<LedgerRow>`
    SELECT migration_id, name
    FROM ${sql(upstreamMigrationTable)}
    ORDER BY migration_id
  `;
  yield* createLedger(sql, legacyMigrationBackupTable);
  if (legacyRows.length > 0) {
    yield* sql`INSERT OR IGNORE INTO ${sql(legacyMigrationBackupTable)} ${sql.insert(
      legacyRows.map(({ migration_id, name }) => ({ migration_id, name })),
    )}`;
  }
  if (legacyRows.length === 0) {
    return;
  }

  let canonicalPrefix = 0;
  for (const row of legacyRows) {
    if (
      row.migration_id === canonicalPrefix + 1 &&
      upstreamNames.get(row.migration_id) === row.name
    ) {
      canonicalPrefix = row.migration_id;
      continue;
    }
    break;
  }

  const tail = legacyRows.filter(({ migration_id }) => migration_id > canonicalPrefix);
  for (const { migration_id, name } of tail) {
    const knownUpstream = upstreamNames.get(migration_id) === name;
    if (!knownUpstream && !knownForkNames.has(name) && !knownRepairNames.has(name)) {
      return yield* failBadState(
        `Unrecognized legacy migration ${migration_id}_${name}; refusing to infer namespace state`,
      );
    }
  }

  const copiedUpstreamRows = legacyRows
    .filter(
      ({ migration_id, name }) =>
        migration_id <= canonicalPrefix && upstreamNames.get(migration_id) === name,
    )
    .map(({ migration_id, name }) => ({ migration_id, name }));
  if (tail.length > 0) {
    yield* Migration0035;
    yield* Migration0036;
    yield* Migration0037;
  }

  const forkNames = new Set(legacyRows.map(({ name }) => name));
  if (
    (forkNames.has("SessionIdentityClaims") && !forkNames.has("ProjectionQueuedMessages")) ||
    (forkNames.has("ProjectionThreadSourceAttribution") &&
      (!forkNames.has("ProjectionQueuedMessages") || !forkNames.has("SessionIdentityClaims")))
  ) {
    return yield* failBadState(
      "Legacy fork migrations do not form the expected contiguous prefix; refusing to skip missing work",
    );
  }
  if (forkNames.has("ProjectionQueuedMessages")) {
    if (
      !(yield* tableExists("projection_queued_messages")) ||
      !(yield* indexExists("idx_projection_queued_messages_thread"))
    ) {
      return yield* failBadState(
        "Legacy migration ledger records ProjectionQueuedMessages, but its table or index is missing",
      );
    }
    yield* sql`INSERT OR IGNORE INTO ${sql(forkMigrationTable)} ${sql.insert([
      { migration_id: 1, name: "ProjectionQueuedMessages" },
    ])}`;
  }
  if (forkNames.has("SessionIdentityClaims")) {
    yield* verifyIdentitySchema();
    yield* sql`INSERT OR IGNORE INTO ${sql(forkMigrationTable)} ${sql.insert([
      { migration_id: 2, name: "SessionIdentityClaims" },
    ])}`;
  }
  if (forkNames.has("ProjectionThreadSourceAttribution")) {
    yield* verifySourceAttributionSchema();
    yield* sql`INSERT OR IGNORE INTO ${sql(forkMigrationTable)} ${sql.insert([
      { migration_id: 3, name: "ProjectionThreadSourceAttribution" },
    ])}`;
  }

  yield* sql`DELETE FROM ${sql(upstreamMigrationTable)}`;
  if (copiedUpstreamRows.length > 0) {
    yield* sql`INSERT INTO ${sql(upstreamMigrationTable)} ${sql.insert(copiedUpstreamRows)}`;
  }
  if (tail.length > 0) {
    const reconciledRows = [35, 36, 37]
      .filter((migration_id) => migration_id > canonicalPrefix)
      .map((migration_id) => ({ migration_id, name: upstreamNames.get(migration_id)! }));
    if (reconciledRows.length > 0) {
      yield* sql`INSERT INTO ${sql(upstreamMigrationTable)} ${sql.insert(reconciledRows)}`;
    }
  }
});

export const bootstrapMigrationNamespaces = Effect.fn("bootstrapMigrationNamespaces")(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS ${sql(namespaceTable)} (
    version integer PRIMARY KEY NOT NULL,
    created_at datetime NOT NULL DEFAULT current_timestamp
  )`;
  const rows = yield* sql<{ readonly version: number }>`
    SELECT version FROM ${sql(namespaceTable)} WHERE version = ${namespaceVersion}
  `;
  if (rows.length > 0) {
    return;
  }

  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* bootstrapLegacyLedger();
      yield* sql`INSERT INTO ${sql(namespaceTable)} (version) VALUES (${namespaceVersion})`;
    }),
  );
});
