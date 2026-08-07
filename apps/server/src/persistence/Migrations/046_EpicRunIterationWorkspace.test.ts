import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("046_EpicRunIterationWorkspace", (it) => {
  it.effect("adds nullable worker workspace columns to existing iteration rows", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 45 });
      yield* sql`
        INSERT INTO epic_run_iterations (
          run_id, iteration_index, thread_id, issue_id, turn_status,
          summary, why, failure_reason, started_at, finished_at
        ) VALUES (
          'run-old', 0, 'thread-old', 'child-old', 'completed',
          NULL, NULL, NULL, '2026-08-01T00:00:00.000Z', NULL
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 46 });
      const rows = yield* sql<{
        readonly workerId: string | null;
        readonly branch: string | null;
        readonly worktreePath: string | null;
      }>`
        SELECT worker_id AS "workerId", branch, worktree_path AS "worktreePath"
        FROM epic_run_iterations WHERE run_id = 'run-old'
      `;

      assert.deepStrictEqual(rows, [{ workerId: null, branch: null, worktreePath: null }]);
    }),
  );
});
