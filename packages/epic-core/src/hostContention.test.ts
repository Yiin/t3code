import { describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { TestClock } from "effect/testing";
import { HostProcessCpuCount, HostProcessLoadAverage } from "@t3tools/shared/hostProcess";

import {
  awaitQuietHost,
  type AwaitQuietHostOptions,
  hostLoadPerCpu,
  sampleHostLoad,
} from "./hostContention.ts";

/** Samples the readings in order and holds the last one. */
const withLoad = <A, E, R>(readings: ReadonlyArray<number>, effect: Effect.Effect<A, E, R>) => {
  let index = 0;
  return effect.pipe(
    Effect.provideService(HostProcessLoadAverage, () => {
      const reading = readings[Math.min(index, readings.length - 1)] ?? 0;
      index += 1;
      return reading;
    }),
    Effect.provideService(HostProcessCpuCount, 16),
  );
};

const wait = (readings: ReadonlyArray<number>, options: AwaitQuietHostOptions) =>
  withLoad(readings, awaitQuietHost(options));

describe("hostContention", () => {
  it("reports load per core and guards a zero core count", () => {
    expect(hostLoadPerCpu(29.92, 16)).toBe(1.87);
    expect(hostLoadPerCpu(4, 0)).toBe(4);
  });

  it.effect("samples the current load", () =>
    Effect.gen(function* () {
      expect(yield* withLoad([8], sampleHostLoad)).toEqual({
        loadAverage1m: 8,
        cpuCount: 16,
        loadPerCpu: 0.5,
      });
    }),
  );

  it.effect("runs immediately on a quiet host", () =>
    Effect.gen(function* () {
      const result = yield* wait([8], { pollSeconds: 30, maxWaitSeconds: 600 });

      expect(result.quiet).toBe(true);
      expect(result.waitedMs).toBe(0);
      expect(result.load.loadPerCpu).toBe(0.5);
    }),
  );

  it.effect("waits for foreign load to clear, then reports a quiet host", () =>
    Effect.gen(function* () {
      // The incident reading: 29.92 on 16 cores while other projects ran tests.
      const fiber = yield* wait([29.92, 29.92, 8], { pollSeconds: 30, maxWaitSeconds: 600 }).pipe(
        Effect.forkChild,
      );
      yield* TestClock.adjust(Duration.seconds(60));
      const result = yield* Fiber.join(fiber);

      expect(result.quiet).toBe(true);
      expect(result.waitedMs).toBe(60_000);
      expect(result.load.loadPerCpu).toBe(0.5);
    }),
  );

  /** A machine that never goes quiet must still get its gate, not lose the run. */
  it.effect("gives up at the bound and reports the host as contended", () =>
    Effect.gen(function* () {
      const fiber = yield* wait([29.92], { pollSeconds: 30, maxWaitSeconds: 60 }).pipe(
        Effect.forkChild,
      );
      yield* TestClock.adjust(Duration.seconds(60));
      const result = yield* Fiber.join(fiber);

      expect(result.quiet).toBe(false);
      expect(result.waitedMs).toBe(60_000);
      expect(result.load.loadPerCpu).toBe(1.87);
    }),
  );

  it.effect("never sleeps past the bound on the last poll", () =>
    Effect.gen(function* () {
      const fiber = yield* wait([29.92], { pollSeconds: 30, maxWaitSeconds: 45 }).pipe(
        Effect.forkChild,
      );
      yield* TestClock.adjust(Duration.seconds(45));
      const result = yield* Fiber.join(fiber);

      expect(result.waitedMs).toBe(45_000);
    }),
  );

  /**
   * The other cases drive a fake sampler on a test clock. This one proves the
   * real defaults work: `os.loadavg()` and `os.availableParallelism()` report,
   * and the bound really releases the wait in wall-clock time.
   */
  it.live("reads the real host and releases the wait at the bound", () =>
    Effect.gen(function* () {
      const result = yield* awaitQuietHost({
        thresholdPerCpu: 0,
        pollSeconds: 1,
        maxWaitSeconds: 2,
      });

      expect(result.quiet).toBe(false);
      expect(result.waitedMs).toBeGreaterThanOrEqual(2_000);
      expect(result.load.cpuCount).toBeGreaterThanOrEqual(1);
      expect(result.load.loadAverage1m).toBeGreaterThanOrEqual(0);
    }),
  );

  it.effect("a zero bound disables the wait and still reports the load", () =>
    Effect.gen(function* () {
      const result = yield* wait([29.92], { maxWaitSeconds: 0 });

      expect(result.quiet).toBe(false);
      expect(result.waitedMs).toBe(0);
      expect(result.load.loadAverage1m).toBe(29.92);
    }),
  );
});
