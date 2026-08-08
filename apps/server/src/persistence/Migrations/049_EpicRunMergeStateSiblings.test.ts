import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("049_EpicRunMergeStateSiblings", (it) => {
  it.effect("defaults old merge-state rows to an empty sibling set", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 48 });
      yield* sql`
        INSERT INTO epic_run_merge_state (
          run_id, initial_head, last_accepted_head, repository_path, base_branch,
          integration_branch, integration_worktree_path
        ) VALUES ('run-1', 'head-1', 'head-1', '/repo', 'mine', 'integration-1', '/integration')
      `;
      yield* runMigrations({ toMigrationInclusive: 49 });
      const rows = yield* sql<{ readonly siblings: string }>`
        SELECT siblings FROM epic_run_merge_state WHERE run_id = 'run-1'
      `;
      assert.deepStrictEqual(rows, [{ siblings: "[]" }]);
    }),
  );

  it.effect("stores the sibling set as JSON", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 49 });
      yield* sql`
        INSERT INTO epic_run_merge_state (
          run_id, initial_head, last_accepted_head, repository_path, base_branch,
          integration_branch, integration_worktree_path, siblings
        ) VALUES (
          'run-2', 'head-1', 'head-1', '/repo', 'mine', 'integration-2', '/integration',
          '[{"repositoryPath":"/sib","baseBranch":"main","integrationWorktreePath":"/integ-sib","lastAcceptedHead":"sib-0"}]'
        )
      `;
      const rows = yield* sql<{ readonly siblings: string }>`
        SELECT siblings FROM epic_run_merge_state WHERE run_id = 'run-2'
      `;
      assert.deepStrictEqual(rows, [
        {
          siblings:
            '[{"repositoryPath":"/sib","baseBranch":"main","integrationWorktreePath":"/integ-sib","lastAcceptedHead":"sib-0"}]',
        },
      ]);
    }),
  );
});
