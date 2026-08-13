import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

/** The layer shares one in-memory database, so every insert needs its own key. */
const insertReceipt = (input: {
  readonly sequence: number;
  readonly outcome: string;
  readonly exitCode: number | null;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
    INSERT INTO epic_run_gate_receipts (
      run_id, sequence, phase, child_id, branch, command_digest, cwd,
      outcome, exit_code, queued_at, acquired_at, finished_at,
      lock_wait_ms, execution_ms, input_heads, output, output_path
    ) VALUES (
      'run-1', ${input.sequence}, 'entry', 'child-1', 'epic/child-1', 'digest', '/integration',
      ${input.outcome}, ${input.exitCode}, '2026-08-13T00:00:00.000Z',
      '2026-08-13T00:00:02.000Z', '2026-08-13T00:00:07.000Z',
      2000, 5000, '[]', 'output', NULL
    )
  `;
  });

layer("058_EpicRunGateReceipts", (it) => {
  it.effect("migrates a pre-058 iteration row to null timings", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 57 });
      yield* sql`
        INSERT INTO epic_run_iterations (
          run_id, iteration_index, thread_id, issue_id, turn_status,
          summary, why, failure_reason, started_at, finished_at
        ) VALUES (
          'run-old', 0, 'thread-old', 'child-old', 'completed',
          NULL, NULL, NULL, '2026-08-01T00:00:00.000Z', NULL
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 58 });
      const rows = yield* sql<{
        readonly phaseTimings: string | null;
        readonly promptBytes: number | null;
      }>`
        SELECT phase_timings AS "phaseTimings", prompt_bytes AS "promptBytes"
        FROM epic_run_iterations WHERE run_id = 'run-old'
      `;

      assert.deepStrictEqual(rows, [{ phaseTimings: null, promptBytes: null }]);
    }),
  );

  it.effect("keeps a recorded receipt readable", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 58 });
      yield* insertReceipt({ sequence: 0, outcome: "passed", exitCode: 0 });

      const rows = yield* sql<{ readonly outcome: string; readonly lockWaitMs: number }>`
        SELECT outcome, lock_wait_ms AS "lockWaitMs" FROM epic_run_gate_receipts
      `;

      assert.deepStrictEqual(rows, [{ outcome: "passed", lockWaitMs: 2000 }]);
    }),
  );

  /**
   * The claim the whole receipt exists to support. A pass that never saw exit
   * zero is worse than no record at all, so the table refuses to hold one.
   */
  it.effect("refuses a receipt that claims a pass without exit code zero", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 58 });

      const failed = yield* Effect.result(
        insertReceipt({ sequence: 1, outcome: "passed", exitCode: 1 }),
      );
      assert.strictEqual(failed._tag, "Failure");

      const absent = yield* Effect.result(
        insertReceipt({ sequence: 2, outcome: "passed", exitCode: null }),
      );
      assert.strictEqual(absent._tag, "Failure");

      // A failed or errored receipt is free to carry any exit code, or none.
      const allowed = yield* Effect.result(
        insertReceipt({ sequence: 3, outcome: "error", exitCode: null }),
      );
      assert.strictEqual(allowed._tag, "Success");
    }),
  );
});
