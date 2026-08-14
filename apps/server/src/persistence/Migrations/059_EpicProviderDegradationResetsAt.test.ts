import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("059_EpicProviderDegradationResetsAt", (it) => {
  it.effect("adds a nullable resets_at that pre-existing rows read back as NULL", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 58 });
      yield* sql`
        INSERT INTO epic_provider_degradations (
          provider_instance_id, failure_reason, degraded_at
        ) VALUES ('claude-work', 'provider-error:spend-limit', '2026-08-01T00:00:00.000Z')
      `;

      yield* runMigrations({ toMigrationInclusive: 59 });

      yield* sql`
        INSERT INTO epic_provider_degradations (
          provider_instance_id, failure_reason, degraded_at, resets_at
        ) VALUES (
          'codex-personal', 'provider-error:rate-limit',
          '2026-08-01T01:00:00.000Z', '2026-08-01T05:00:00.000Z'
        )
      `;
      const rows = yield* sql<{
        readonly providerInstanceId: string;
        readonly resetsAt: string | null;
      }>`
        SELECT provider_instance_id AS "providerInstanceId", resets_at AS "resetsAt"
        FROM epic_provider_degradations
        ORDER BY provider_instance_id ASC
      `;
      assert.deepStrictEqual(rows, [
        { providerInstanceId: "claude-work", resetsAt: null },
        { providerInstanceId: "codex-personal", resetsAt: "2026-08-01T05:00:00.000Z" },
      ]);
    }),
  );
});
