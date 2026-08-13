/**
 * Durable gate receipts, and where an iteration's wall time went.
 *
 * A run recorded that a child passed verification but never what was
 * verified: which commits the gate read, how long it waited for the shared
 * heavy-work lock, how long the command itself took, or what it exited with.
 * `epic_run_gate_receipts` is that record, one row per gate run, and it
 * survives a restart because the loop rewrites nothing here.
 *
 * The two iteration columns answer the other half: `phase_timings` separates
 * the provider turn from the runner's own time, and `prompt_bytes` says how
 * much the turn was asked to hold.
 *
 * Additive and unbackfilled: NULL is already the truth for every row written
 * before this migration.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE epic_run_gate_receipts (
      run_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      phase TEXT NOT NULL CHECK (phase IN ('entry', 'control', 'recheck', 'sequential')),
      child_id TEXT,
      branch TEXT,
      command_digest TEXT NOT NULL,
      cwd TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK (outcome IN ('passed', 'failed', 'error')),
      exit_code INTEGER,
      queued_at TEXT NOT NULL,
      acquired_at TEXT,
      finished_at TEXT NOT NULL,
      lock_wait_ms INTEGER NOT NULL,
      execution_ms INTEGER NOT NULL,
      input_heads TEXT NOT NULL,
      output TEXT NOT NULL,
      output_path TEXT,
      PRIMARY KEY (run_id, sequence)
    )
  `;
  // Nothing but exit zero may read as a pass. The check is here as well as in
  // the adapter because a receipt is evidence, and evidence a later bug can
  // quietly contradict is not evidence.
  yield* sql`
    CREATE TRIGGER epic_run_gate_receipts_pass_requires_exit_zero
    BEFORE INSERT ON epic_run_gate_receipts
    FOR EACH ROW WHEN NEW.outcome = 'passed' AND (NEW.exit_code IS NULL OR NEW.exit_code <> 0)
    BEGIN
      SELECT RAISE(ABORT, 'gate receipt claims passed without exit code 0');
    END
  `;
  yield* sql`ALTER TABLE epic_run_iterations ADD COLUMN phase_timings TEXT`;
  yield* sql`ALTER TABLE epic_run_iterations ADD COLUMN prompt_bytes INTEGER`;
});
