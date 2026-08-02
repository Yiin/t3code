/**
 * 038_EpicRunOriginThreadId - Records the thread that launched an epic run.
 *
 * Nullable and never backfilled: a run launched from the Epics page has no
 * origin thread, and neither do runs that predate this column. The value is
 * supplied by the launcher, not derived from the run's own iteration threads.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE epic_runs ADD COLUMN origin_thread_id TEXT`;
});
