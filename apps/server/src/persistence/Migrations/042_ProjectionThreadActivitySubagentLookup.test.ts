import { EventId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProjectionThreadActivityRepositoryLive } from "../Layers/ProjectionThreadActivities.ts";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { ProjectionThreadActivityRepository } from "../Services/ProjectionThreadActivities.ts";

const layer = it.layer(
  ProjectionThreadActivityRepositoryLive.pipe(Layer.provideMerge(NodeSqliteClient.layerMemory())),
);

layer("042_ProjectionThreadActivitySubagentLookup", (it) => {
  it.effect("indexes generated subagent lookup values without changing activity upserts", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const repository = yield* ProjectionThreadActivityRepository;

      yield* runMigrations({ toMigrationInclusive: 41 });
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          sequence,
          created_at
        )
        VALUES (
          'activity-before-migration',
          'thread-1',
          NULL,
          'tool',
          'tool.completed',
          'Existing activity',
          '{"parentToolUseId":"toolu-spawn-1","taskId":"task-1"}',
          1,
          '2026-08-05T00:00:00.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 42 });

      const byParentToolUse = yield* sql<{ readonly activityId: string }>`
        SELECT activity_id AS "activityId"
        FROM projection_thread_activities
        WHERE parent_tool_use_id = 'toolu-spawn-1'
      `;
      const byTask = yield* sql<{ readonly activityId: string }>`
        SELECT activity_id AS "activityId"
        FROM projection_thread_activities
        WHERE task_id = 'task-1'
      `;
      assert.deepStrictEqual(byParentToolUse, [{ activityId: "activity-before-migration" }]);
      assert.deepStrictEqual(byTask, [{ activityId: "activity-before-migration" }]);

      yield* repository.upsert({
        activityId: EventId.make("activity-after-migration"),
        threadId: ThreadId.make("thread-1"),
        turnId: null,
        tone: "info",
        kind: "task.progress",
        summary: "New activity",
        payload: { taskId: "task-2" },
        sequence: 2,
        createdAt: "2026-08-05T00:00:01.000Z",
      });
      const upserted = yield* sql<{ readonly activityId: string }>`
        SELECT activity_id AS "activityId"
        FROM projection_thread_activities
        WHERE task_id = 'task-2'
      `;
      assert.deepStrictEqual(upserted, [{ activityId: "activity-after-migration" }]);

      const indexes = yield* sql<{ readonly name: string }>`
        PRAGMA index_list(projection_thread_activities)
      `;
      const indexNames = new Set(indexes.map((index) => index.name));
      assert.ok(indexNames.has("idx_projection_thread_activities_thread_parent_tool_use"));
      assert.ok(indexNames.has("idx_projection_thread_activities_thread_task"));
    }),
  );
});
