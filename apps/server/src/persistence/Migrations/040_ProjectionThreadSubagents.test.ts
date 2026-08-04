import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import Migration0040 from "./040_ProjectionThreadSubagents.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("040_ProjectionThreadSubagents", (it) => {
  it.effect("creates the subagent projection table on an existing 039 database", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 39 });

      const tablesBefore = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'projection_thread_subagents'
      `;
      assert.deepStrictEqual(
        tablesBefore.map((table) => table.name),
        [],
      );

      yield* runMigrations({ toMigrationInclusive: 40 });

      const tablesAfter = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'projection_thread_subagents'
      `;
      assert.deepStrictEqual(
        tablesAfter.map((table) => table.name),
        ["projection_thread_subagents"],
      );

      const indexes = yield* sql<{
        readonly seq: number;
        readonly name: string;
        readonly unique: number;
        readonly origin: string;
        readonly partial: number;
      }>`
        PRAGMA index_list(projection_thread_subagents)
      `;
      assert.ok(
        indexes.some((index) => index.name === "idx_projection_thread_subagents_thread_status"),
      );

      const statusIndexColumns = yield* sql<{
        readonly seqno: number;
        readonly cid: number;
        readonly name: string;
      }>`
        PRAGMA index_info('idx_projection_thread_subagents_thread_status')
      `;
      assert.deepStrictEqual(
        statusIndexColumns.map((column) => column.name),
        ["thread_id", "status"],
      );

      const primaryKeyColumns = yield* sql<{
        readonly cid: number;
        readonly name: string;
        readonly pk: number;
      }>`
        PRAGMA table_info(projection_thread_subagents)
      `;
      assert.deepStrictEqual(
        primaryKeyColumns
          .filter((column) => column.pk > 0)
          .toSorted((left, right) => left.pk - right.pk)
          .map((column) => column.name),
        ["thread_id", "subagent_id"],
      );

      // Re-running the migration body must be a no-op (IF NOT EXISTS), and
      // must not clear rows already projected.
      yield* sql`
        INSERT INTO projection_thread_subagents (
          subagent_id, thread_id, turn_id, status, started_at, updated_at
        )
        VALUES ('task-1', 'thread-1', NULL, 'running', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
      `;
      yield* Migration0040;
      const rows = yield* sql<{ readonly subagentId: string }>`
        SELECT subagent_id AS "subagentId" FROM projection_thread_subagents
      `;
      assert.deepStrictEqual(
        rows.map((row) => row.subagentId),
        ["task-1"],
      );
    }),
  );
});
