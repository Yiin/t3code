import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("057_EpicRunIterationTierAttribution", (it) => {
  it.effect("migrates a pre-057 iteration row to null attribution", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 56 });
      yield* sql`
        INSERT INTO epic_run_iterations (
          run_id, iteration_index, thread_id, issue_id, turn_status,
          summary, why, failure_reason, started_at, finished_at
        ) VALUES (
          'run-old', 0, 'thread-old', 'child-old', 'completed',
          NULL, NULL, NULL, '2026-08-01T00:00:00.000Z', NULL
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 57 });
      const rows = yield* sql<{
        readonly tierId: string | null;
        readonly providerInstanceId: string | null;
        readonly model: string | null;
      }>`
        SELECT
          tier_id AS "tierId",
          provider_instance_id AS "providerInstanceId",
          model
        FROM epic_run_iterations WHERE run_id = 'run-old'
      `;

      assert.deepStrictEqual(rows, [{ tierId: null, providerInstanceId: null, model: null }]);
    }),
  );
});
