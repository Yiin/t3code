import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("055_OrchestrationEventRetentionIndex", (it) => {
  it.effect("indexes the retention predicate", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 55 });

      const plan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT sequence FROM orchestration_events
        WHERE event_type = 'thread.activity-appended' AND sequence <= 100
        ORDER BY sequence ASC
        LIMIT 10
      `;

      assert.isTrue(
        plan.some((row) => row.detail.includes("idx_orch_events_type_sequence")),
        `expected the retention index in the plan, got: ${plan.map((row) => row.detail).join(" | ")}`,
      );
    }),
  );
});
