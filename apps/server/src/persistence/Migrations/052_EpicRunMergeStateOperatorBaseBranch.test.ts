import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("052_EpicRunMergeStateOperatorBaseBranch", (it) => {
  it.effect("defaults old merge-state rows to a null operator base branch", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 51 });
      yield* sql`
        INSERT INTO epic_run_merge_state (
          run_id, initial_head, last_accepted_head, repository_path, base_branch,
          integration_branch, integration_worktree_path
        ) VALUES ('run-1', 'head-1', 'head-1', '/repo', 'mine', 'integration-1', '/integration')
      `;
      yield* runMigrations({ toMigrationInclusive: 52 });
      const rows = yield* sql<{ readonly operator_base_branch: string | null }>`
        SELECT operator_base_branch FROM epic_run_merge_state WHERE run_id = 'run-1'
      `;
      assert.deepStrictEqual(rows, [{ operator_base_branch: null }]);
    }),
  );

  it.effect("stores the operator base branch", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 52 });
      yield* sql`
        INSERT INTO epic_run_merge_state (
          run_id, initial_head, last_accepted_head, repository_path, base_branch,
          integration_branch, integration_worktree_path, operator_base_branch
        ) VALUES (
          'run-2', 'head-1', 'head-1', '/repo', 'epic/epic-1/base', 'integration-2', '/integration',
          'mine'
        )
      `;
      const rows = yield* sql<{ readonly operator_base_branch: string | null }>`
        SELECT operator_base_branch FROM epic_run_merge_state WHERE run_id = 'run-2'
      `;
      assert.deepStrictEqual(rows, [{ operator_base_branch: "mine" }]);
    }),
  );
});
