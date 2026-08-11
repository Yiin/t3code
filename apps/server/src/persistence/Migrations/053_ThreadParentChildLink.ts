/**
 * The durable parent/child thread link for thread-backed subagents.
 *
 * `projection_thread_subagents.child_thread_id` names the thread a subagent
 * runs as; `projection_threads.parent_thread_id` names the thread that
 * spawned it. Both are nullable and every existing row is correctly NULL —
 * no subagent was thread-backed before this shipped, so there is no backfill.
 *
 * The child index is deliberately not UNIQUE. A duplicate claim would fail
 * the write and wedge the projection loop instead of surfacing one wrong row.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE projection_thread_subagents ADD COLUMN child_thread_id TEXT`;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_subagents_child_thread
    ON projection_thread_subagents(child_thread_id)
    WHERE child_thread_id IS NOT NULL
  `;

  yield* sql`ALTER TABLE projection_threads ADD COLUMN parent_thread_id TEXT`;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_parent_thread
    ON projection_threads(parent_thread_id)
    WHERE parent_thread_id IS NOT NULL
  `;
});
