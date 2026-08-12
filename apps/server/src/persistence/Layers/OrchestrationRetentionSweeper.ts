import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";

import { OrchestrationRetention } from "../Services/OrchestrationRetention.ts";

/**
 * How long the first sweep waits after boot.
 *
 * Boot already reads the command read model and bootstraps ten projectors. A
 * sweep on top of that competes for the one SQLite write lock at the exact
 * moment the server is trying to become responsive, and the database has
 * survived this long without one, so a few minutes cost nothing.
 */
const FIRST_SWEEP_DELAY = Duration.minutes(5);

/** How often a sweep runs after the first one. */
const SWEEP_INTERVAL = Duration.hours(6);

const makeOrchestrationRetentionSweeper = Effect.gen(function* () {
  const retention = yield* OrchestrationRetention;

  const sweepAndLog = retention.sweep().pipe(
    Effect.flatMap((report) =>
      report.deletedEvents === 0
        ? Effect.logDebug("orchestration retention swept nothing").pipe(
            Effect.annotateLogs({
              watermarkSequence: report.watermarkSequence,
              sizeBytes: report.sizeAfterBytes,
            }),
          )
        : Effect.logInfo("orchestration retention swept the event store").pipe(
            Effect.annotateLogs({
              deletedEvents: report.deletedEvents,
              deletableThroughSequence: report.deletableThroughSequence,
              watermarkSequence: report.watermarkSequence,
              sizeBeforeBytes: report.sizeBeforeBytes,
              sizeAfterBytes: report.sizeAfterBytes,
              vacuumed: report.vacuumed,
            }),
          ),
    ),
    Effect.catch((error) =>
      Effect.logWarning("orchestration retention sweep failed; keeping every event", { error }),
    ),
  );

  // The delay is a one-off before the first sweep, not part of the repeat, so
  // the interval between sweeps stays exactly `SWEEP_INTERVAL`.
  yield* Effect.forkScoped(
    Effect.gen(function* () {
      yield* Effect.sleep(FIRST_SWEEP_DELAY);
      yield* sweepAndLog.pipe(Effect.repeat(Schedule.spaced(SWEEP_INTERVAL)));
    }),
  );
});

export const OrchestrationRetentionSweeperLive = Layer.effectDiscard(
  makeOrchestrationRetentionSweeper,
);
