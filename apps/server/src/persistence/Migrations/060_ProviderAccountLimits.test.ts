import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("060_ProviderAccountLimits", (it) => {
  it.effect("creates the limits table with one row per instance and kind", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 59 });

      const tablesBefore = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'provider_account_limits'
      `;
      assert.deepStrictEqual(tablesBefore, []);

      yield* runMigrations({ toMigrationInclusive: 60 });

      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'index' AND name = 'idx_provider_account_limits_resets_at'
      `;
      assert.strictEqual(indexes.length, 1);

      yield* sql`
        INSERT INTO provider_account_limits (
          provider_instance_id, kind, driver, detected_at,
          resets_at, resets_at_estimated, source, detail
        ) VALUES (
          'claude-work', 'usage-limit', 'claudeAgent', '2026-08-14T00:00:00.000Z',
          NULL, 0, 'claude.sdk.rate_limit_event', NULL
        )
      `;

      const duplicate = yield* Effect.exit(sql`
        INSERT INTO provider_account_limits (
          provider_instance_id, kind, driver, detected_at,
          resets_at, resets_at_estimated, source, detail
        ) VALUES (
          'claude-work', 'usage-limit', 'claudeAgent', '2026-08-14T00:01:00.000Z',
          NULL, 0, 'claude.sdk.get_usage', NULL
        )
      `);
      assert.isTrue(Exit.isFailure(duplicate));
    }),
  );
});
