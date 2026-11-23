import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import type * as BackgroundPolicy from "./BackgroundPolicy.ts";
import { readSettledWorktrees, withSettledWorktreeFreeze } from "./settledWorktreeFreeze.ts";

const insertThread = Effect.fn("test.insertThread")(function* (input: {
  readonly id: string;
  readonly worktreePath: string | null;
  readonly settled: boolean;
  readonly archived?: true;
  readonly deleted?: true;
}) {
  const sql = yield* SqlClient.SqlClient;
  const payload = JSON.stringify({
    worktreePath: input.worktreePath,
    settledOverride: input.settled ? "settled" : null,
    settledAt: input.settled ? "2026-11-23T10:00:00.000Z" : null,
  });
  yield* sql`
    INSERT INTO orchestration_v2_projection_threads
      (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
       created_at, updated_at, archived_at, deleted_at, payload_json)
    VALUES (${input.id}, 'project', 'title', 'codex', 'full-access', 'default',
      '2026-11-23T09:00:00.000Z', '2026-11-23T09:00:00.000Z',
      ${input.archived ? "2026-11-23T11:00:00.000Z" : null},
      ${input.deleted ? "2026-11-23T11:00:00.000Z" : null}, ${payload})
  `;
});

it.effect("a worktree freezes only while every live thread on it is settled", () =>
  Effect.gen(function* () {
    yield* insertThread({ id: "a1", worktreePath: "/wt/all-settled", settled: true });
    yield* insertThread({ id: "a2", worktreePath: "/wt/all-settled", settled: true });
    yield* insertThread({ id: "m1", worktreePath: "/wt/mixed", settled: true });
    yield* insertThread({ id: "m2", worktreePath: "/wt/mixed", settled: false });
    // Archived and deleted threads no longer hold a worktree's PR open.
    yield* insertThread({ id: "r1", worktreePath: "/wt/revived", settled: true });
    yield* insertThread({ id: "r2", worktreePath: "/wt/revived", settled: false, archived: true });
    yield* insertThread({ id: "r3", worktreePath: "/wt/revived", settled: false, deleted: true });
    yield* insertThread({ id: "root", worktreePath: null, settled: true });

    const settled = yield* readSettledWorktrees();

    expect([...settled].toSorted()).toEqual(["/wt/all-settled", "/wt/revived"]);
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("frozen worktrees skip background VCS status; other work keeps upstream's answer", () =>
  Effect.gen(function* () {
    const base = {
      shouldRunScopeWork: () => Effect.succeed(true),
    } as unknown as BackgroundPolicy.BackgroundPolicy["Service"];
    const policy = withSettledWorktreeFreeze(base, Effect.succeed(new Set(["/wt/settled"])));

    expect(yield* policy.shouldRunScopeWork({ type: "vcs-status", cwd: "/wt/settled" })).toBe(
      false,
    );
    expect(yield* policy.shouldRunScopeWork({ type: "vcs-status", cwd: "/wt/active" })).toBe(true);
    expect(yield* policy.shouldRunScopeWork({ type: "git-refs", cwd: "/wt/settled" })).toBe(true);
  }),
);
