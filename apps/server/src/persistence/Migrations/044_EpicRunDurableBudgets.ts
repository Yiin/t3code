/** Durable epic-run dispatch and failure budgets, plus provider health. */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE epic_runs ADD COLUMN iterations_dispatched INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE epic_runs ADD COLUMN no_commit_streak INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE epic_runs ADD COLUMN infra_streak INTEGER NOT NULL DEFAULT 0`;
  yield* sql`
    UPDATE epic_runs
    SET iterations_dispatched = (
      SELECT COUNT(*)
      FROM epic_run_iterations
      WHERE epic_run_iterations.run_id = epic_runs.run_id
        AND COALESCE(epic_run_iterations.failure_reason, '') NOT IN (
          'infra:ready-unrecognised',
          'ready-unrecognised'
        )
    )
  `;
  yield* sql`
    CREATE TABLE epic_provider_degradations (
      provider_instance_id TEXT PRIMARY KEY,
      failure_reason TEXT NOT NULL,
      degraded_at TEXT NOT NULL
    )
  `;
});
