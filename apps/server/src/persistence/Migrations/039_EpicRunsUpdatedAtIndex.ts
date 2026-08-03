/**
 * 039_EpicRunsUpdatedAtIndex - Backs the recency-ordered run listing.
 *
 * `listRuns({ orderBy: "updatedAt-desc", limit })` reads the newest runs, and
 * the tie-break is `run_id DESC`, so the index covers both columns in that
 * direction. Without it SQLite sorts the whole table before applying the LIMIT.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_epic_runs_updated_at
    ON epic_runs(updated_at DESC, run_id DESC)
  `;
});
