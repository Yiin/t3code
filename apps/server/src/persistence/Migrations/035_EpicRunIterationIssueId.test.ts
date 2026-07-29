import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("035_EpicRunIterationIssueId", (it) => {
  it.effect("upgrades 034 rows with a nullable issue id", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 34 });
      yield* sql`
        INSERT INTO epic_run_iterations (
          run_id, iteration_index, thread_id, turn_status, summary, started_at, finished_at
        ) VALUES ('run-old', 0, 'thread-old', 'completed', NULL, '2026-07-29', NULL)
      `;

      yield* runMigrations({ toMigrationInclusive: 35 });

      const rows = yield* sql<{ readonly issueId: string | null }>`
        SELECT issue_id AS "issueId" FROM epic_run_iterations WHERE run_id = 'run-old'
      `;
      assert.deepStrictEqual(rows, [{ issueId: null }]);
    }),
  );
});
