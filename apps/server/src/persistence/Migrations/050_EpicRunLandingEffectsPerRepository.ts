/** One landing-effects row per landed repository; old rows are preserved. */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // SQLite cannot alter a primary key; rebuild the table.
  yield* sql`
    CREATE TABLE epic_run_landing_effects_new (
      run_id TEXT NOT NULL,
      repository_path TEXT NOT NULL,
      base_head TEXT NOT NULL,
      head TEXT NOT NULL,
      commit_count INTEGER NOT NULL,
      parked_count INTEGER NOT NULL,
      PRIMARY KEY (run_id, repository_path)
    )
  `;
  yield* sql`
    INSERT INTO epic_run_landing_effects_new (
      run_id, repository_path, base_head, head, commit_count, parked_count
    )
    SELECT run_id, repository_path, base_head, head, commit_count, parked_count
    FROM epic_run_landing_effects
  `;
  yield* sql`DROP TABLE epic_run_landing_effects`;
  yield* sql`ALTER TABLE epic_run_landing_effects_new RENAME TO epic_run_landing_effects`;
});
