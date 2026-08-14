/**
 * A degradation row carries the provider's own reset time when the harness
 * reported one. NULL keeps the flat-TTL liveness rule, which is also what
 * every row written by an older build gets.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE epic_provider_degradations ADD COLUMN resets_at TEXT`;
});
