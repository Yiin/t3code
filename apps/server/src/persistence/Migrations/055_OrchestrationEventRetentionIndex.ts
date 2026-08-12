/**
 * Index that makes the orchestration event retention sweep cheap.
 *
 * Retention deletes `thread.activity-appended` rows below the slowest
 * projector's watermark. Without an index on `(event_type, sequence)` that
 * predicate is a full scan of a table whose payload column holds most of the
 * database, so every sweep would read a gigabyte to find its delete set.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_orch_events_type_sequence
    ON orchestration_events(event_type, sequence)
  `;
});
