import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("048_EpicRunMergeQueue", (it) => {
  it.effect("adds durable state and ordered queue tables", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 48 });
      yield* sql`
        INSERT INTO epic_run_merge_state (
          run_id, initial_head, last_accepted_head, repository_path, base_branch,
          integration_branch, integration_worktree_path
        ) VALUES ('run-1', 'head-1', 'head-1', '/repo', 'mine', 'integration-1', '/integration')
      `;
      yield* sql`
        INSERT INTO epic_run_merge_entries (
          run_id, sequence, child_id, branch, status, reason, fix_issue_id
        ) VALUES
          ('run-1', 1, 'child-b', 'epic/child-b', 'queued', NULL, NULL),
          ('run-1', 0, 'child-a', 'epic/child-a', 'parked', 'conflict', 'fix-a')
      `;
      const rows = yield* sql<{ readonly child: string; readonly status: string }>`
        SELECT child_id AS child, status
        FROM epic_run_merge_entries WHERE run_id = 'run-1' ORDER BY sequence
      `;
      assert.deepStrictEqual(rows, [
        { child: "child-a", status: "parked" },
        { child: "child-b", status: "queued" },
      ]);
      yield* sql`
        INSERT INTO epic_run_landing_effects (
          run_id, repository_path, base_head, head, commit_count, parked_count
        ) VALUES ('run-1', '/repo', 'head-1', 'head-3', 4, 1)
      `;
      const effects = yield* sql<{
        readonly baseHead: string;
        readonly head: string;
        readonly commitCount: number;
      }>`
        SELECT base_head AS "baseHead", head, commit_count AS "commitCount"
        FROM epic_run_landing_effects WHERE run_id = 'run-1'
      `;
      assert.deepStrictEqual(effects, [{ baseHead: "head-1", head: "head-3", commitCount: 4 }]);
    }),
  );
});
