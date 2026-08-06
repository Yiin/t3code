import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("043_EpicRunOrientationFile", (it) => {
  it.effect("upgrades 042 rows with a nullable orientation_file", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 42 });
      yield* sql`
        INSERT INTO epic_runs (
          run_id, epic_id, project_id, cwd, prompt, model_selection_json, runtime_mode,
          origin_thread_id, status, max_iterations, iterations_completed, current_thread_id,
          current_turn_started_at, consecutive_failures, last_error, created_at, updated_at
        ) VALUES (
          'run-old', 'epic-old', 'project-old', '/tmp/old', 'Cook the epic.', '{}',
          'full-access', NULL, 'done', 10, 3, NULL, NULL, 0, NULL, '2026-07-29', '2026-07-29'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 43 });

      const rows = yield* sql<{ readonly orientationFile: string | null }>`
        SELECT orientation_file AS "orientationFile" FROM epic_runs WHERE run_id = 'run-old'
      `;
      assert.deepStrictEqual(rows, [{ orientationFile: null }]);
    }),
  );
});
