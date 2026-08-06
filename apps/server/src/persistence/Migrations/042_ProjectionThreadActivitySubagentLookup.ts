import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_thread_activities
    ADD COLUMN parent_tool_use_id TEXT
    GENERATED ALWAYS AS (json_extract(payload_json, '$.parentToolUseId')) VIRTUAL
  `;
  yield* sql`
    ALTER TABLE projection_thread_activities
    ADD COLUMN task_id TEXT
    GENERATED ALWAYS AS (json_extract(payload_json, '$.taskId')) VIRTUAL
  `;
  yield* sql`
    CREATE INDEX idx_projection_thread_activities_thread_parent_tool_use
    ON projection_thread_activities(thread_id, parent_tool_use_id)
    WHERE parent_tool_use_id IS NOT NULL
  `;
  yield* sql`
    CREATE INDEX idx_projection_thread_activities_thread_task
    ON projection_thread_activities(thread_id, task_id)
    WHERE task_id IS NOT NULL
  `;
});
