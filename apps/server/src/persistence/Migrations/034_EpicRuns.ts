/**
 * 034_EpicRuns - Durable state for epic runs and their iterations.
 *
 * `epic_run_iterations.summary` holds an excerpt of the iteration's final
 * assistant message, not the full transcript.
 *
 * `epic_run_iterations.turn_status` is the store's *only* in-flight marker: the
 * store deliberately does not join `projection_turns`, so a consumer must not
 * double-source truth from both.
 */
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS epic_runs (
      run_id TEXT PRIMARY KEY,
      epic_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      cwd TEXT NOT NULL,
      prompt TEXT NOT NULL,
      model_selection_json TEXT NOT NULL,
      runtime_mode TEXT NOT NULL,
      status TEXT NOT NULL,
      max_iterations INTEGER NOT NULL,
      iterations_completed INTEGER NOT NULL,
      current_thread_id TEXT,
      current_turn_started_at TEXT,
      consecutive_failures INTEGER NOT NULL,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS epic_run_iterations (
      run_id TEXT NOT NULL,
      iteration_index INTEGER NOT NULL,
      thread_id TEXT NOT NULL,
      turn_status TEXT NOT NULL,
      summary TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      UNIQUE (run_id, iteration_index)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_epic_runs_status
    ON epic_runs(status)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_epic_runs_epic_id
    ON epic_runs(epic_id)
  `;
});
