import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("061_CleanupCodexRootSubagent", (it) => {
  it.effect("deletes exact phantom pairs and preserves near matches", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 60 });

      yield* sql`
        INSERT INTO provider_session_runtime (
          thread_id, provider_name, adapter_key, runtime_mode, status,
          last_seen_at, resume_cursor_json, runtime_payload_json
        ) VALUES (
          'thread-cursor', 'codex', 'codex', 'full-access', 'ready',
          '2026-08-17T00:00:00.000Z', '{"threadId":"cursor-root"}', NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_subagents (
          subagent_id, thread_id, turn_id, agent_type, description, status,
          last_progress_summary, last_tool_name, usage_json, spawned_by_item_id,
          started_at, updated_at, completed_at, child_thread_id
        ) VALUES
          ('root-running', 'thread-fallback', NULL, NULL, NULL, 'running',
           'Subagent received input', NULL, NULL, NULL, '2026-08-17T00:00:00.000Z', '2026-08-17T00:00:00.000Z', NULL, NULL),
          ('root-completed', 'thread-fallback', NULL, NULL, NULL, 'completed',
           'Subagent received input', NULL, NULL, NULL, '2026-08-17T00:00:00.000Z', '2026-08-17T00:00:00.000Z', '2026-08-17T00:00:00.000Z', NULL),
          ('root-failed', 'thread-fallback', NULL, NULL, NULL, 'failed',
           'Subagent received input', NULL, NULL, NULL, '2026-08-17T00:00:00.000Z', '2026-08-17T00:00:00.000Z', '2026-08-17T00:00:00.000Z', NULL),
          ('root-stopped', 'thread-fallback', NULL, NULL, NULL, 'stopped',
           'Subagent received input', NULL, NULL, NULL, '2026-08-17T00:00:00.000Z', '2026-08-17T00:00:00.000Z', '2026-08-17T00:00:00.000Z', NULL),
          ('cursor-root', 'thread-cursor', NULL, 'unexpected', NULL, 'running',
           'Subagent received input', NULL, NULL, NULL, '2026-08-17T00:00:00.000Z', '2026-08-17T00:00:00.000Z', NULL, NULL),
          ('near-extra', 'thread-near', NULL, NULL, NULL, 'running',
           'Subagent received input', NULL, NULL, NULL, '2026-08-17T00:00:00.000Z', '2026-08-17T00:00:00.000Z', NULL, NULL),
          ('near-child', 'thread-near', NULL, NULL, 'real child', 'running',
           'Subagent received input', NULL, NULL, NULL, '2026-08-17T00:00:00.000Z', '2026-08-17T00:00:00.000Z', NULL, NULL)
      `;

      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at
        ) VALUES
          ('task-progress:thread-fallback:root-running', 'thread-fallback', NULL, 'info', 'task.progress', 'Subagent received input', '{"taskId":"root-running","title":"Subagent received input","detail":"Subagent received input","subagentType":"root","toolUseId":"call-running"}', '2026-08-17T00:00:00.000Z'),
          ('task-progress:thread-fallback:root-completed', 'thread-fallback', NULL, 'info', 'task.progress', 'Subagent received input', '{"taskId":"root-completed","title":"Subagent received input","detail":"Subagent received input","subagentType":"root","toolUseId":"call-completed"}', '2026-08-17T00:00:00.000Z'),
          ('task-progress:thread-fallback:root-failed', 'thread-fallback', NULL, 'info', 'task.progress', 'Subagent received input', '{"taskId":"root-failed","title":"Subagent received input","detail":"Subagent received input","subagentType":"root","toolUseId":"call-failed"}', '2026-08-17T00:00:00.000Z'),
          ('task-progress:thread-fallback:root-stopped', 'thread-fallback', NULL, 'info', 'task.progress', 'Subagent received input', '{"taskId":"root-stopped","title":"Subagent received input","detail":"Subagent received input","subagentType":"root","toolUseId":"call-stopped"}', '2026-08-17T00:00:00.000Z'),
          ('task-progress:thread-cursor:cursor-root', 'thread-cursor', NULL, 'info', 'task.progress', 'Subagent received input', '{"taskId":"cursor-root","title":"Subagent received input","detail":"Subagent received input","subagentType":"root","toolUseId":"call-cursor","extra":true}', '2026-08-17T00:00:00.000Z'),
          ('task-progress:thread-near:near-extra', 'thread-near', NULL, 'info', 'task.progress', 'Subagent received input', '{"taskId":"near-extra","title":"Subagent received input","detail":"Subagent received input","subagentType":"root","toolUseId":"call-extra","extra":true}', '2026-08-17T00:00:00.000Z'),
          ('task-progress:thread-near:near-child', 'thread-near', NULL, 'info', 'task.progress', 'Subagent received input', '{"taskId":"near-child","title":"Subagent received input","detail":"Subagent received input","subagentType":"root","toolUseId":"call-child"}', '2026-08-17T00:00:00.000Z')
      `;

      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
          command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json
        ) VALUES (
          'event-root-running', 'thread', 'thread-fallback', 1, 'thread.activity-appended',
          '2026-08-17T00:00:00.000Z', NULL, NULL, NULL, 'system',
          '{"threadId":"thread-fallback","activity":{"id":"task-progress:thread-fallback:root-running","kind":"task.progress","tone":"info","summary":"Subagent received input","turnId":null,"createdAt":"2026-08-17T00:00:00.000Z","payload":{"taskId":"root-running","title":"Subagent received input","detail":"Subagent received input","subagentType":"root","toolUseId":"call-running"}}}',
          '{}'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 61 });

      const remaining = yield* sql<{ readonly subagent_id: string }>`
        SELECT subagent_id FROM projection_thread_subagents ORDER BY subagent_id
      `;
      assert.deepStrictEqual(remaining, [
        { subagent_id: "near-child" },
        { subagent_id: "near-extra" },
      ]);

      const activities = yield* sql<{ readonly activity_id: string }>`
        SELECT activity_id FROM projection_thread_activities ORDER BY activity_id
      `;
      assert.strictEqual(activities.length, 2);

      const events = yield* sql<{ readonly provider_thread_id: string | null }>`
        SELECT json_extract(payload_json, '$.activity.payload.providerThreadId') AS provider_thread_id
        FROM orchestration_events WHERE event_id = 'event-root-running'
      `;
      assert.deepStrictEqual(events, [{ provider_thread_id: "root-running" }]);
    }),
  );
});
