import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("047_EpicRunWorkers", (it) => {
  it.effect("defaults existing runs to one worker", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 46 });
      yield* sql`
        INSERT INTO epic_runs (
          run_id, epic_id, project_id, cwd, prompt, model_selection_json,
          runtime_mode, status, max_iterations, iterations_completed,
          current_thread_id, current_turn_started_at, consecutive_failures,
          last_error, created_at, updated_at
        ) VALUES (
          'run-old', 'epic-old', 'project-old', '/repo', 'prompt',
          '{"provider":"codex","model":"gpt-5","instanceId":"codex"}',
          'full-access', 'running', 50, 0, NULL, NULL, 0, NULL,
          '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 47 });
      const rows = yield* sql<{ readonly workers: number }>`
        SELECT workers FROM epic_runs WHERE run_id = 'run-old'
      `;

      assert.deepStrictEqual(rows, [{ workers: 1 }]);
    }),
  );
});
