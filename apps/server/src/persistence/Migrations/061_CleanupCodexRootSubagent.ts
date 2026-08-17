/** Remove Codex child-to-root interaction rows mistaken for subagents. */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TEMP TABLE cleanup_codex_root_subagent_targets (
      thread_id TEXT NOT NULL,
      subagent_id TEXT NOT NULL,
      activity_id TEXT NOT NULL,
      PRIMARY KEY (thread_id, subagent_id)
    )
  `;

  yield* sql`
    INSERT OR IGNORE INTO cleanup_codex_root_subagent_targets (
      thread_id, subagent_id, activity_id
    )
    SELECT
      subagent.thread_id,
      subagent.subagent_id,
      activity.activity_id
    FROM projection_thread_subagents AS subagent
    JOIN projection_thread_activities AS activity
      ON activity.thread_id = subagent.thread_id
     AND activity.activity_id =
       'task-progress:' || subagent.thread_id || ':' || subagent.subagent_id
    LEFT JOIN provider_session_runtime AS runtime
      ON runtime.thread_id = subagent.thread_id
    WHERE activity.kind = 'task.progress'
      AND json_extract(activity.payload_json, '$.taskId') = subagent.subagent_id
      AND json_extract(activity.payload_json, '$.title') = 'Subagent received input'
      AND json_extract(activity.payload_json, '$.detail') = 'Subagent received input'
      AND json_extract(activity.payload_json, '$.subagentType') = 'root'
      AND trim(COALESCE(json_extract(activity.payload_json, '$.toolUseId'), '')) <> ''
      AND (
        json_extract(runtime.resume_cursor_json, '$.threadId') = subagent.subagent_id
        OR (
          subagent.agent_type IS NULL
          AND subagent.description IS NULL
          AND subagent.spawned_by_item_id IS NULL
          AND subagent.child_thread_id IS NULL
          AND (
            SELECT COUNT(*)
            FROM json_each(activity.payload_json) AS payload_field
            WHERE payload_field.key NOT IN (
              'taskId', 'title', 'detail', 'subagentType', 'toolUseId'
            )
          ) = 0
          AND (
            SELECT COUNT(*)
            FROM json_each(activity.payload_json)
          ) = 5
        )
      )
  `;

  // A projection rebuild replays these events. Add the proven root identity
  // so the shared fold and activity projector reject the same marker.
  yield* sql`
    UPDATE orchestration_events
    SET payload_json = json_set(
      payload_json,
      '$.activity.payload.providerThreadId',
      json_extract(payload_json, '$.activity.payload.taskId')
    )
    WHERE event_type = 'thread.activity-appended'
      AND EXISTS (
        SELECT 1
        FROM cleanup_codex_root_subagent_targets AS target
        WHERE json_extract(orchestration_events.payload_json, '$.threadId') = target.thread_id
          AND json_extract(orchestration_events.payload_json, '$.activity.id') = target.activity_id
          AND json_extract(orchestration_events.payload_json, '$.activity.kind') = 'task.progress'
          AND json_extract(
            orchestration_events.payload_json,
            '$.activity.payload.taskId'
          ) = target.subagent_id
          AND json_extract(
            orchestration_events.payload_json,
            '$.activity.payload.title'
          ) = 'Subagent received input'
          AND json_extract(
            orchestration_events.payload_json,
            '$.activity.payload.detail'
          ) = 'Subagent received input'
          AND json_extract(
            orchestration_events.payload_json,
            '$.activity.payload.subagentType'
          ) = 'root'
          AND trim(COALESCE(json_extract(
            orchestration_events.payload_json,
            '$.activity.payload.toolUseId'
          ), '')) <> ''
      )
  `;

  yield* sql`
    DELETE FROM projection_thread_activities
    WHERE EXISTS (
      SELECT 1
      FROM cleanup_codex_root_subagent_targets AS target
      WHERE projection_thread_activities.thread_id = target.thread_id
        AND projection_thread_activities.activity_id = target.activity_id
    )
  `;

  yield* sql`
    DELETE FROM projection_thread_subagents
    WHERE EXISTS (
      SELECT 1
      FROM cleanup_codex_root_subagent_targets AS target
      WHERE projection_thread_subagents.thread_id = target.thread_id
        AND projection_thread_subagents.subagent_id = target.subagent_id
    )
  `;

  yield* sql`DROP TABLE cleanup_codex_root_subagent_targets`;
});
