import { EventId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProjectionThreadActivityRepository } from "../Services/ProjectionThreadActivities.ts";
import type { ProjectionThreadActivity } from "../Services/ProjectionThreadActivities.ts";
import { ProjectionThreadActivityRepositoryLive } from "./ProjectionThreadActivities.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const threadId = ThreadId.make("thread-activity-kinds");
const otherThreadId = ThreadId.make("thread-activity-kinds-other");

const activity = (
  id: string,
  kind: string,
  createdAt: string,
  overrides: Partial<ProjectionThreadActivity> = {},
): ProjectionThreadActivity => ({
  activityId: EventId.make(id),
  threadId,
  turnId: null,
  tone: "info",
  kind,
  summary: `${kind} ${id}`,
  payload: { requestId: `request-${id}` },
  createdAt,
  ...overrides,
});

const layer = it.layer(
  Layer.mergeAll(
    ProjectionThreadActivityRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    SqlitePersistenceMemory,
  ),
);

layer("ProjectionThreadActivityRepository", (it) => {
  const seed = Effect.fn("seed")(function* () {
    const activities = yield* ProjectionThreadActivityRepository;
    yield* activities.upsert(activity("a1", "user-input.requested", "2026-03-24T00:00:01.000Z"));
    yield* activities.upsert(activity("a2", "tool.updated", "2026-03-24T00:00:02.000Z"));
    yield* activities.upsert(activity("a3", "user-input.resolved", "2026-03-24T00:00:03.000Z"));
    yield* activities.upsert(activity("a4", "tool.completed", "2026-03-24T00:00:04.000Z"));
    yield* activities.upsert(
      activity("a5", "user-input.requested", "2026-03-24T00:00:05.000Z", {
        threadId: otherThreadId,
      }),
    );
    return activities;
  });

  it.effect("returns only the requested kinds", () =>
    Effect.gen(function* () {
      const activities = yield* seed();

      const rows = yield* activities.listByThreadIdAndKinds({
        threadId,
        kinds: ["user-input.requested", "user-input.resolved"],
      });

      assert.deepStrictEqual(
        rows.map((row) => row.activityId),
        ["a1", "a3"],
      );
    }),
  );

  it.effect("keeps the same ordering as the unfiltered list", () =>
    Effect.gen(function* () {
      const activities = yield* seed();

      const all = yield* activities.listByThreadId({ threadId });
      const filtered = yield* activities.listByThreadIdAndKinds({
        threadId,
        kinds: ["user-input.requested", "user-input.resolved", "tool.updated", "tool.completed"],
      });

      assert.deepStrictEqual(
        filtered.map((row) => row.activityId),
        all.map((row) => row.activityId),
      );
    }),
  );

  it.effect("decodes the payload the same way the unfiltered list does", () =>
    Effect.gen(function* () {
      const activities = yield* seed();

      const [filtered] = yield* activities.listByThreadIdAndKinds({
        threadId,
        kinds: ["user-input.requested"],
      });
      const all = yield* activities.listByThreadId({ threadId });
      const unfiltered = all.find((row) => row.activityId === "a1");

      assert.deepStrictEqual(filtered, unfiltered);
    }),
  );

  it.effect("does not reach across threads", () =>
    Effect.gen(function* () {
      const activities = yield* seed();

      const rows = yield* activities.listByThreadIdAndKinds({
        threadId: otherThreadId,
        kinds: ["user-input.requested"],
      });

      assert.deepStrictEqual(
        rows.map((row) => row.activityId),
        ["a5"],
      );
    }),
  );

  it.effect("returns nothing for an empty kind list without querying", () =>
    Effect.gen(function* () {
      const activities = yield* seed();

      const rows = yield* activities.listByThreadIdAndKinds({ threadId, kinds: [] });

      assert.deepStrictEqual(rows, []);
    }),
  );

  it.effect("reads only the latest matching task activity", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadActivityRepository;
      const sql = yield* SqlClient.SqlClient;
      const latestTaskThreadId = ThreadId.make("thread-latest-task-activity");

      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
        )
        VALUES
          (
            'activity-task-unrelated-tool', ${latestTaskThreadId}, NULL, 'tool', 'tool.completed',
            'large tool output', 'not-json', 1, '2026-03-01T00:00:00.000Z'
          ),
          (
            'activity-task-started', ${latestTaskThreadId}, NULL, 'info', 'task.started',
            'started', '{"taskId":"task-1","title":"Initial title"}', 2,
            '2026-03-01T00:00:01.000Z'
          ),
          (
            'activity-task-progress', ${latestTaskThreadId}, NULL, 'info', 'task.progress',
            'progress', '{"taskId":"task-1","title":"Updated title"}', 3,
            '2026-03-01T00:00:02.000Z'
          ),
          (
            'activity-task-other', ${latestTaskThreadId}, NULL, 'info', 'task.progress',
            'other', '{"taskId":"task-2","title":"Other title"}', 4,
            '2026-03-01T00:00:03.000Z'
          )
      `;

      yield* repository.upsert({
        activityId: EventId.make("activity-task-untitled"),
        threadId: latestTaskThreadId,
        turnId: null,
        tone: "info",
        kind: "task.progress",
        summary: "Still running",
        payload: { taskId: "task-1" },
        sequence: 5,
        createdAt: "2026-03-01T00:00:04.000Z",
      });
      yield* repository.upsert({
        activityId: EventId.make("activity-task-blank-title"),
        threadId: latestTaskThreadId,
        turnId: null,
        tone: "info",
        kind: "task.progress",
        summary: "Still running",
        payload: { taskId: "task-1", title: " \t\n\u00a0" },
        sequence: 6,
        createdAt: "2026-03-01T00:00:05.000Z",
      });

      const recent = yield* repository.listByThreadId({
        threadId: latestTaskThreadId,
        activityKinds: ["task.progress"],
        limit: 2,
      });
      assert.deepEqual(
        recent.map((entry) => entry.activityId),
        ["activity-task-untitled", "activity-task-blank-title"],
      );

      const latestTaskActivity = yield* repository.getLatestTaskActivity({
        threadId: latestTaskThreadId,
        taskId: "task-1",
      });
      assert.equal(latestTaskActivity._tag, "Some");
      if (latestTaskActivity._tag === "Some") {
        assert.equal(latestTaskActivity.value.activityId, EventId.make("activity-task-progress"));
        assert.deepEqual(latestTaskActivity.value.payload, {
          taskId: "task-1",
          title: "Updated title",
        });
      }

      assert.equal(
        (yield* repository.getLatestTaskActivity({
          threadId: latestTaskThreadId,
          taskId: "missing",
        }))._tag,
        "None",
      );
    }),
  );
});
