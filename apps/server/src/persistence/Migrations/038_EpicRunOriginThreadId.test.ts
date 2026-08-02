import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("038_EpicRunOriginThreadId", (it) => {
  it.effect("upgrades 037 rows with a nullable origin_thread_id", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 37 });
      yield* sql`
        INSERT INTO epic_runs (
          run_id, epic_id, project_id, cwd, prompt, model_selection_json, runtime_mode,
          status, max_iterations, iterations_completed, current_thread_id,
          current_turn_started_at, consecutive_failures, last_error, created_at, updated_at
        ) VALUES (
          'run-old', 'epic-old', 'project-old', '/tmp/old', 'Cook the epic.', '{}',
          'full-access', 'done', 10, 3, NULL, NULL, 0, NULL, '2026-07-29', '2026-07-29'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 38 });

      const rows = yield* sql<{ readonly originThreadId: string | null }>`
        SELECT origin_thread_id AS "originThreadId" FROM epic_runs WHERE run_id = 'run-old'
      `;
      assert.deepStrictEqual(rows, [{ originThreadId: null }]);
    }),
  );
});
