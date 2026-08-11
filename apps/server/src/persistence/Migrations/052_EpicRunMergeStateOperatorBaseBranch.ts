/**
 * The operator's branch at launch (t3code-sha), for runs that own their base
 * branch. Nullable: old rows, and every run that does not own its base
 * branch, decode to `NULL` — read as "no continuous integration for this
 * run".
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE epic_run_merge_state ADD COLUMN operator_base_branch TEXT`;
});
