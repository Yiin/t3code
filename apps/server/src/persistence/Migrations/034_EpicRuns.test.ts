import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("034_EpicRuns", (it) => {
  it.effect("creates epic run tables with status, epic and uniqueness indexes", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 33 });

      const tablesBefore = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name IN ('epic_runs', 'epic_run_iterations')
      `;
      assert.deepStrictEqual(
        tablesBefore.map((table) => table.name),
        [],
      );

      yield* runMigrations({ toMigrationInclusive: 34 });

      const tablesAfter = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name IN ('epic_runs', 'epic_run_iterations')
        ORDER BY name ASC
      `;
      assert.deepStrictEqual(
        tablesAfter.map((table) => table.name),
        ["epic_run_iterations", "epic_runs"],
      );

      const runIndexes = yield* sql<{
        readonly seq: number;
        readonly name: string;
        readonly unique: number;
        readonly origin: string;
        readonly partial: number;
      }>`
        PRAGMA index_list(epic_runs)
      `;
      assert.ok(runIndexes.some((index) => index.name === "idx_epic_runs_status"));
      assert.ok(runIndexes.some((index) => index.name === "idx_epic_runs_epic_id"));

      const statusIndexColumns = yield* sql<{
        readonly seqno: number;
        readonly cid: number;
        readonly name: string;
      }>`
        PRAGMA index_info('idx_epic_runs_status')
      `;
      assert.deepStrictEqual(
        statusIndexColumns.map((column) => column.name),
        ["status"],
      );

      const epicIdIndexColumns = yield* sql<{
        readonly seqno: number;
        readonly cid: number;
        readonly name: string;
      }>`
        PRAGMA index_info('idx_epic_runs_epic_id')
      `;
      assert.deepStrictEqual(
        epicIdIndexColumns.map((column) => column.name),
        ["epic_id"],
      );

      const iterationIndexes = yield* sql<{
        readonly seq: number;
        readonly name: string;
        readonly unique: number;
        readonly origin: string;
        readonly partial: number;
      }>`
        PRAGMA index_list(epic_run_iterations)
      `;
      // Exactly one index: the UNIQUE constraint's implicit index. A hand-written
      // index on (run_id, iteration_index) would be pure duplication of it.
      assert.strictEqual(iterationIndexes.length, 1);

      const uniqueIterationIndexes = iterationIndexes.filter((index) => index.unique === 1);

      const uniqueIndexColumns = yield* Effect.forEach(uniqueIterationIndexes, (index) =>
        // PRAGMA arguments cannot be bound parameters, so the index name is
        // interpolated; it comes from PRAGMA index_list, not from user input.
        sql
          .unsafe<{
            readonly seqno: number;
            readonly cid: number;
            readonly name: string;
          }>(`PRAGMA index_info('${index.name}')`)
          .pipe(Effect.map((columns) => columns.map((column) => column.name))),
      );

      assert.ok(
        uniqueIndexColumns.some(
          (columns) =>
            columns.length === 2 && columns[0] === "run_id" && columns[1] === "iteration_index",
        ),
      );
    }),
  );
});
