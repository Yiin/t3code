import { assert, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import { PersistenceSqlError } from "../Errors.ts";
import {
  OrchestrationRetention,
  type OrchestrationRetentionPolicy,
} from "../Services/OrchestrationRetention.ts";
import { OrchestrationRetentionSweeperLive } from "./OrchestrationRetentionSweeper.ts";

const stubRetention = (
  onSweep: (policy: Partial<OrchestrationRetentionPolicy> | undefined) => void,
) =>
  Layer.succeed(OrchestrationRetention, {
    sweep: (policy) =>
      Effect.sync(() => {
        onSweep(policy);
        return {
          watermarkSequence: 1_000,
          deletableThroughSequence: 500,
          deletedEvents: 7,
          sizeBeforeBytes: 2_000,
          sizeAfterBytes: 1_000,
          vacuumed: false,
        };
      }),
  });

it.effect("holds the first sweep until the boot delay elapses, then repeats", () =>
  Effect.gen(function* () {
    let sweeps = 0;
    const layer = stubRetention(() => {
      sweeps += 1;
    });

    yield* Layer.build(OrchestrationRetentionSweeperLive.pipe(Layer.provide(layer)));

    yield* TestClock.adjust(Duration.minutes(4));
    assert.strictEqual(sweeps, 0, "swept before the boot delay elapsed");

    yield* TestClock.adjust(Duration.minutes(1));
    assert.strictEqual(sweeps, 1);

    yield* TestClock.adjust(Duration.hours(6));
    assert.strictEqual(sweeps, 2);
  }),
);

it.effect("keeps sweeping after one sweep fails", () =>
  Effect.gen(function* () {
    let sweeps = 0;
    const layer = Layer.succeed(OrchestrationRetention, {
      sweep: () =>
        Effect.suspend(() => {
          sweeps += 1;
          return sweeps === 1
            ? Effect.fail(new PersistenceSqlError({ operation: "test.sweep" }))
            : Effect.succeed({
                watermarkSequence: 0,
                deletableThroughSequence: 0,
                deletedEvents: 0,
                sizeBeforeBytes: 0,
                sizeAfterBytes: 0,
                vacuumed: false,
              });
        }),
    });

    yield* Layer.build(OrchestrationRetentionSweeperLive.pipe(Layer.provide(layer)));

    yield* TestClock.adjust(Duration.minutes(5));
    assert.strictEqual(sweeps, 1);

    yield* TestClock.adjust(Duration.hours(6));
    assert.strictEqual(sweeps, 2);
  }),
);
