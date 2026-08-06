import * as Migrator from "effect/unstable/sql/Migrator";

import Migration0001 from "./Migrations/037_ProjectionQueuedMessages.ts";

export const forkMigrationTable = "t3_fork_sql_migrations";

/**
 * Fork migrations have their own id space and ledger. Never add a downstream
 * migration to the upstream manifest in Migrations.ts.
 *
 * IDs 2 and 3 are already assigned to the identity overlay's historical
 * SessionIdentityClaims and ProjectionThreadSourceAttribution migrations.
 */
export const forkMigrationEntries = [[1, "ProjectionQueuedMessages", Migration0001]] as const;

export const forkMigrationManifest = forkMigrationEntries.map(([id, name]) => [id, name] as const);

export const makeForkMigrationLoader = () =>
  Migrator.fromRecord(
    Object.fromEntries(
      forkMigrationEntries.map(([id, name, migration]) => [`${id}_${name}`, migration]),
    ),
  );
