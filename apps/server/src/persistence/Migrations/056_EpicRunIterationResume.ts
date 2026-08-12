/**
 * Resume bookkeeping for an epic-run iteration.
 *
 * A restart-resume continues the SAME provider session on the SAME thread, so
 * it reuses the interrupted row instead of appending a new one — `thread_id`
 * and `worker_id` are pure functions of `iteration_index`, so a second row
 * would carry the wrong thread id. These two columns are the only trace the
 * reuse leaves. Additive and unbackfilled: 0 / NULL is already the truth for
 * every row written before this migration.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE epic_run_iterations
    ADD COLUMN resume_count INTEGER NOT NULL DEFAULT 0
  `;
  yield* sql`ALTER TABLE epic_run_iterations ADD COLUMN last_resumed_at TEXT`;
});
