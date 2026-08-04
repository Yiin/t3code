/**
 * 040_ProjectionThreadSubagents - Durable per-subagent read-model rows.
 *
 * Subagent state is folded from `task.*` thread activities. Those activity
 * kinds are not pinned by THREAD_ACTIVITY_OPEN_REQUEST_KINDS, so capped
 * thread-detail reads evict them; this table keeps the folded row alive
 * regardless of how chatty the thread gets.
 *
 * One row per (thread_id, subagent_id); `subagent_id` is the provider
 * RuntimeTaskId. `usage_json` holds the provider's opaque usage payload.
 */
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_thread_subagents (
      subagent_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      turn_id TEXT,
      agent_type TEXT,
      description TEXT,
      status TEXT NOT NULL,
      last_progress_summary TEXT,
      last_tool_name TEXT,
      usage_json TEXT,
      spawned_by_item_id TEXT,
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      PRIMARY KEY (thread_id, subagent_id)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_subagents_thread_status
    ON projection_thread_subagents(thread_id, status)
  `;
});
