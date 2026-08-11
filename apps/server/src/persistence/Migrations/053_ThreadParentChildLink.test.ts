import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("053_ThreadParentChildLink", (it) => {
  it.effect("defaults pre-existing rows to a null link", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 52 });
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
          branch, worktree_path, latest_turn_id, created_at, updated_at, archived_at,
          settled_override, settled_at, latest_user_message_at, pending_approval_count,
          pending_user_input_count, has_actionable_proposed_plan, deleted_at
        ) VALUES (
          'thread-1', 'project-1', 'Thread', '{}', 'full-access', 'default',
          NULL, NULL, NULL, '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z', NULL,
          NULL, NULL, NULL, 0, 0, 0, NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_thread_subagents (
          subagent_id, thread_id, turn_id, agent_type, description, status,
          last_progress_summary, last_tool_name, usage_json, spawned_by_item_id,
          started_at, updated_at, completed_at
        ) VALUES (
          'subagent-1', 'thread-1', NULL, NULL, NULL, 'running',
          NULL, NULL, NULL, NULL,
          '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z', NULL
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 53 });

      const threadRows = yield* sql<{ readonly parent_thread_id: string | null }>`
        SELECT parent_thread_id FROM projection_threads WHERE thread_id = 'thread-1'
      `;
      const subagentRows = yield* sql<{ readonly child_thread_id: string | null }>`
        SELECT child_thread_id FROM projection_thread_subagents WHERE subagent_id = 'subagent-1'
      `;
      assert.deepStrictEqual(threadRows, [{ parent_thread_id: null }]);
      assert.deepStrictEqual(subagentRows, [{ child_thread_id: null }]);
    }),
  );

  it.effect("stores a parent/child link and allows a duplicate child claim", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 53 });
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
          branch, worktree_path, latest_turn_id, created_at, updated_at, archived_at,
          settled_override, settled_at, latest_user_message_at, pending_approval_count,
          pending_user_input_count, has_actionable_proposed_plan, deleted_at, parent_thread_id
        ) VALUES (
          'thread-child', 'project-1', 'Child', '{}', 'full-access', 'default',
          NULL, NULL, NULL, '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z', NULL,
          NULL, NULL, NULL, 0, 0, 0, NULL, 'thread-parent'
        )
      `;
      // The child index is not UNIQUE on purpose: a duplicate claim must
      // surface as one wrong row, not wedge the projection loop.
      yield* sql`
        INSERT INTO projection_thread_subagents (
          subagent_id, thread_id, turn_id, agent_type, description, status,
          last_progress_summary, last_tool_name, usage_json, spawned_by_item_id,
          started_at, updated_at, completed_at, child_thread_id
        ) VALUES
          ('subagent-a', 'thread-parent', NULL, NULL, NULL, 'running',
           NULL, NULL, NULL, NULL,
           '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z', NULL, 'thread-child'),
          ('subagent-b', 'thread-parent', NULL, NULL, NULL, 'running',
           NULL, NULL, NULL, NULL,
           '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z', NULL, 'thread-child')
      `;

      const threadRows = yield* sql<{ readonly parent_thread_id: string | null }>`
        SELECT parent_thread_id FROM projection_threads WHERE thread_id = 'thread-child'
      `;
      const subagentRows = yield* sql<{ readonly subagent_id: string }>`
        SELECT subagent_id FROM projection_thread_subagents
        WHERE child_thread_id = 'thread-child'
        ORDER BY subagent_id ASC
      `;
      assert.deepStrictEqual(threadRows, [{ parent_thread_id: "thread-parent" }]);
      assert.deepStrictEqual(subagentRows, [
        { subagent_id: "subagent-a" },
        { subagent_id: "subagent-b" },
      ]);
    }),
  );
});
