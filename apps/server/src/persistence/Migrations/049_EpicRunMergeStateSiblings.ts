/** Per-sibling merge-tracking state for multi-repo epic runs; old rows decode to `[]`. */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE epic_run_merge_state ADD COLUMN siblings TEXT NOT NULL DEFAULT '[]'`;
});
