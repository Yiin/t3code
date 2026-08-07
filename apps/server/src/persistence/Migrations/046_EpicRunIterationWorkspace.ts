/** Worker identity and checkout coordinates for parallel epic iterations. */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE epic_run_iterations ADD COLUMN worker_id TEXT`;
  yield* sql`ALTER TABLE epic_run_iterations ADD COLUMN branch TEXT`;
  yield* sql`ALTER TABLE epic_run_iterations ADD COLUMN worktree_path TEXT`;
});
