/**
 * 043_EpicRunOrientationFile - Stores the optional repo orientation override.
 *
 * Existing runs use the default orientation candidates. A later config change
 * can set this field when the run starts without changing persisted rows.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE epic_runs ADD COLUMN orientation_file TEXT`;
});
