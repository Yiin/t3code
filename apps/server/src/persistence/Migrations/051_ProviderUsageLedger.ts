/** Latest per-account provider usage window samples. */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE provider_usage_windows (
      provider_instance_id TEXT NOT NULL,
      window_id TEXT NOT NULL,
      utilization REAL NOT NULL,
      resets_at TEXT,
      source TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      PRIMARY KEY (provider_instance_id, window_id)
    )
  `;
  yield* sql`
    CREATE INDEX idx_provider_usage_windows_observed_at
    ON provider_usage_windows(observed_at)
  `;
});
