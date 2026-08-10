import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("051_ProviderUsageLedger", (it) => {
  it.effect("creates the ledger with one row per instance and window", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 50 });

      const tablesBefore = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'provider_usage_windows'
      `;
      assert.deepStrictEqual(tablesBefore, []);

      yield* runMigrations({ toMigrationInclusive: 51 });
      yield* sql`
        INSERT INTO provider_usage_windows (
          provider_instance_id, window_id, utilization, resets_at, source, observed_at
        ) VALUES (
          'claude-work', 'five_hour', 0.5, NULL,
          'claude.sdk.get_usage', '2026-08-10T00:00:00.000Z'
        )
      `;

      const duplicate = yield* Effect.exit(sql`
        INSERT INTO provider_usage_windows (
          provider_instance_id, window_id, utilization, resets_at, source, observed_at
        ) VALUES (
          'claude-work', 'five_hour', 0.8, NULL,
          'claude.sdk.rate_limit_event', '2026-08-10T00:01:00.000Z'
        )
      `);
      assert.isTrue(Exit.isFailure(duplicate));

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(provider_usage_windows)
      `;
      assert.isTrue(columns.some((column) => column.name === "window_id"));
      assert.isFalse(columns.some((column) => column.name === "window"));
    }),
  );
});
