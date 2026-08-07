import { assert, describe, it } from "@effect/vitest";

import { forkMigrationManifest, forkMigrationTable } from "./ForkMigrations.ts";
import { upstreamMigrationTable } from "./MigrationBootstrap.ts";
import { migrationManifest } from "./Migrations.ts";

describe("migration namespaces", () => {
  it("keeps upstream and fork manifests in independent ledgers", () => {
    assert.notEqual(upstreamMigrationTable, forkMigrationTable);
    assert.deepStrictEqual(migrationManifest.slice(-3), [
      [35, "ProjectionThreadTitleRegeneration"],
      [36, "ProjectionThreadsPinned"],
      [37, "ProjectionTurnsKeysetIndex"],
    ]);
    assert.deepStrictEqual(forkMigrationManifest, [
      [1, "ProjectionQueuedMessages"],
      [2, "SessionIdentityClaims"],
      [3, "ProjectionThreadSourceAttribution"],
    ]);

    const upstreamNames = new Set<string>(migrationManifest.map(([, name]) => name));
    for (const [, name] of forkMigrationManifest) {
      assert.ok(!upstreamNames.has(name), `${name} must not appear in the upstream manifest`);
    }
  });
});
