import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationRetention } from "../Services/OrchestrationRetention.ts";
import { OrchestrationRetentionLive } from "./OrchestrationRetention.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  OrchestrationRetentionLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

/**
 * `it.layer` builds one in-memory database for the whole file, so each test
 * starts by clearing the two tables the sweep reads.
 */
const resetTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM orchestration_events`;
  yield* sql`DELETE FROM projection_state`;
});

const insertEvent = (options: {
  readonly sequence: number;
  readonly streamId: string;
  readonly streamVersion: number;
  readonly eventType: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO orchestration_events (
        sequence, event_id, aggregate_kind, stream_id, stream_version, event_type,
        occurred_at, command_id, causation_event_id, correlation_id, actor_kind,
        payload_json, metadata_json
      ) VALUES (
        ${options.sequence}, ${`event-${options.sequence}`}, 'thread', ${options.streamId},
        ${options.streamVersion}, ${options.eventType},
        '2026-08-01T00:00:00.000Z', NULL, NULL, NULL, 'server',
        '{}', '{}'
      )
    `;
  });

const setWatermark = (projector: string, sequence: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
      VALUES (${projector}, ${sequence}, '2026-08-01T00:00:00.000Z')
    `;
  });

const remainingSequences = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly sequence: number }>`
    SELECT sequence FROM orchestration_events ORDER BY sequence ASC
  `;
  return rows.map((row) => row.sequence);
});

layer("OrchestrationRetention", (it) => {
  it.effect("deletes activity events below the watermark minus the margin", () =>
    Effect.gen(function* () {
      yield* resetTables;
      for (let sequence = 1; sequence <= 10; sequence += 1) {
        yield* insertEvent({
          sequence,
          streamId: "thread-1",
          streamVersion: sequence,
          eventType: "thread.activity-appended",
        });
      }
      yield* setWatermark("projection.thread-activities", 10);

      const retention = yield* OrchestrationRetention;
      const report = yield* retention.sweep({ retainSequenceMargin: 4 });

      assert.strictEqual(report.watermarkSequence, 10);
      assert.strictEqual(report.deletableThroughSequence, 6);
      assert.strictEqual(report.deletedEvents, 6);
      assert.deepStrictEqual(yield* remainingSequences, [7, 8, 9, 10]);
    }),
  );

  it.effect("keeps every event type other than thread.activity-appended", () =>
    Effect.gen(function* () {
      yield* resetTables;
      yield* insertEvent({
        sequence: 1,
        streamId: "thread-1",
        streamVersion: 0,
        eventType: "thread.created",
      });
      yield* insertEvent({
        sequence: 2,
        streamId: "thread-1",
        streamVersion: 1,
        eventType: "thread.activity-appended",
      });
      yield* insertEvent({
        sequence: 3,
        streamId: "thread-1",
        streamVersion: 2,
        eventType: "thread.message-sent",
      });
      yield* setWatermark("projection.threads", 100);

      const retention = yield* OrchestrationRetention;
      const report = yield* retention.sweep({ retainSequenceMargin: 0 });

      assert.strictEqual(report.deletedEvents, 1);
      assert.deepStrictEqual(yield* remainingSequences, [1, 3]);
    }),
  );

  it.effect("protects events the slowest projector has not applied yet", () =>
    Effect.gen(function* () {
      yield* resetTables;
      for (let sequence = 1; sequence <= 10; sequence += 1) {
        yield* insertEvent({
          sequence,
          streamId: "thread-1",
          streamVersion: sequence,
          eventType: "thread.activity-appended",
        });
      }
      yield* setWatermark("projection.thread-activities", 10);
      yield* setWatermark("projection.threads", 3);

      const retention = yield* OrchestrationRetention;
      const report = yield* retention.sweep({ retainSequenceMargin: 0 });

      assert.strictEqual(report.watermarkSequence, 3);
      assert.strictEqual(report.deletedEvents, 3);
      assert.deepStrictEqual(yield* remainingSequences, [4, 5, 6, 7, 8, 9, 10]);
    }),
  );

  it.effect("deletes nothing when no projector has registered", () =>
    Effect.gen(function* () {
      yield* resetTables;
      yield* insertEvent({
        sequence: 1,
        streamId: "thread-1",
        streamVersion: 0,
        eventType: "thread.activity-appended",
      });

      const retention = yield* OrchestrationRetention;
      const report = yield* retention.sweep({ retainSequenceMargin: 0 });

      assert.strictEqual(report.deletedEvents, 0);
      assert.strictEqual(report.vacuumed, false);
      assert.deepStrictEqual(yield* remainingSequences, [1]);
    }),
  );

  it.effect("deletes nothing when the margin covers the whole watermark", () =>
    Effect.gen(function* () {
      yield* resetTables;
      yield* insertEvent({
        sequence: 1,
        streamId: "thread-1",
        streamVersion: 0,
        eventType: "thread.activity-appended",
      });
      yield* setWatermark("projection.thread-activities", 1);

      const retention = yield* OrchestrationRetention;
      const report = yield* retention.sweep({ retainSequenceMargin: 50_000 });

      assert.strictEqual(report.deletedEvents, 0);
      assert.deepStrictEqual(yield* remainingSequences, [1]);
    }),
  );

  it.effect("walks past one batch and reclaims free pages once they pass the threshold", () =>
    Effect.gen(function* () {
      yield* resetTables;
      const sql = yield* SqlClient.SqlClient;
      // 6_000 rows clears `DELETE_BATCH_SIZE`, so the cursor has to advance
      // through a second batch to finish the sweep.
      const total = 6_000;
      yield* sql.withTransaction(
        Effect.forEach(
          Array.from({ length: total }, (_unused, index) => index + 1),
          (sequence) =>
            insertEvent({
              sequence,
              streamId: "thread-1",
              streamVersion: sequence,
              eventType: "thread.activity-appended",
            }),
          { discard: true },
        ),
      );
      yield* setWatermark("projection.thread-activities", total);

      const retention = yield* OrchestrationRetention;
      const report = yield* retention.sweep({
        retainSequenceMargin: 0,
        vacuumThresholdBytes: 0,
      });

      assert.strictEqual(report.deletedEvents, total);
      assert.strictEqual(report.vacuumed, true);
      assert.deepStrictEqual(yield* remainingSequences, []);
    }),
  );
});
