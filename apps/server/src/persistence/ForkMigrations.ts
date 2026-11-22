import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import {
  bootstrapMigrationNamespaces,
  forkMigrationTable,
  isMigrationNamespaceBootstrapped,
} from "./MigrationBootstrap.ts";
import Migration0002 from "./ForkMigrations/002_SessionIdentityClaims.ts";
import Migration0003 from "./ForkMigrations/003_ProjectionThreadSourceAttribution.ts";

export { forkMigrationTable };

/**
 * Fork migrations have their own id space and ledger. Never add a downstream
 * migration to the upstream manifest in Migrations.ts, and never renumber:
 * id 1 (ProjectionQueuedMessages) was dropped, so existing ledgers keep it as history.
 */
const forkMigrationEntries = [
  [2, "SessionIdentityClaims", Migration0002],
  [3, "ProjectionThreadSourceAttribution", Migration0003],
] as const;

export const forkMigrationManifest = forkMigrationEntries.map(([id, name]) => [id, name] as const);

const latestForkMigrationId = Math.max(...forkMigrationEntries.map(([id]) => id));

const makeForkMigrationLoader = () =>
  Migrator.fromRecord(
    Object.fromEntries(
      forkMigrationEntries.map(([id, name, migration]) => [`${id}_${name}`, migration]),
    ),
  );

const runForkLedger = Migrator.make({});

const forkLedgerLatestId = Effect.fn("ForkMigrations.forkLedgerLatestId")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${forkMigrationTable}
  `;
  if (tables.length === 0) return 0;
  const [row] = yield* sql<{ readonly id: number | null }>`
    SELECT MAX(migration_id) AS id FROM ${sql(forkMigrationTable)}
  `;
  return row?.id ?? 0;
});

/** `hasPendingMigrations` hook: also pending while the fork ledger is behind or not split out yet. */
export const withForkPendingMigrations = Effect.fn("ForkMigrations.withForkPendingMigrations")(
  function* <E, R>(upstreamPending: Effect.Effect<boolean, E, R>) {
    if (yield* upstreamPending) return true;
    if (!(yield* isMigrationNamespaceBootstrapped())) return true;
    return (yield* forkLedgerLatestId()) < latestForkMigrationId;
  },
);

/**
 * `runMigrations` hook. Legacy fork rows leave the upstream ledger before upstream runs,
 * because the Migrator skips every id up to the highest recorded one. Fork migrations
 * alter upstream tables, so they run only after a full upstream run.
 */
export const withForkMigrations = Effect.fn("ForkMigrations.withForkMigrations")(function* <
  A,
  E,
  R,
>(
  upstream: Effect.Effect<A, E, R>,
  options: { readonly toMigrationInclusive?: number | undefined } = {},
) {
  yield* bootstrapMigrationNamespaces();
  const result = yield* upstream;
  if (options.toMigrationInclusive !== undefined) return result;
  if ((yield* forkLedgerLatestId()) >= latestForkMigrationId) return result;
  const executed = yield* runForkLedger({
    loader: makeForkMigrationLoader(),
    table: forkMigrationTable,
  });
  if (executed.length > 0) {
    yield* Effect.log("Fork database migrations finished").pipe(
      Effect.annotateLogs({ migrations: executed.map(([id, name]) => `${id}_${name}`) }),
    );
  }
  return result;
});
