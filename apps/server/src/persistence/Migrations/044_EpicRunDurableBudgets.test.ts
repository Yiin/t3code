import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("044_EpicRunDurableBudgets", (it) => {
  it.effect("backfills real provider turns and excludes provable synthetic rows", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 34 });
      yield* sql`
        INSERT INTO epic_runs (
          run_id, epic_id, project_id, cwd, prompt, model_selection_json,
          runtime_mode, status, max_iterations, iterations_completed,
          current_thread_id, current_turn_started_at, consecutive_failures,
          last_error, created_at, updated_at
        ) VALUES (
          'run-034', 'epic-034', 'project-old', '/tmp/old', 'Cook.', '{}',
          'full-access', 'running', 10, 0, NULL, NULL, 0, NULL,
          '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z'
        )
      `;
      // This real provider turn predates issue_id and failure_reason. Both
      // columns migrate to NULL, so NULL issue_id cannot identify a synthetic.
      yield* sql`
        INSERT INTO epic_run_iterations (
          run_id, iteration_index, thread_id, turn_status, summary, started_at, finished_at
        ) VALUES (
          'run-034', 0, 'thread-034', 'completed', 'real old turn',
          '2026-07-01T00:00:00.000Z', '2026-07-01T00:05:00.000Z'
        )
      `;
      yield* runMigrations({ toMigrationInclusive: 43 });
      yield* sql`
        INSERT INTO epic_runs (
          run_id, epic_id, project_id, cwd, prompt, orientation_file,
          model_selection_json, runtime_mode, origin_thread_id, status,
          max_iterations, iterations_completed, current_thread_id,
          current_turn_started_at, consecutive_failures, last_error, created_at, updated_at
        ) VALUES (
          'run-old', 'epic-old', 'project-old', '/tmp/old', 'Cook.', NULL, '{}',
          'full-access', NULL, 'running', 10, 2, NULL, NULL, 0, NULL,
          '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'
        )
      `;
      for (const [iterationIndex, issueId, turnStatus, failureReason] of [
        [0, "child-completed", "completed", null],
        [1, "child-failed", "failed", "child:blocked"],
        [2, "child-abandoned", "abandoned", "server-restart"],
        [3, null, "failed", "infra:ready-unrecognised"],
        [4, null, "failed", "ready-unrecognised"],
      ] as const) {
        yield* sql`
          INSERT INTO epic_run_iterations (
            run_id, iteration_index, thread_id, issue_id, turn_status,
            summary, why, failure_reason, started_at, finished_at
          ) VALUES (
            'run-old', ${iterationIndex}, ${`thread-${iterationIndex}`}, ${issueId},
            ${turnStatus}, NULL, NULL, ${failureReason}, '2026-08-01T00:00:00.000Z',
            '2026-08-01T00:05:00.000Z'
          )
        `;
      }

      yield* runMigrations({ toMigrationInclusive: 44 });

      const runs = yield* sql<{
        readonly iterationsDispatched: number;
        readonly noCommitStreak: number;
        readonly infraStreak: number;
      }>`
        SELECT
          iterations_dispatched AS "iterationsDispatched",
          no_commit_streak AS "noCommitStreak",
          infra_streak AS "infraStreak"
        FROM epic_runs
        WHERE run_id IN ('run-034', 'run-old')
        ORDER BY run_id ASC
      `;
      assert.deepStrictEqual(runs, [
        { iterationsDispatched: 1, noCommitStreak: 0, infraStreak: 0 },
        { iterationsDispatched: 3, noCommitStreak: 0, infraStreak: 0 },
      ]);

      yield* sql`
        INSERT INTO epic_provider_degradations (
          provider_instance_id, failure_reason, degraded_at
        ) VALUES ('claude-work', 'provider-error:spend-limit', '2026-08-01T00:00:00.000Z')
      `;
      const degradations = yield* sql<{ readonly providerInstanceId: string }>`
        SELECT provider_instance_id AS "providerInstanceId"
        FROM epic_provider_degradations
      `;
      assert.deepStrictEqual(degradations, [{ providerInstanceId: "claude-work" }]);
    }),
  );
});
