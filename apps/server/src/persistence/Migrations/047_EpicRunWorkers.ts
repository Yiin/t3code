/** Durable live worker cap for epic runs. */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE epic_runs ADD COLUMN workers INTEGER NOT NULL DEFAULT 1`;
});
