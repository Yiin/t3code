/** Durable serialized merge queue and coordinator-owned integration worktree coordinates. */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE epic_run_merge_state (
      run_id TEXT PRIMARY KEY,
      initial_head TEXT NOT NULL,
      last_accepted_head TEXT NOT NULL,
      parked_count INTEGER NOT NULL DEFAULT 0,
      repository_path TEXT NOT NULL,
      base_branch TEXT NOT NULL,
      integration_branch TEXT NOT NULL,
      integration_worktree_path TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE epic_run_landing_effects (
      run_id TEXT PRIMARY KEY,
      repository_path TEXT NOT NULL,
      base_head TEXT NOT NULL,
      head TEXT NOT NULL,
      commit_count INTEGER NOT NULL,
      parked_count INTEGER NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE epic_run_merge_entries (
      run_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      child_id TEXT NOT NULL,
      branch TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('queued', 'draining', 'parked')),
      reason TEXT CHECK (reason IS NULL OR reason IN ('conflict', 'gate-failed')),
      fix_issue_id TEXT,
      PRIMARY KEY (run_id, sequence)
    )
  `;
  yield* sql`
    CREATE INDEX idx_epic_run_merge_entries_active
    ON epic_run_merge_entries(run_id, status, sequence)
  `;
  yield* sql`
    CREATE INDEX idx_epic_run_merge_entries_parked
    ON epic_run_merge_entries(run_id, branch, status)
  `;
  yield* sql`
    CREATE UNIQUE INDEX idx_epic_run_merge_entries_one_active_branch
    ON epic_run_merge_entries(run_id, branch)
    WHERE status IN ('queued', 'draining')
  `;
});
