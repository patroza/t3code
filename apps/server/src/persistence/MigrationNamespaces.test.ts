import { assert, describe, it } from "@effect/vitest";

import { forkMigrationManifest, forkMigrationTable } from "./ForkMigrations.ts";
import { upstreamMigrationTable } from "./MigrationBootstrap.ts";
import { migrationManifest } from "./Migrations.ts";

describe("migration namespaces", () => {
  it("keeps upstream and fork manifests in independent ledgers", () => {
    assert.notEqual(upstreamMigrationTable, forkMigrationTable);
    assert.deepStrictEqual(migrationManifest.slice(-21), [
      [52, "ProjectionThreadTitleState"],
      [53, "PullRequestFilesViewed"],
      [54, "ProjectionThreadsAutoSettleDisabledAt"],
      [55, "OrchestrationV2"],
      [56, "RemoveRedundantProjectionIndexes"],
      [57, "ScheduledTaskWebhooks"],
      [58, "WebhookRelayDeliveries"],
      [59, "McpAppModelContext"],
      [60, "ThreadSnapshotWindowIndexes"],
      [61, "PullRequestReviewGuides"],
      [62, "ThreadFailureLookupIndex"],
      [63, "DropUnusedV1Projections"],
      [64, "CanonicalizeThreadPullRequestLinks"],
      [65, "CodexUsageNativeTurnIndex"],
      [66, "RepairClientSettlementTimestamps"],
      [67, "WebhookDedupe"],
      [68, "ShellStopRequestIndex"],
      [69, "ThreadMessageSearch"],
      [70, "PeerLinks"],
      [71, "PeerLinkFence"],
      [72, "WaitingLinkRequestIndex"],
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
