import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("054_ProjectionThreadMessageOriginDelivery", (it) => {
  it.effect("reads pre-existing rows back as null origin and null delivery state", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 53 });
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text,
          attachments_json, correlation_json, is_streaming, created_at, updated_at
        ) VALUES (
          'message-1', 'thread-1', NULL, 'user', 'hello',
          NULL, NULL, 0, '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 54 });

      const rows = yield* sql<{
        readonly origin: string | null;
        readonly delivery_state: string | null;
      }>`
        SELECT origin, delivery_state FROM projection_thread_messages
        WHERE message_id = 'message-1'
      `;
      assert.deepStrictEqual(rows, [{ origin: null, delivery_state: null }]);
    }),
  );

  it.effect("stores an agent origin and a queued delivery state", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text,
          attachments_json, correlation_json, is_streaming, created_at, updated_at,
          origin, delivery_state
        ) VALUES (
          'message-queued', 'thread-child', NULL, 'user', 'do the thing',
          NULL, NULL, 0, '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z',
          'agent', 'queued'
        )
      `;

      const rows = yield* sql<{
        readonly origin: string | null;
        readonly delivery_state: string | null;
      }>`
        SELECT origin, delivery_state FROM projection_thread_messages
        WHERE message_id = 'message-queued'
      `;
      assert.deepStrictEqual(rows, [{ origin: "agent", delivery_state: "queued" }]);
    }),
  );
});
