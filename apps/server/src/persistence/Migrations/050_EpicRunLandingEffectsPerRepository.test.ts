import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("050_EpicRunLandingEffectsPerRepository", (it) => {
  it.effect("preserves existing rows across the primary-key rebuild", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 49 });
      yield* sql`
        INSERT INTO epic_run_landing_effects (
          run_id, repository_path, base_head, head, commit_count, parked_count
        ) VALUES ('run-1', '/repo', 'head-1', 'head-3', 4, 1)
      `;
      yield* runMigrations({ toMigrationInclusive: 50 });
      const rows = yield* sql<{
        readonly baseHead: string;
        readonly head: string;
        readonly commitCount: number;
      }>`
        SELECT base_head AS "baseHead", head, commit_count AS "commitCount"
        FROM epic_run_landing_effects WHERE run_id = 'run-1'
      `;
      assert.deepStrictEqual(rows, [{ baseHead: "head-1", head: "head-3", commitCount: 4 }]);
    }),
  );

  it.effect("stores one row per landed repository of a run", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 50 });
      yield* sql`
        INSERT INTO epic_run_landing_effects (
          run_id, repository_path, base_head, head, commit_count, parked_count
        ) VALUES
          ('run-2', '/repo', 'head-1', 'head-3', 4, 1),
          ('run-2', '/sib', 'sib-0', 'sib-2', 2, 1)
      `;
      const rows = yield* sql<{ readonly repositoryPath: string }>`
        SELECT repository_path AS "repositoryPath"
        FROM epic_run_landing_effects WHERE run_id = 'run-2'
        ORDER BY repository_path ASC
      `;
      assert.deepStrictEqual(rows, [{ repositoryPath: "/repo" }, { repositoryPath: "/sib" }]);
    }),
  );
});
