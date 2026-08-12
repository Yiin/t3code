import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  DEFAULT_ORCHESTRATION_RETENTION_POLICY,
  OrchestrationRetention,
  PRUNABLE_EVENT_TYPE,
  type OrchestrationRetentionReport,
  type OrchestrationRetentionShape,
} from "../Services/OrchestrationRetention.ts";

/**
 * Rows deleted per statement.
 *
 * One `DELETE` holds SQLite's single write lock for its whole duration, and
 * the payloads here average a few kilobytes, so an unbatched sweep would block
 * every other writer for as long as it takes to rewrite hundreds of megabytes.
 * Batching releases the lock between statements.
 */
const DELETE_BATCH_SIZE = 5_000;

/** SQLite's `auto_vacuum` value for incremental mode. */
const AUTO_VACUUM_INCREMENTAL = 2;

const makeOrchestrationRetention = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const sqlError = (operation: string) => toPersistenceSqlError(operation);

  const readDatabaseBytes = Effect.gen(function* () {
    const pageCountRows = yield* sql<{ readonly page_count: number }>`PRAGMA page_count`;
    const pageSizeRows = yield* sql<{ readonly page_size: number }>`PRAGMA page_size`;
    return (pageCountRows[0]?.page_count ?? 0) * (pageSizeRows[0]?.page_size ?? 0);
  }).pipe(Effect.mapError(sqlError("OrchestrationRetention.sweep:readDatabaseBytes")));

  const readFreeBytes = Effect.gen(function* () {
    const freelistRows = yield* sql<{ readonly freelist_count: number }>`PRAGMA freelist_count`;
    const pageSizeRows = yield* sql<{ readonly page_size: number }>`PRAGMA page_size`;
    return (freelistRows[0]?.freelist_count ?? 0) * (pageSizeRows[0]?.page_size ?? 0);
  }).pipe(Effect.mapError(sqlError("OrchestrationRetention.sweep:readFreeBytes")));

  /**
   * Lowest `last_applied_sequence` across every projector, or `null` when no
   * projector has registered yet.
   *
   * `null` and 0 mean different things. No projector rows at all means nothing
   * has consumed the log, and then the log is still the only copy of every
   * activity — a sweep must delete nothing.
   */
  const readWatermark = sql<{
    readonly watermark: number | null;
    readonly projectors: number;
  }>`
    SELECT MIN(last_applied_sequence) AS watermark, COUNT(*) AS projectors
    FROM projection_state
  `.pipe(
    Effect.map((rows) => {
      const row = rows[0];
      if (row === undefined || row.projectors === 0 || row.watermark === null) {
        return null;
      }
      return row.watermark;
    }),
    Effect.mapError(sqlError("OrchestrationRetention.sweep:readWatermark")),
  );

  /**
   * Delete prunable events through `throughSequence`, one batch at a time.
   *
   * The cursor walks forward instead of re-counting what is left, so the whole
   * sweep touches each index entry once.
   *
   * Deleting every row of a stream would let the next append to that stream
   * reuse `stream_version` 0. That is harmless: nothing reads `stream_version`
   * except the append that computes the next one, and the unique index it
   * guards has no surviving row to collide with. In practice it cannot happen
   * anyway, because a thread stream always keeps its non-prunable
   * `thread.created` row.
   */
  const deleteThrough = (throughSequence: number) =>
    Effect.gen(function* () {
      let cursor = 0;
      let deleted = 0;
      for (;;) {
        const batch = yield* sql<{ readonly sequence: number }>`
          SELECT sequence
          FROM orchestration_events
          WHERE event_type = ${PRUNABLE_EVENT_TYPE}
            AND sequence > ${cursor}
            AND sequence <= ${throughSequence}
          ORDER BY sequence ASC
          LIMIT ${DELETE_BATCH_SIZE}
        `;
        if (batch.length === 0) {
          return deleted;
        }
        const batchThrough = batch[batch.length - 1]!.sequence;
        yield* sql`
          DELETE FROM orchestration_events
          WHERE event_type = ${PRUNABLE_EVENT_TYPE}
            AND sequence > ${cursor}
            AND sequence <= ${batchThrough}
        `;
        cursor = batchThrough;
        deleted += batch.length;
        if (batch.length < DELETE_BATCH_SIZE) {
          return deleted;
        }
      }
    }).pipe(Effect.mapError(sqlError("OrchestrationRetention.sweep:deleteEvents")));

  /**
   * Reclaim the free pages a sweep left behind.
   *
   * A database still in `auto_vacuum = NONE` needs one full `VACUUM`, which
   * rewrites the file under an exclusive lock. On a two-gigabyte database that
   * measured 28 seconds, and every other writer waits it out — so the pragma
   * goes first, and that one rewrite converts the file to incremental mode.
   * Every sweep after it truncates with `incremental_vacuum`, which touches
   * only the free pages and takes no exclusive lock.
   */
  const reclaimFreePages = Effect.gen(function* () {
    const modeRows = yield* sql<{ readonly auto_vacuum: number }>`PRAGMA auto_vacuum`;
    if (modeRows[0]?.auto_vacuum === AUTO_VACUUM_INCREMENTAL) {
      yield* sql`PRAGMA incremental_vacuum`;
      return;
    }
    yield* Effect.logInfo(
      "orchestration retention is converting the database to incremental vacuum; writes pause until it finishes",
    );
    yield* sql.unsafe(`PRAGMA auto_vacuum = ${AUTO_VACUUM_INCREMENTAL};`);
    yield* sql`VACUUM`;
  }).pipe(Effect.mapError(sqlError("OrchestrationRetention.sweep:reclaimFreePages")));

  const sweep: OrchestrationRetentionShape["sweep"] = (policyOverrides) =>
    Effect.gen(function* () {
      const policy = { ...DEFAULT_ORCHESTRATION_RETENTION_POLICY, ...policyOverrides };
      const sizeBeforeBytes = yield* readDatabaseBytes;
      const watermark = yield* readWatermark;
      const emptyReport: OrchestrationRetentionReport = {
        watermarkSequence: watermark ?? 0,
        deletableThroughSequence: 0,
        deletedEvents: 0,
        sizeBeforeBytes,
        sizeAfterBytes: sizeBeforeBytes,
        vacuumed: false,
      };
      if (watermark === null) {
        return emptyReport;
      }

      const deletableThroughSequence = watermark - policy.retainSequenceMargin;
      if (deletableThroughSequence <= 0) {
        return { ...emptyReport, watermarkSequence: watermark };
      }

      const deletedEvents = yield* deleteThrough(deletableThroughSequence);
      const freeBytes = yield* readFreeBytes;
      const vacuumed = deletedEvents > 0 && freeBytes >= policy.vacuumThresholdBytes;
      if (vacuumed) {
        yield* reclaimFreePages;
      }
      const sizeAfterBytes = yield* readDatabaseBytes;

      return {
        watermarkSequence: watermark,
        deletableThroughSequence,
        deletedEvents,
        sizeBeforeBytes,
        sizeAfterBytes,
        vacuumed,
      };
    });

  return { sweep } satisfies OrchestrationRetentionShape;
});

export const OrchestrationRetentionLive = Layer.effect(
  OrchestrationRetention,
  makeOrchestrationRetention,
);
