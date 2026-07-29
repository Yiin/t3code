import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("037_ProjectionThreadMessageCorrelation", (it) => {
  it.effect("adds a nullable correlation column without changing legacy rows", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 36 });
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at
        ) VALUES ('legacy-message', 'legacy-thread', NULL, 'assistant', 'legacy', 0, '2026-07-29', '2026-07-29')
      `;
      yield* runMigrations({ toMigrationInclusive: 37 });
      const rows = yield* sql<{ readonly correlation: string | null }>`
        SELECT correlation_json AS correlation
        FROM projection_thread_messages
        WHERE message_id = 'legacy-message'
      `;
      assert.deepStrictEqual(rows, [{ correlation: null }]);
    }),
  );
});
