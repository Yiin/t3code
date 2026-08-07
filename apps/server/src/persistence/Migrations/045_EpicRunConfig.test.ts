import { DEFAULT_EPIC_RUN_CONFIG, DEFAULT_EPIC_RUN_CONFIG_PROVENANCE } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { EpicRunStoreLive } from "../Layers/EpicRuns.ts";
import { EpicRunStore } from "../Services/EpicRuns.ts";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("045_EpicRunConfig", (it) => {
  it.effect("reads a pre-045 row through the real store with default config", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 44 });
      yield* sql`
        INSERT INTO epic_runs (
          run_id, epic_id, project_id, cwd, prompt, orientation_file,
          model_selection_json, runtime_mode, origin_thread_id, status,
          max_iterations, iterations_completed, iterations_dispatched,
          current_thread_id, current_turn_started_at, consecutive_failures,
          no_commit_streak, infra_streak, last_error, created_at, updated_at
        ) VALUES (
          'run-old', 'epic-old', 'project-old', '/tmp/old', 'Cook.', NULL,
          '{"instanceId":"codex","model":"gpt-5"}', 'full-access', NULL, 'done',
          10, 2, 2, NULL, NULL, 0, 0, 0, NULL,
          '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'
        )
      `;
      yield* runMigrations({ toMigrationInclusive: 45 });

      const stored = yield* Effect.gen(function* () {
        const store = yield* EpicRunStore;
        return yield* store.getRun({ runId: "run-old" as never });
      }).pipe(Effect.provide(EpicRunStoreLive));
      const run = Option.getOrThrow(stored);
      assert.deepStrictEqual(run.config, DEFAULT_EPIC_RUN_CONFIG);
      assert.deepStrictEqual(run.configProvenance, DEFAULT_EPIC_RUN_CONFIG_PROVENANCE);
      assert.isTrue(Object.values(run.configProvenance).every((source) => source === "default"));
    }),
  );
});
