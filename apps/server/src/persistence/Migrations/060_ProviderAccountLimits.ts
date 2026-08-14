/**
 * Structured per-account limit facts, one row per (instance, kind). A NULL
 * resets_at means the harness gave no reset time and the consumer applies its
 * own TTL; the index on resets_at serves expiry sweeps.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE provider_account_limits (
      provider_instance_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      driver TEXT NOT NULL,
      detected_at TEXT NOT NULL,
      resets_at TEXT,
      resets_at_estimated INTEGER NOT NULL,
      source TEXT NOT NULL,
      detail TEXT,
      PRIMARY KEY (provider_instance_id, kind)
    )
  `;
  yield* sql`
    CREATE INDEX idx_provider_account_limits_resets_at
    ON provider_account_limits(resets_at)
  `;
});
