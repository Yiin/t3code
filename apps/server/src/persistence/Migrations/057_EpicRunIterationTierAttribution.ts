/**
 * Tier attribution for an epic-run iteration.
 *
 * An iteration row said what happened but never what produced it, so a tier's
 * real failure rate could not be measured. These three columns record the tier
 * whose chain answered the dispatch, plus the account and model that chain
 * resolved to, written once when the row is created.
 *
 * Additive and unbackfilled: NULL is already the truth for every row written
 * before this migration, and no existing query reads these columns.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE epic_run_iterations ADD COLUMN tier_id TEXT`;
  yield* sql`ALTER TABLE epic_run_iterations ADD COLUMN provider_instance_id TEXT`;
  yield* sql`ALTER TABLE epic_run_iterations ADD COLUMN model TEXT`;
});
