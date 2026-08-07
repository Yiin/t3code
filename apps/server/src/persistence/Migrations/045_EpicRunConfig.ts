/** Immutable resolved epic-run config snapshots. */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE epic_runs ADD COLUMN config_json TEXT`;
  yield* sql`ALTER TABLE epic_runs ADD COLUMN config_provenance_json TEXT`;
});
