import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as BackgroundPolicy from "./BackgroundPolicy.ts";

// Settling and unsettling a thread show up in PR polling within this window.
const SETTLED_SNAPSHOT_TTL = "30 seconds";

/** Worktrees whose live (not archived or deleted) threads are all settled. */
export const readSettledWorktrees = Effect.fn("SettledWorktreeFreeze.read")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly worktreePath: string }>`
    SELECT json_extract(payload_json, '$.worktreePath') AS "worktreePath"
    FROM orchestration_v2_projection_threads
    WHERE deleted_at IS NULL
      AND archived_at IS NULL
      AND json_extract(payload_json, '$.worktreePath') IS NOT NULL
    GROUP BY 1
    HAVING MIN(
      json_extract(payload_json, '$.settledOverride') = 'settled'
      AND json_extract(payload_json, '$.settledAt') IS NOT NULL
    ) = 1
  `;
  return new Set(rows.map((row) => row.worktreePath));
});

/**
 * Background VCS status for a worktree whose threads are all settled never polls the hosting
 * provider: each visible sidebar row otherwise costs one PR lookup per poll, and those GraphQL
 * calls exhaust the GitHub quota. A subscriber's first refresh still runs (the broadcaster skips
 * the policy for it), so badges show the last state.
 */
export const withSettledWorktreeFreeze = (
  base: BackgroundPolicy.BackgroundPolicy["Service"],
  settledWorktrees: Effect.Effect<ReadonlySet<string>>,
): BackgroundPolicy.BackgroundPolicy["Service"] =>
  BackgroundPolicy.BackgroundPolicy.of({
    ...base,
    shouldRunScopeWork: Effect.fn("SettledWorktreeFreeze.shouldRunScopeWork")(function* (scope) {
      if (scope.type === "vcs-status" && (yield* settledWorktrees).has(scope.cwd)) return false;
      return yield* base.shouldRunScopeWork(scope);
    }),
  });

/** BackgroundPolicy.layer plus the settled-worktree freeze. */
export const layer = Layer.effect(
  BackgroundPolicy.BackgroundPolicy,
  Effect.gen(function* () {
    const base = yield* BackgroundPolicy.make();
    const sql = yield* SqlClient.SqlClient;
    const settledWorktrees = yield* Effect.cachedWithTTL(
      readSettledWorktrees().pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        // Without the snapshot every worktree keeps polling, as upstream does.
        Effect.orElseSucceed(() => new Set<string>()),
      ),
      SETTLED_SNAPSHOT_TTL,
    );
    return withSettledWorktreeFreeze(base, settledWorktrees);
  }),
);
